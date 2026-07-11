# Issue #632 設計: 配信中ページ（Live Directory）の追加

親Issue: https://github.com/azumag/twica/issues/632

## 要求（原文の分解）

1. 配信者が個別に「配信中を公表」ステータスにした時**のみ**、twicaを設定して配信している人の一覧が見られる
2. カード枚数や引き換えられた数（ランキング）など、**配信者がオンにすることを前提に**、表示・ソートできる

→ 2つの独立したオプトイン（掲載可否 / 統計公開可否）を配信者ごとに持つ。デフォルトは両方OFF（プライバシー保護のためオプトイン方式。業界標準：公開ディレクトリ掲載は明示的同意が原則）。

## 業界標準調査サマリ

- **ライブ状態の検知**: Twitch公式の推奨は EventSub `stream.online`/`stream.offline`（push型）だが、「今ライブ中の一覧」を出すディレクトリ用途では Helix `GET /streams`（`user_id` を最大100件バッチ指定）を短TTLキャッシュ付きでポーリングするのが定番。push型は購読ライフサイクル管理（作成/解除/revocation対応/欠落時の突き合わせ）が必要で、ディレクトリ1ページのためには過剰（YAGNI）。
  - **採用: Helix Get Streams + Cloudflare KVキャッシュ(TTL 60s)**。オプトイン配信者数は当面小規模で、60秒に最大1回・100人ごと1リクエスト。Helixのapp tokenレート制限（800pt/分）に対して余裕が大きい。
  - **注意（レビュー指摘C1/C2）**: 本リポジトリの本番構成（`@opennextjs/cloudflare`）では `open-next.config.ts` が `incrementalCache`/`tagCache` を override しておらず **`dummy`（no-op）**（`tests/unit/open-next-config.test.ts` が現状を固定）。したがって `unstable_cache` もページの `export const revalidate` も**本番では機能しない**（さらに i18n の `src/i18n/request.ts` が `cookies()`/`headers()` を使うため全ページ動的レンダリング）。キャッシュは **KVによる自前実装**とする（下記）。
  - 副次効果: Get Streams は `title` / `game_name` / `viewer_count` / `thumbnail_url` / `started_at` を返すため、EventSubでは得られない表示情報が追加コストなしで手に入る。
  - 将来リアルタイム性が必要になったら EventSub 化を別Issueで検討（本設計の拡張ポイントに記載）。
- **公開ディレクトリのプライバシー**: 掲載はオプトイン、統計公開は別トグル、集計値のみ公開（視聴者個人を特定できる情報は出さない）。

## 全体アーキテクチャ

```text
[配信者] dashboard/settings
   └─ LiveDirectorySettings（新規トグル×2）
        └─ POST /api/streamer/settings
             └─ streamers.publish_live_status / publish_stats（新カラム）

[訪問者] GET /live（公開・認証不要）
   └─ server component
        └─ getLiveDirectory()  ← KVキャッシュ（key: live-directory:v1, TTL 60s）
             ├─ [cache miss時] DB: オプトイン配信者一覧 + 公開統計（1 RPC）
             └─ [cache miss時] Helix GET /streams?user_id=...（100件バッチ、app access token）
   └─ <LiveDirectory> client component（ソートUIのみクライアント側）
```

- ライブ状態はDBに保存しない（キャッシュのみ）。カラム追加はオプトインフラグ2つだけ。
- ソートは取得済みリストのクライアントサイドソート（対象は「現在ライブ中のオプトイン配信者」なので件数は小さい。サーバ側ソート/ページネーションはYAGNI）。

## DB設計（migration `00074_add_live_directory_settings.sql`）

```sql
ALTER TABLE streamers
  ADD COLUMN IF NOT EXISTS publish_live_status BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS publish_stats BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN streamers.publish_live_status IS '配信中ディレクトリ(/live)への掲載オプトイン (issue #632)';
COMMENT ON COLUMN streamers.publish_stats IS '/liveでのカード統計公開オプトイン (issue #632)';

-- 公開ディレクトリ用read RPC: オプトイン配信者と公開可能な集計のみを返す
CREATE OR REPLACE FUNCTION get_live_directory_streamers()
RETURNS TABLE (
  streamer_id UUID,
  twitch_user_id TEXT,
  twitch_username TEXT,
  twitch_display_name TEXT,
  twitch_profile_image_url TEXT,
  publish_stats BOOLEAN,
  card_count BIGINT,          -- publish_stats=false なら NULL
  redemption_count BIGINT     -- 同上
) ...
```

