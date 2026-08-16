# EventSub サブスクリプション健全性監視 (Issue #540)

## 背景

本番障害 #527 で、EventSub サブスクリプションが `disabled` 相当の終端状態
（`webhook_callback_verification_failed` / `notification_failures_exceeded` /
`authorization_revoked` 等）に落ちても、検知手段が「Twitch Developer Console
を手動確認する」という運用依存の手順しかなかった。Twitch は webhook
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
   以外の status を unhealthy と判定する。
3. unhealthy が1件以上あれば `reportError()` を呼ぶ。このリポジトリは #235 で
   Sentry SDK を削除済みで、`reportError` が
   console出力 + PlanetScale `errors` テーブルへの永続化を担う後継実装になって
   いる（`src/lib/sentry/error-handler.ts`）。
4. `errors` テーブルに積まれた行は、同じ Cron Worker の既存処理
   （`processErrors`）が5分毎に読み出し、GitHub Issue を自動作成・再発時は
   既存 Issue へコメント追記する（`bug` / `auto-generated` ラベル）。

つまり本機能は新しいアラート経路を作らず、既存の「アプリ内エラー →
errors テーブル → 自動 GitHub Issue化」パイプラインにそのまま乗る設計。

## アラートが来たら何をするか

作成される GitHub Issue の本文（`errors.context` 由来、Issue本文には出力
されないが Cloudflare Workers Observability / `wrangler tail` のログには
`[eventsub-health] Unhealthy EventSub subscription(s) detected` として要約が
残る）には、影響を受けている `broadcasterUserId` / `rewardId` / `type` /
`status` が含まれる。

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
