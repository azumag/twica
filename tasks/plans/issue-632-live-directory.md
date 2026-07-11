# Issue #632 設計: 配信中ページ（Live Directory）の追加

親Issue: https://github.com/azumag/twica/issues/632

## 要求（原文の分解）

1. 配信者が個別に「配信中を公表」ステータスにした時**のみ**、twicaを設定して配信している人の一覧が見られる
2. カード枚数や引き換えられた数（ランキング）など、**配信者がオンにすることを前提に**、表示・ソートできる

→ 2つの独立したオプトイン（掲載可否 / 統計公開可否）を配信者ごとに持つ。デフォルトは両方OFF（プライバシー保護のためオプトイン方式。業界標準：公開ディレクトリ掲載は明示的同意が原則）。

## 業界標準調査サマリ

- **ライブ状態の検知**: Twitch公式の推奨は EventSub `stream.online`/`stream.offline`（push型）だが、「今ライブ中の一覧」を出すディレクトリ用途では Helix `GET /streams`（`user_id` を最大100件バッチ指定）を短TTLキャッシュ付きでポーリングするのが定番。push型は購読ライフサイクル管理（作成/解除/revocation対応/欠落時の突き合わせ）が必要で、ディレクトリ1ページのためには過剰（YAGNI）。
  - **採用: Helix Get Streams + `unstable_cache`(revalidate 60s)**。オプトイン配信者数は当面小規模で、60秒に最大1回・100人ごと1リクエスト。Helixのapp tokenレート制限（800pt/分）に対して余裕が大きい。
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
        └─ getLiveDirectory()  ← unstable_cache(revalidate: 60)
             ├─ DB: オプトイン配信者一覧 + 公開統計（1クエリ/RPC）
             └─ Helix GET /streams?user_id=...（100件バッチ、app access token）
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

- RPCは `SECURITY DEFINER` + `search_path` 固定（既存 `00073` の流儀に従う）。`publish_live_status = TRUE AND is_active = TRUE` でサーバ側フィルタ（クライアントに非公開者を渡さない）。
- `card_count` = `COUNT(cards WHERE is_active)`、`redemption_count` = `SUM(channel_point_usage_stats.redemption_count)`（既存トリガー維持のロールアップを利用。`gacha_history` のフルスキャンをしない）。
- `publish_stats = FALSE` の配信者は統計列を `NULL` で返し、フロントは「非公開」表示・ソート時は末尾。
- スキーマ反映: `src/lib/db/schema.ts` / `src/types/database.ts`。
- 既存の「カラム未反映デプロイ窓」フォールバックパターン（settings routeの5段fallback）に従い、settings APIは新カラム欠落時も他の設定更新を壊さない。

## API/データ取得設計

### 設定更新（既存routeの拡張）
- `src/app/api/streamer/settings/route.ts` に `publishLiveStatus` / `publishStats`（boolean検証）を追加。PostgREST/pg直結の両パスに追加（既存 `show_unowned_cards` のパターン踏襲）。CSRF/rate limit/所有権チェックは既存フローに乗る。

### ライブ一覧取得（新規lib、公開APIルートは作らない）
- `src/lib/live-directory.ts`（新規）
  - `getLiveDirectory(): Promise<LiveDirectoryEntry[]>` を `unstable_cache(..., { revalidate: 60, tags: ['live-directory'] })` でラップ。
  - 手順: RPCでオプトイン配信者取得 → `twitch_user_id` を100件ずつ `GET https://api.twitch.tv/helix/streams` → ライブ中のみ合成して返す。
  - app access token は eventsub subscribe route の client_credentials 取得ロジックを `src/lib/twitch/` へ抽出して共用（重複実装しない）。
  - Helix障害時はエラーを投げず空配列＋ログ（公開ページを500にしない）。オプトイン0件ならHelixを呼ばない。
- ページはserver componentから直接この関数を呼ぶ。**公開JSON APIは追加しない**（攻撃面・rate limit管理を増やさない。必要になったら別Issue）。

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
- キャッシュ: ページ自体は `revalidate = 60`（`unstable_cache` と揃える）。middlewareのno-cache対象（`/`, `/dashboard`）には含めない。