- RPCは `SECURITY DEFINER` + `search_path` 固定 + **`REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO service_role` のみ**（既存 `00073` の流儀）。呼び出しはサーバ側の `getSupabaseAdmin()`（service role）経由に限定し、anon/authenticated へは公開しない。`publish_live_status = TRUE AND is_active = TRUE` でサーバ側フィルタ（クライアントに非公開者を渡さない）。
- `card_count` = `COUNT(cards WHERE is_active)`、`redemption_count` = `SUM(channel_point_usage_stats.redemption_count)`（既存トリガー維持のロールアップを利用。`gacha_history` のフルスキャンをしない）。
- `publish_stats = FALSE` の配信者は統計列を `NULL` で返し、フロントは「非公開」表示・ソート時は末尾。
- `redemption_count` は `channel_point_usage_stats` の定義上「**チャネルポイント引換数**」（`reward_cost > 0` の行のみ。レイド/無償ドローは含まない）。UI文言・i18nもこのセマンティクスで正確に表記する（「引き換えられた数」と誇張しない）。
- スキーマ反映: `src/lib/db/schema.ts` / `src/types/database.ts`。
- 既存の「カラム未反映デプロイ窓」フォールバックパターン（settings routeの5段fallback）に従うが、新カラム2つは同一migrationで入るため「両方同時に欠落」しかあり得ない。**2キーをまとめて剥がす1段のみ追加**する（機械的に2段追加しない）。PostgREST/pg直結の両実装に同じ1段を追加。

## API/データ取得設計

### 設定更新（既存routeの拡張）
- `src/app/api/streamer/settings/route.ts` に `publishLiveStatus` / `publishStats`（boolean検証）を追加。PostgREST/pg直結の両パスに追加（既存 `show_unowned_cards` のパターン踏襲）。CSRF/rate limit/所有権チェックは既存フローに乗る。

### ライブ一覧取得（新規lib、公開APIルートは作らない）
- `src/lib/live-directory.ts`（新規）
  - `getLiveDirectory(): Promise<LiveDirectoryEntry[]>`。**キャッシュはCloudflare KVで自前実装**（`unstable_cache`/ISRは本番no-opのため使わない）:
    - 既存バインディング `RATE_LIMIT_KV`（wrangler.toml で prod/preview 両方に定義済み）を `getCloudflareContext({ async: true })`（`src/lib/r2-client.ts` と同パターン）で取得し、キー `live-directory:v1` に JSON を `expirationTtl: 60` で保存。専用namespaceの新設はYAGNI（キーprefixで分離。将来必要なら移行）。
    - cache hit → KVの値をそのまま返す。miss → RPC + Helix を実行して書き戻し。
    - KV未使用環境（ローカル `next dev` 等）はプロセス内メモ化（timestamp付きモジュール変数）にフォールバック。
    - TTL切れ瞬間のスタンピードは、同時computeがHelix/DBの単発呼び出し数件で頭打ちのため許容（分散ロックはYAGNI）。
  - 手順: RPCでオプトイン配信者取得 → `twitch_user_id` を100件ずつ `GET https://api.twitch.tv/helix/streams` → ライブ中のみ合成して返す。
  - **app access token 共通化**: client_credentials 実装は現在3箇所に重複している（`eventsub/subscribe/route.ts` / `eventsub/debug/route.ts` / `channel-point-bootstrap/route.ts`）。`src/lib/twitch/app-token.ts` へ抽出し**3箇所すべてを置き換える**。抽出ヘルパーは `expires_in` を尊重した有効期限付きキャッシュ（KV: キー `twitch:app-token`、TTL = expires_in の8割程度）を持ち、毎回の新規発行をやめる。トークンはサーバ側KVのみに保存しクライアントへ渡さない。
  - RPC呼び出しは `getSupabaseAdmin().rpc()`。**pg直結パリティ**（`DB_DRIVER=pg`）は現行規約（dashboard-data.ts の `.rpc()` パリティ実装、#718参照）に従い**最初から両経路実装**し、driver-parityテストを追加する（この経路だけPostgREST依存を残すと #718 と同種の残存になるため）。
  - Helix障害時はエラーを投げず空配列＋`reportError`（`src/lib/sentry/error-handler.ts`）で通知（公開ページを500にしない。障害が「誰も配信していない」と区別できるようSentryで観測する）。オプトイン0件ならHelixを呼ばない。
