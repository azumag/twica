# ダッシュボード性能調査の引き継ぎ（2026-11-17 時点）

目的: 「ダッシュボードの操作が遅い」問題の調査結果と、次の作業者が同じ測定をやり直せる手順を残す。
これは作業記録であり、preview / main / 本番への昇格を許可するものではない。関連: #1979、#2039、#1980、PR #2072、PR #2060。

## 1. 結論（実測）

- 遅さの主因は、**一部の回線で Worker が日本以外の Cloudflare colo（SJC/SEA など）で動き、Worker→DB の往復が遅くなること**。
  - 本番 `twica`、直近 24 時間、認証済み `/dashboard`（ページ本体が実行された 112 件、サンプリングなし）。
  - 日本のクライアント 109 件のうち 24 件（22.0%）が日本以外の colo で処理され、**24 件すべてが ASN 4713**（NTT DOCOMO / OCN 系）。それ以外の ASN の 85 件は 85/85 が日本 colo（NRT/KIX）。
  - wall p50: 日本 colo 224ms（n=85）/ 日本以外 1,084ms（n=27）。DB RPC `getUserCards` p50: 70ms / 722ms。
  - クライアント→エッジの往復（`clientQuicRtt` 中央値）: 日本 colo 約 13ms / 日本以外 約 121ms。
- DB 内の実行時間は短い: PlanetScale Insights（24 時間、162 回）で `get_user_card_counts` は p50 約 6ms、p99 約 122ms。
- `getUserCards` は 1 回あたり平均約 274KB（最大約 895KB）を返す。概要ページとコレクション一覧が読むのは集計値と先頭数枚の表示項目のみ。
- 認証済み `/dashboard` の UI 操作（サイドバーのタブ切り替え）は、URL が約 22ms で変わり、データ（RSC）が届くまで 0.3〜1.4 秒（本番、1 回の Chrome 計測）。

## 2. 訂正済みの誤解（再発防止）

- i18n 翻訳データの絞り込み（PR #2060）で減らしたのは**非圧縮 HTML のバイト数だけ**。gzip 後は約 41KB 前後で、体感速度の改善は測っていない。「速くなる」と書いてはいけない。
- 当初の「`getUserCards` の 30 秒キャッシュを有効にすれば速くなる」は取り下げ。`open-next.config.ts` の `incrementalCache` / `tagCache` は既定の dummy で、`unstable_cache` は跨ぎで効いていない（事実）。ただし各訪問の初回を速くせず、`user-cards-*` を無効化する仕組みも無いため、優先度は低い。
- 「全 API が毎回約 0.5 秒待たされる」は未確定。日本 colo の `/api/maintenance-status` は 24 時間で最短 501ms・p50 534ms（1,156 件）だが、SJC 経由の 1 件ずつの突き合わせ 6 件では wall≒ブラウザ TTFB で、居残りは最大 +67ms。日本 colo で下限が出る理由は未確認（#2039 に記載）。
- コード中の「DB はソウル」は食い違いがある（§4）。

## 3. 現在の状態

- PR #2072（base `preview`、未マージ）: preview の `[env.preview.placement]` を `mode = "smart"` → `region = "aws:ap-northeast-1"`（Placement Hints）に変更。本番の top-level に `[placement]` は無く、変更しない。CI は全て pass。実経路ゲートは未実施。
- preview の Smart Placement は現在 SEA（シアトル）へ寄っている: 認証済み fetch の `/dashboard` 10 回で `remote-SEA` 6 / `local-SEA` 4、TTFB 634〜963ms（中央値約 820ms）。SEA は DB の近くではない。理由は未確認。
- 本番と preview の Hyperdrive は同じ origin ホスト（database 名のみ `prod` / `preview`）で、キャッシュは両方無効。接続上限は本番 10 / preview 5。

## 4. 未解決・要確認