## UI/UX設計（子Issueで詳細化するが方針をここで確定）

- **レイアウト**: レスポンシブなカードグリッド（mobile 1列 / sm 2列 / lg 3列）。既存ダーク基調（`bg-gray-800`/`rounded-xl` 等）に統一。
- **配信者カード**: サムネイル（16:9, `thumbnail_url` 320x180、`LIVE` バッジ＋視聴者数オーバーレイ）、プロフィール画像＋表示名、配信タイトル（2行clamp）、カテゴリ名、配信経過時間、統計チップ（カード種類数 / 引き換え数。非公開なら非表示 or「統計非公開」）。
- **リンク**: カード全体 → Twitchチャンネル（`https://twitch.tv/{login}`、外部リンクは `rel="noopener noreferrer"`）。副リンクで `/collection/[streamerId]`（ログイン誘導される点は許容）。
- **ソートUI**: セレクト or セグメントボタン。`視聴者数（デフォルト）/ 配信開始が新しい順 / カード種類数 / 引き換え数`。統計系ソートでは `stats=null` を末尾。
- **状態**: 空状態（誰もライブ中でない/オプトイン0件）は専用イラストなしのシンプルなメッセージ＋「あなたも掲載しませんか」導線（設定ページへ、ログイン時のみ）。エラー時は空状態と同一表示。
- **設定側UX**: `LiveDirectorySettings.tsx`（`CardVisibilitySettings.tsx` 踏襲のトグル2つ）。掲載トグルOFF時は統計トグルをdisabled。説明文で「公開される情報の範囲」を明示（プライバシー上の透明性）。
- **a11y**: ソートは `<select>` ベース（キーボード操作可）、サムネイルに `alt`、`LIVE` バッジはテキストを含める（色のみに依存しない）。
- i18n: `livePage` / `liveDirectorySettings` namespace を `messages/ja.json` / `en.json` に追加。

## セキュリティ / プライバシー

- オプトインのサーバサイド強制: 非オプトイン配信者の情報はRPCの段階で返さない（フロント側フィルタ禁止）。
- 公開するのは集計値のみ。視聴者個人（user_twitch_id等）は一切出さない。
- 認証不要ページだが状態変更を持たないため CSRF 不要。設定変更は既存 settings route の CSRF/rate limit に乗る。
- Helix token はサーバ側のみで使用（クライアントへ渡さない）。
- キャッシュ60秒により、匿名アクセスの連打がHelix/DBへ増幅されない（DoS増幅防止）。

## コスト

- Helix: 最大 1req/60s × ceil(オプトイン数/100)。app token枠内で無視できる規模。
- DB: RPC1回/60s（キャッシュ）。ロールアップテーブル利用でフルスキャンなし。
- 新規インフラ（worker/cron/EventSub購読）: なし。

## 子Issue分割と依存関係

```text
#A UI/UXデザイン設計（/live ページ + 設定トグルのUX仕様）
     │
     ▼
#B DB/設定オプトイン（migration 00074 + settings API + LiveDirectorySettings トグル）
#C データ取得基盤（RPC + Helix Get Streams + unstable_cache + token共用化）
     │  （B/C は並行可能。C の RPC は B の migration に含めるため B が先行 or 同PR）
     ▼
#D /live ページ実装（server component + LiveDirectory client + ソート + ナビ導線 + i18n）
```

推奨実装順: A → B → C → D（BとCは密結合部分＝migrationを共有するため、Bにmigration一式を寄せ、CはB完了後に着手）。

## テスト方針（各子Issueに分配）

- B: settings routeの新フラグ受理/検証/欠落カラムfallbackテスト（`tests/unit/api/`）、トグルcomponentテスト（`tests/unit/components/`、`chat-announcement-settings.test.tsx` 踏襲）
- C: RPC結果整形・Helixバッチ分割（101人→2リクエスト）・Helix障害時の空配列fallback・`publish_stats=false` のNULLマスクのユニットテスト（Helixはfetchモック）
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