- ページはserver componentから直接この関数を呼ぶ。**公開JSON APIは追加しない**（攻撃面・rate limit管理を増やさない。必要になったら別Issue）。
- `/live` はページルートのため middleware のグローバルAPIレート制限（`/api/*` のみ）の対象外だが、KVキャッシュにより1リクエストあたりの原価は「KV read 1回」まで下がるため、追加のページレート制限は設けない（KV書き込み側はTTL内1回）。

### 型
```ts
interface LiveDirectoryEntry {
  streamerId: string;
  twitchUserId: string;
  twitchLogin: string;        // チャンネルリンク用
  displayName: string;
  profileImageUrl: string;
  // Helix由来
  title: string;
  gameName: string;
  viewerCount: number;
  startedAt: string;          // ISO
  thumbnailUrl: string;       // テンプレート {width}x{height} 置換
  // 統計（publish_stats=false なら null）
  stats: { cardCount: number; redemptionCount: number } | null;
}
```

## ページ設計（`/live`）

- `src/app/live/page.tsx`: server component。`getSession()` を呼ばない（完全公開）。`getTranslations('livePage')`。`getLiveDirectory()` の結果を `<LiveDirectory entries={...}>` に渡す。
- `src/components/LiveDirectory.tsx`: client component。ソート状態のみ保持。
- ナビ導線: `Header.tsx` / `TopPageHeader.tsx` に「配信中」リンク追加。トップページからの導線も追加。
- メタデータ: `generateMetadata` でタイトル/description（ja/en）。ライブ一覧はSEO的にも公開ページとして自然。
- キャッシュ: ページの `export const revalidate` は**使わない**（i18nの `cookies()` 使用で全ページ動的レンダリングになる既存構成のため無意味。リポジトリ内に使用実績もない）。鮮度制御はデータ層のKVキャッシュ(60s)に一元化する。middlewareのno-cache対象（`/`, `/dashboard`）には含めない。

## UI/UX設計（子Issueで詳細化するが方針をここで確定）

- **レイアウト**: レスポンシブなカードグリッド（mobile 1列 / sm 2列 / lg 3列）。既存ダーク基調（`bg-gray-800`/`rounded-xl` 等）に統一。
- **配信者カード**: サムネイル（16:9, `thumbnail_url` 320x180、`LIVE` バッジ＋視聴者数オーバーレイ）、プロフィール画像＋表示名、配信タイトル（2行clamp）、カテゴリ名、配信経過時間、統計チップ（カード種類数 / 引き換え数。非公開なら非表示 or「統計非公開」）。
- **リンク**: カード全体 → Twitchチャンネル（`https://twitch.tv/{login}`、外部リンクは `rel="noopener noreferrer"`）。副リンクで `/collection/[streamerId]`（ログイン誘導される点は許容）。
- **ソートUI**: セレクト or セグメントボタン。`視聴者数（デフォルト）/ 配信開始が新しい順 / カード種類数 / チャネルポイント引換数`。統計系ソートでは `stats=null` を末尾。
- **状態**: 空状態（誰もライブ中でない/オプトイン0件）は専用イラストなしのシンプルなメッセージ＋「配信者の方はこちらから掲載できます」導線を**常時表示**（設定ページへリンク。未ログインなら既存の認証フローへ自然に誘導される。ページ側で `getSession()` は呼ばない方針と整合させる）。エラー時は空状態と同一表示（＋Sentry通知）。
- **設定側UX**: `LiveDirectorySettings.tsx`（`CardVisibilitySettings.tsx` 踏襲のトグル2つ）。掲載トグルOFF時は統計トグルをdisabled。説明文で「公開される情報の範囲」を明示（プライバシー上の透明性）。
- **a11y**: ソートは `<select>` ベース（キーボード操作可）、サムネイルに `alt`、`LIVE` バッジはテキストを含める（色のみに依存しない）。
- i18n: `livePage` / `liveDirectorySettings` namespace を `messages/ja.json` / `en.json` に追加。

