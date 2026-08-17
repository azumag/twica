# EventSub サブスクリプション健全性監視 (Issue #540)

## 背景

本番障害 #527 で、EventSub サブスクリプションが `disabled` 相当の終端状態
（`webhook_callback_verification_failed` / `notification_failures_exceeded` 等）
に落ちても、検知手段が「Twitch Developer Console を手動確認する」という
運用依存の手順しかなかった。Twitch は webhook
コールバック検証やnotification配信に連続失敗すると自動でサブスクリプションを
終端状態へ落とすため、気づかれないまま該当streamerの視聴者はガチャ交換ボタンを
押してもチャンネルポイントだけ消費されカードが付与されない、という無音の失敗が
起き続ける。

## 仕組み

1. `workers/error-reporter`（既存の twica-error-reporter Cron Worker、5分毎）が
   prod/preview それぞれの `GET /api/admin/eventsub-health` を呼ぶ
   （`processEventSubSubscriptionHealth`、`src/index.ts`）。
2. `src/app/api/admin/eventsub-health/route.ts` が Twitch Helix
   `GET /helix/eventsub/subscriptions` を app access token で全ページ取得し、
   `enabled` / `webhook_callback_verification_pending`（作成直後の一過性状態）
   以外の status を unhealthy と判定する。ただし `authorization_revoked` /
   `user_removed` は対象外（`src/app/api/twitch/eventsub/route.ts` の
   revocation webhook ハンドラが Issue #285 の方針で「ユーザー起因の期待
   される挙動であり bug ではない」として扱っているのと同じ基準。配信者が
   自分の意思でapp連携を解除しただけの状態を、インフラ障害と同様に
   繰り返しアラートしない）。
3. unhealthy が1件以上あれば `reportError()` を呼ぶ。このリポジトリは #235 で
   Sentry SDK を削除済みで、`reportError` が
   console出力 + PlanetScale `errors` テーブルへの永続化を担う後継実装になって
   いる（`src/lib/sentry/error-handler.ts`）。ただし無条件には呼ばない —
   KV（`RATE_LIMIT_KV` を disjoint な key prefix で共用）にアラート済みの
   unhealthy subscription ID集合と時刻を記録し、(a) 同じ集合のままクール
   ダウン期間（1時間）内ならスキップ、(b) 集合が変化(悪化/一部回復)すれば
   クールダウン中でも即座に再アラート、(c) クールダウンを過ぎれば同じ集合
   でも生存確認として再アラート、という頻度制御を行う（詳細は
   `src/app/api/admin/eventsub-health/route.ts` の `shouldSendUnhealthyAlert`
   参照）。これが無いと、5分毎のCronの度に無条件でreportErrorしてしまい、
   次項のGitHub Issueへ最大12コメント/時のスパムが発生する。
4. `errors` テーブルに積まれた行は、同じ Cron Worker の既存処理
   （`processErrors`）が5分毎に読み出し、GitHub Issue を自動作成・再発時は
   既存 Issue へコメント追記する（`bug` / `auto-generated` ラベル）。

つまり本機能は新しいアラート経路を作らず、既存の「アプリ内エラー →
errors テーブル → 自動 GitHub Issue化」パイプラインにそのまま乗る設計。

## アラートが来たら何をするか

作成される GitHub Issue のタイトルは `[EventSub Health][production]` または
`[EventSub Health][preview]` で始まる固定文字列（重複 Issue を防ぐため、
count 等の可変値は含めない。environment ごとに文字列を分けている理由は
`src/app/api/admin/eventsub-health/route.ts` の `buildUnhealthyAlertMessage`
冒頭コメント参照 — prod/preview を同じメッセージにすると同一 Issue に混在し、
どちらの環境の障害か本文から判別できなくなるため）。本文の「### Context」節
には `reportError()` の第2引数（`errors.context` 列にも残る）が JSON でそのまま
出力されるため、影響を受けている `broadcasterUserId` / `rewardId` / `type` /
`status` を Issue 本文から直接確認できる（最大2000文字。件数が多い場合は
切り詰められるため、詳細は Cloudflare Workers Observability / `wrangler tail`
のログも合わせて確認する）。

**既知の制限（closeする前に必ず確認）**: 対応が終わった Issue を close すると、
同じ environment で将来まったく別のサブスクリプションが unhealthy になった
場合でも、error-reporter の重複防止ロジックが close 済みの本 Issue を
見つけてコメントを追記するだけで再オープンしない（signature が
environment 単位で完全固定のため）。**このアラートの Issue は close せず
open のまま放置してよい**。上記のクールダウンにより、障害が続いている間も
コメントは最大1時間に1回（+ 状態が悪化した場合の即時分）に抑えられており、
放置しても際限なく積み上がることはない。恒久対策（closeしても正しく
再アラートできるようにする）は #1010 で検討中。

### 手動での再登録手順

自動再登録（disabled サブスクリプションの自動削除・再作成）は挙動リスクが
高いため意図的に実装していない（#540 実装プランどおり、YAGNI）。復旧は以下の
いずれかの手順で行う。

**A. 該当 streamer に依頼する（推奨・最も安全）**

配信者ダッシュボードのチャンネルポイント設定画面
（`src/components/ChannelPointSettings.tsx`）は、現在の EventSub
サブスクリプション状態を表示し、`POST /api/twitch/eventsub/subscribe` /
`DELETE /api/twitch/eventsub/subscribe` で自分の報酬のサブスクリプションを
削除・再作成できる。配信者本人にその報酬を一度無効化→再有効化してもらうのが
最も安全（本人のセッションで動くため、他streamerへの影響が原理的に無い）。

**B. 運用者が代理で対応する**

配信者が対応できない場合、運用者は配信者のセッションを使って
`DELETE /api/twitch/eventsub/debug?id=<subscriptionId>`
（`src/app/api/twitch/eventsub/debug/route.ts`、所有権を実データで検証する
ため対象streamer本人のセッションが必要）でdisabledなサブスクリプションを
削除したのち、A と同じ操作（チャンネルポイント設定の再有効化）を配信者に
依頼して新規サブスクリプションを作らせる。

## 設定が必要な secrets

- アプリ本体（twica / twica-preview）: `EVENTSUB_HEALTH_SECRET`
  （`wrangler secret put EVENTSUB_HEALTH_SECRET` / `--env preview`）。
  未設定の場合、GET /api/admin/eventsub-health は fail-closed で 500 を返す。
- `workers/error-reporter`: `EVENTSUB_HEALTH_SECRET_PROD` /
  `EVENTSUB_HEALTH_SECRET_PREVIEW`（アプリ本体側と同じ値。
  詳細は `workers/error-reporter/wrangler.toml` のコメント参照）。
  未設定の場合、該当ターゲットへのヘルスチェックのみを安全にスキップする
  （他方のターゲットや既存の errors/inquiries/backlog監視には影響しない）。

## スコープ外（将来の拡張候補）

- disabled サブスクリプションの自動削除・再作成（理想要件、別issueで段階導入）
- デプロイ後スモークテストへの組み込み
- その他のノンブロッキング改善事項（closeされたIssueの永久ミュート問題を含む）は #1010 に集約