1. **DB のリージョン**: PlanetScale API の branch `main` は AWS ap-northeast-1（東京）。一方、Hyperdrive origin のホスト名ラベルは `ap-northeast-2`、コード中のコメントも「ソウル」と書く箇所がある（`wrangler.toml`、`src/app/dashboard/collection/page.tsx` ほか）。PlanetScale のコンソールで実リージョンを確認してから `region` を確定する（ソウルなら `aws:ap-northeast-2`）。
2. **ASN 4713 が米国 colo に着地する理由**: ログからは確定できない。Cloudflare や回線事業者側の領域の可能性があり、アプリ側の設定では直せない可能性がある。
3. **placement の効果**: PR #2072 を preview にマージした後、§5 の測定を再実行して判定する。合否基準は PR 本文にある（`getUserCards` RPC の p50 が 150ms 前後以下など）。不合格なら revert。
4. **日本 colo の `/api/maintenance-status` の 501ms 下限**: 日本 colo の個別リクエストを 1 件ずつ突き合わせる追加測定が必要。placement を東京へ寄せると、いま米国 colo で処理されている利用者の API 待ちがこの下限に当たる可能性があるため、本番へ広げる前に preview で確認する。
5. **実引き換えのゲート**（`docs/QA.md`「Preview 実経路ゲート」）: placement はガチャ・オーバーレイ・チャットの実行場所を変えるため必須。実チャネルポイントの消費を伴うので、利用者の了承後に行う。
6. **Next.js 16.4.2 の脆弱性**: `npm audit` で GHSA-mfr8-8qww-v76h（`unstable_cache` 経由の `use cache` の情報漏えい、moderate、16.3.0〜16.4.4）。修正は 16.4.6（semver minor）。別 Issue での追跡と、アップグレード PR が未着手。
7. Devin Review の flag（PR #2060）は、PR 上にコメントが無く外部ページにしか無いため、内容を未確認。
8. 別案（未着手・要判断）: `get_user_card_counts` が返す量の削減（DB 関数の変更。migration の適用順序の規則に従い別リリース）。

## 5. 測定手順（preview / 本番で同じ方法をやり直す）

観測は読み取りのみ。状態を変える操作はしない。

1. **ブラウザ側**（認証済みの Chrome。対象のオリジンのページで実行）
   - `fetch('/dashboard?o11y=<tag>', {cache: 'no-store'})` を 10 回、`fetch('/dashboard/<tab>', {headers: {RSC: '1'}})` を cards / settings / history / stats / collection で 1 回ずつ、`/api/maintenance-status?o11y=<tag>` を 6 回。
   - 1 回ごとに tag・開始時刻（ISO）・TTFB・`cf-placement` ヘッダーを記録する。
   - ツールの実行制限（約 45 秒）を超えないよう、ループは `window` に結果を貯めて分割して回収する。
2. **Worker ログ側**（`cf` CLI。`cf auth login` が必要）
   - `npx --yes cf@1.0.0-beta.28 o11y telemetry query --view events`。invocation は `$metadata.type=cf-worker-event`、アプリログは `cf-worker`、スクリプトは `$workers.scriptName`（`twica` / `twica-preview`）、パスは `$workers.event.path`、colo は `$workers.event.request.cf.colo`、国は `cf.country`、ASN は `cf.asn`、wall は `$workers.wallTimeMs`。
   - tag は `$workers.event.request.url` に対する `regex` で絞る（`includes` は効かないことがある）。`[Perf]` ログは `$metadata.traceId` で invocation と結合する。
   - `p50` オペレーターは API が 400 を返すため使わず、生イベントを取得してローカルで集計する。`--limit` の上限は 2000。窓の全件が取れたかは最小/最大 timestamp と `count` 集計で確かめる。適応サンプリング（`abr_level`）で件数が減ることがあるので、`count` と一致することも確認する。
3. 比較は、日本 colo（NRT/KIX）と日本以外の colo、ASN 別に、wall と `[Perf] getUserCards RPC` の p50/p90 を出す。IP アドレスは集計・記録に含めない（ASN・国・colo のみ）。

## 6. 注意

- 本ドキュメントは公開リポジトリに置く。IP アドレス、個人名、認証情報は書かない。
- Worker の実行バージョンは `2752b654-4b11-47e7-a79d-bab8061fea63`（2026-11-15 16:05Z 初出、24 時間の全件）。コミットとの照合は未実施。