## セキュリティ / プライバシー

- オプトインのサーバサイド強制: 非オプトイン配信者の情報はRPCの段階で返さない（フロント側フィルタ禁止）。
- 公開するのは集計値のみ。視聴者個人（user_twitch_id等）は一切出さない。
- 認証不要ページだが状態変更を持たないため CSRF 不要。設定変更は既存 settings route の CSRF/rate limit に乗る。
- Helix token はサーバ側のみで使用・KV保存（クライアントへ渡さない）。
- KVキャッシュ60秒により、匿名アクセスの連打がHelix/DBへ増幅されない（DoS増幅防止）。※`unstable_cache`ではこの保証が成立しない（本番no-op）ことがレビューで判明したため、KV自前キャッシュを採用している。この前提を壊す変更（KVキャッシュの削除等）をしてはならない。

## コスト

- Helix: 最大 1req/60s × ceil(オプトイン数/100) + token発行はexpires_in内で再利用。app token枠内で無視できる規模。
- DB: RPC 1回/60s（KVキャッシュmiss時のみ）。ロールアップテーブル利用でフルスキャンなし。
- KV: read 1回/ページビュー + write 1回/60s。既存 `RATE_LIMIT_KV` を利用し新規namespaceなし。
- 新規インフラ（worker/cron/EventSub購読/KV namespace）: なし。

## 子Issue分割と依存関係

```text
#A UI/UXデザイン設計          #B DB/設定オプトイン
   （/live + 設定トグルの        （migration 00074 一式
     UX仕様。Bと並行可）          = カラム + RPC + settings API
     │                            + LiveDirectorySettings トグル）
     │                               │
     │                               ▼
     │                        #C データ取得基盤
     │                           （app-token共通化 + Helix
     │                             + KVキャッシュ + pgパリティ）
     │                               │
     └───────────┬───────────────────┘
                 ▼
#D /live ページ実装（server component + LiveDirectory client + ソート + ナビ導線 + i18n）
```

- **AとBは独立・並行可能**（Cは技術基盤なのでAに依存しない。Dのみが両方に依存）。
- RPC（`get_live_directory_streamers`）のシグネチャは本設計で確定済みのため、**migration一式（カラム+RPC）はBに寄せる**。CはBのmigrationがpreviewへ適用され次第着手。
- 推奨実装順: (A ∥ B) → C → D。

## テスト方針（各子Issueに分配）

- B: settings routeの新フラグ受理/検証/欠落カラムfallback（追加1段）テスト（`tests/unit/api/`）、トグルcomponentテスト（`tests/unit/components/`、`chat-announcement-settings.test.tsx` 踏襲）
- C: RPC結果整形・Helixバッチ分割（101人→2リクエスト）・Helix障害時の空配列fallback＋`reportError`呼び出し・`publish_stats=false` のNULLマスク・KVキャッシュhit/miss/ローカルフォールバック・app-tokenキャッシュ再利用のユニットテスト（Helix/KVはモック）。RPCのdriver-parityテスト（`tests/unit/*driver-parity*` 踏襲）。app-token共通化による既存3ルートのregressionテスト
- D: ソート順（stats null末尾含む）・空状態のcomponentテスト。`/live` が `getSession` を呼ばないことの構造テスト
- 既存機能（ガチャ/設定/overlay）のregressionは既存テストで担保。migrationは `check:migration-order` を通す

## 受け入れ条件（親Issue完了条件）

- [ ] 配信者がダッシュボードから「配信中を公表」「統計を公開」を個別にON/OFFできる（デフォルトOFF）
- [ ] `/live` で、オプトイン済みかつ現在Twitchでライブ中の配信者だけが一覧表示される
- [ ] 統計公開ONの配信者のみカード種類数・引き換え数が表示され、それらでソートできる
- [ ] 非オプトイン配信者の情報がレスポンスに一切含まれない
- [ ] 未ログインでも閲覧できる
- [ ] ja/en 両対応

## Non-goals（明示的スコープ外）

- EventSub `stream.online/offline` によるリアルタイム更新（拡張ポイント: `getLiveDirectory()` の実装差し替えで対応可能な構造にする）
- 視聴者個人ランキングの公開
- ページネーション/検索/フォロー機能
- `/collection` の公開化（別Issue相当）
