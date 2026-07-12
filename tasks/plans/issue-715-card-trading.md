# カードトレード機能 設計ドキュメント (Issue #715)

親Issue: https://github.com/azumag/twica/issues/715

## 1. 要求(親Issueより)

- 自分が欲しいカードと引き換えカード(手放すカード)を提示できる
- 引き換えカードと欲しいカードの組の一覧を表示できる
- 一覧から自分の好みの取引を選んで、引き換え(成立)できる
- チャンネル内トレード / クロスチャンネルトレードのオン・オフを配信者ごとに設定できる

## 2. 方式の決定: オープンオファー(掲示板)方式

業界標準の調査結果に基づき、**オープンオファー方式**(出品者が「渡すカード⇄欲しいカード」の組を掲示し、条件を満たす任意の視聴者が応諾すると即時成立)を採用する。

- Steam コミュニティマーケット/ポケモンGTS 等で実績のある「非同期・不特定多数向け」の交換方式であり、
  「一覧から自分の好みの取引を選んで引き換える」という要求に一致する
- 1対1の交渉(直接オファー・チャット交渉)は要求に含まれないため実装しない(YAGNI)
- 1オファー = カード1枚 ⇄ カード1枚 の固定形式。複数枚交換・レート交換は実装しない(YAGNI)

## 3. 用語と交換ルール

| 用語 | 定義 |
|---|---|
| オファー(trade_offers) | 「渡すカードの特定の1枚」と「欲しいカード種別」の組。status: open/completed/cancelled |
| チャンネル内トレード | 渡すカードと欲しいカードが**同一配信者**のカード |
| クロスチャンネルトレード | 渡すカードと欲しいカードが**異なる配信者**のカード |

### 有効判定(設定ゲート)

`streamers` に2つのフラグを追加する(既存の `show_unowned_cards` 等と同じパターン):

- `trade_enabled BOOLEAN NOT NULL DEFAULT false` — その配信者のカードをトレードに使えるか(マスタースイッチ)
- `cross_channel_trade_enabled BOOLEAN NOT NULL DEFAULT false` — その配信者のカードをクロスチャンネルトレードに使えるか

判定ルール:

- チャンネル内トレード可 ⇔ 対象配信者の `trade_enabled = true`
- クロスチャンネルトレード可 ⇔ **両方の配信者**の `trade_enabled = true` かつ `cross_channel_trade_enabled = true`
- 判定は「オファー作成時」と「応諾(成立)時」の両方で行う。設定オフ後の既存openオファーは一覧から非表示になり応諾も拒否される(オファー自体は削除しない。再有効化で復活)
- ゲート判定がANDなので、`cross_channel_trade_enabled=true` かつ `trade_enabled=false` の保存はサーバ側で許容してよい(実害なし。UI側で子トグルをdisabledにするのみ)

### カードの is_active との関係

- 出品時の「欲しいカード」選択肢はアクティブカードのみ(カタログから選ぶため)
- 応諾・既存オファーの表示は、カードが後から非アクティブ化されても許可する
  (トレードは所有済みコピーの移転であり新規発行ではないため、非アクティブ化の意図「新規入手停止」と矛盾しない)

## 4. DB設計

スキーマの正はSupabaseマイグレーション(`supabase/migrations/000XX_add_card_trading.sql`)。`src/lib/db/schema.ts` にDrizzle型ミラーを追記(settings APIにはpg直結の二重パスがあるためミラー追加は必須)。

### 4.1 trade_offers テーブル

所有は row-per-copy モデル(`user_cards` 1行=1枚)なので、オファーは**特定の user_cards 行**を指す。

```sql
CREATE TABLE trade_offers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- 出品者
  offerer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 渡すカードの特定の1枚。
  -- 意図的にFKを張らない: user_cards行はカードストーン交換RPC等でDELETEされうるため、
  -- FK CASCADEにすると completed 行(=トレード履歴)が取引相手の後日の行動で消えてしまう。
  -- openオファーの整合性は部分UNIQUE(下記)+応諾時の実在チェックで担保する。
  offered_user_card_id UUID NOT NULL,
  -- 一覧表示・フィルタ用の非正規化。クライアントからは受け取らず、
  -- サーバが offered_user_card_id / wanted_card_id から導出してINSERTする。
  -- cards へのFKは ON DELETE SET NULL: 既存の DELETE /api/cards/[id] はカード定義を
  -- 無条件ハード削除するため、CASCADEにすると配信者のカード整理で completed 行(=トレード履歴)が
  -- 消えてしまう(クロスチャンネルでは相手配信者の操作で自分の履歴が消える)。
  -- 表示は下記スナップショットにフォールバックする
  offered_card_id UUID REFERENCES cards(id) ON DELETE SET NULL,
  offered_streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  -- 欲しいカード(種別指定。特定の1枚ではない)
  wanted_card_id UUID REFERENCES cards(id) ON DELETE SET NULL,
  wanted_streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  -- カード定義削除後も履歴表示できるよう、出品時に両カードの表示情報
  -- (name / rarity / image_url)をスナップショット保存する
  offered_card_snapshot JSONB NOT NULL,
  wanted_card_snapshot JSONB NOT NULL,
  -- チャンネル内/クロスの判別。生成列にして非正規化不整合を排除
  is_cross_channel BOOLEAN GENERATED ALWAYS AS (offered_streamer_id <> wanted_streamer_id) STORED,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  -- 成立情報(記録用。accepted_user_card_id もFKなし: 移転後も記録を残す)
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_user_card_id UUID,
  completed_at TIMESTAMPTZ,
  -- 冪等性キー: 作成用(request_id)と応諾用(accepted_request_id)を分離
  request_id UUID,
  accepted_request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一カード同士の交換は無意味なので禁止
  CONSTRAINT trade_offers_different_cards CHECK (offered_card_id <> wanted_card_id)
);

-- 同じ1枚を複数のopenオファーに同時出品することを防ぐ(部分UNIQUE。FKなしでも機能する)
CREATE UNIQUE INDEX idx_trade_offers_open_user_card
  ON trade_offers(offered_user_card_id) WHERE status = 'open';
-- 作成の冪等性
CREATE UNIQUE INDEX idx_trade_offers_offerer_request
  ON trade_offers(offerer_user_id, request_id) WHERE request_id IS NOT NULL;
-- 一覧クエリ用(created_at DESC ページネーションに直接使える複合部分インデックス)
CREATE INDEX idx_trade_offers_open_offered_streamer
  ON trade_offers(offered_streamer_id, created_at DESC) WHERE status = 'open';
CREATE INDEX idx_trade_offers_open_wanted_streamer
  ON trade_offers(wanted_streamer_id, created_at DESC) WHERE status = 'open';
-- 出品上限チェック・マイトレード「出品中」タブ用
CREATE INDEX idx_trade_offers_open_offerer
  ON trade_offers(offerer_user_id) WHERE status = 'open';
-- FKカスケード支持インデックス(00071 の教訓: 部分インデックスはカスケード削除の参照行検索に使えない)
CREATE INDEX idx_trade_offers_offerer_user_id ON trade_offers(offerer_user_id);
CREATE INDEX idx_trade_offers_offered_card_id ON trade_offers(offered_card_id);
CREATE INDEX idx_trade_offers_offered_streamer_id ON trade_offers(offered_streamer_id);
CREATE INDEX idx_trade_offers_wanted_card_id ON trade_offers(wanted_card_id);
CREATE INDEX idx_trade_offers_wanted_streamer_id ON trade_offers(wanted_streamer_id);
CREATE INDEX idx_trade_offers_accepted_by_user_id ON trade_offers(accepted_by_user_id);

-- updated_at 自動更新(00001 の既存トリガー関数を再利用)
CREATE TRIGGER update_trade_offers_updated_at BEFORE UPDATE ON trade_offers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

RLS: 既存パターンに厳密に従う(`00024` の教訓 — 必ず `TO service_role` を明示)。

```sql
ALTER TABLE trade_offers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_offers TO service_role;
CREATE POLICY "Service can manage trade_offers" ON trade_offers
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

注意点:

- ユーザー退会時は `offerer_user_id` のCASCADEで相手側の成立履歴も消える。これは既存の全面CASCADE方針(users削除で user_cards 等も消える)と整合する**意図的な**挙動
- 将来カードストーン交換(`exchange_duplicate_card_for_stones`、現状 `src/` から未呼び出しの休眠機能)をAPIに配線する際は、
  同RPCの交換対象選択クエリに「openオファー出品中のコピーを除外」する条件追加が必要(子issue #2 の注意事項に明記)

### 4.2 streamers への設定カラム追加

```sql
ALTER TABLE streamers
  ADD COLUMN trade_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN cross_channel_trade_enabled BOOLEAN NOT NULL DEFAULT false;
```

デフォルトOFF(オプトイン)。既存配信者の挙動を変えない。

### 4.3 トレード履歴

`trade_offers` の completed 行がそのまま履歴になる(status + accepted_* + completed_at)。
別テーブル `trade_history` は作らない(YAGNI。監査要件が出たら追加)。
このため §4.1 の通り `offered_user_card_id` / `accepted_user_card_id` にはFKを張らず、行が独立に生存するようにしている。

### 4.4 成立RPC: accept_trade_offer

成立処理は競合(同一オファーへの同時応諾、出品カードの喪失)があるため、
`exchange_duplicate_card_for_stones`(migration 00059/00060)と同じ
**SECURITY DEFINER plpgsql RPC + FOR UPDATE ロック + 冪等性キー** で実装する。

```
accept_trade_offer(
  p_twitch_user_id TEXT,   -- 応諾者(セッションから)
  p_trade_offer_id UUID,
  p_request_id UUID        -- クライアント生成の冪等性キー
) RETURNS JSONB
```

処理手順(単一トランザクション):

1. 応諾者 `users.id` を解決
2. `SELECT ... FROM trade_offers WHERE id = p_trade_offer_id FOR UPDATE` — オファー行をロック
3. **冪等リプレイ判定(すべての検証より前に行う。00060 と同じく、成立後にレスポンスをロストした
   クライアントの再送が `TRADE_ALREADY_COMPLETED` にならないようにするため)**:
   `status = 'completed' AND accepted_by_user_id = 応諾者 AND accepted_request_id = p_request_id`
   なら成立済み結果JSONBを再返却して終了。
   リプレイ判定はこのオファー行内の値照合で完結するため、`accepted_request_id` に UNIQUE制約は付けない
4. 検証(失敗時はエラーコードを含むJSONBを返す):
   - `status = 'open'` であること(二重成立防止)
   - 応諾者 ≠ 出品者(自己応諾禁止)
   - `offered_card_id IS NOT NULL AND wanted_card_id IS NOT NULL`(カード定義が削除済み(SET NULL)の
     オファーは成立不能)— NULLなら offer を `cancelled` に更新して 'OFFER_INVALID'
   - 設定ゲート再チェック: 両配信者の `trade_enabled`(クロスなら `cross_channel_trade_enabled` も)
   - 出品カード実在チェック: `SELECT ... FROM user_cards WHERE id = offered_user_card_id AND user_id = offerer_user_id FOR UPDATE`
     — 行が存在しない(削除済み)または所有者が変わっている場合は offer を `cancelled` に更新して 'OFFER_INVALID' を返す
     (このパスで cancelled 更新をコミットするために、00060 の RAISE EXCEPTION 方式ではなく
     「エラーコード入りJSONB返却」方式を採る。RPC内コメントに理由を書くこと)
   - 応諾者の支払いカード選択(**2段構成**。00059/00060 と同じパターン):
     1. `PERFORM 1 FROM user_cards WHERE user_id = 応諾者 AND card_id = wanted_card_id
        AND id NOT IN (SELECT offered_user_card_id FROM trade_offers WHERE offerer_user_id = 応諾者 AND status = 'open')
        FOR UPDATE` — 候補コピーを **LIMITなしで全ロック**
        (`ORDER BY ... LIMIT 1 ... FOR UPDATE` の単一クエリだと、ロック待ち中に対象行が条件を外れた場合に
        次点の行へ繰り上がらず、使用可能なコピーが残っているのに 'CARD_NOT_OWNED' を誤返却しうるため)
     2. ロック確定後に同条件+`ORDER BY obtained_at ASC, id ASC LIMIT 1` で最も古い1枚を選定。
        0件なら 'CARD_NOT_OWNED'
5. 所有権の移転(row-per-copy なので UPDATE で user_id を付け替える):
   - `UPDATE user_cards SET user_id = 応諾者, obtained_at = now() WHERE id = offered_user_card_id`
   - `UPDATE user_cards SET user_id = 出品者, obtained_at = now() WHERE id = 応諾者の支払いカードid`
   - ※ 新規発行ではないため `max_issuance_count`(発行上限)には影響しない
   - ※ `card_owner_stats` トリガー(00051)はOLD/NEW双方を再集計するため user_id 付け替えと整合
6. `UPDATE trade_offers SET status='completed', accepted_by_user_id=..., accepted_user_card_id=...,
   accepted_request_id=p_request_id, completed_at=now()`
7. 成立結果JSONBを返す(両カード情報を含む)

ロックとデッドロックの方針:

- ロック順は「オファー行 → 出品者の user_cards 行 → 応諾者の支払い user_cards 行」で固定
- 手順4の支払いカード選択で「自分が出品中のコピー」を除外する規則が、相互応諾の典型的な循環ロックを塞ぐ
- それでも複数の並行応諾が同一ユーザーの複数コピーに交差するケースで 40P01(deadlock_detected)は理論上残る。
  **API層で 40P01 を捕捉し、短いジッター付きで1回リトライ→失敗なら「混雑しています。再試行してください」(TRADE_BUSY)に写像する**
  (将来pg直結パスを追加する場合は postgres.js のエラー形状でも同様の捕捉が必要)
- `FOR UPDATE` は述語で除外された行をロックしない点をRPC内コメントに明記

権限: `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO service_role;` + `SECURITY DEFINER SET search_path = public, pg_temp`。

### 4.5 キャンセル

出品者本人によるキャンセルは競合が単純(open→cancelled のCAS)なので、RPCにせず
API側で `UPDATE trade_offers SET status='cancelled' WHERE id=? AND offerer_user_id=? AND status='open'` の条件付きUPDATEで実装する(更新0行なら404/409相当を返す)。

## 5. API設計

既存の規約(validateContentType → validateCSRFToken → getSession → rate limit → getSupabaseAdmin → users.id解決 → 処理 → handleApiError)に厳密に従う。ロジックは `src/lib/trade.ts` に置く。まずはPostgRESTパスのみ実装(pg-direct二重化はフラグ運用が始まってから。YAGNI)。

| Method | Path | 概要 |
|---|---|---|
| GET | `/api/trades?streamerId=&scope=in_channel\|cross_channel&wantedCardId=&offeredCardId=&page=` | openオファー一覧。設定ゲートを満たすもののみ返す。ページネーション必須(20件/頁) |
| POST | `/api/trades` | オファー作成 `{ offeredUserCardId, wantedCardId, requestId }` |
| GET | `/api/trades/mine` | 自分のオファー一覧(open/completed/cancelled、自分が応諾した取引も含む) |
| POST | `/api/trades/[id]/accept` | 応諾 `{ requestId }` → RPC呼び出し |
| POST | `/api/trades/[id]/cancel` | 出品者本人のキャンセル |
| POST | `/api/streamer/settings` | 既存エンドポイントに `tradeEnabled` / `crossChannelTradeEnabled` キーを追加(既存の厳格boolean検証パターンに従う) |

### 一覧クエリの実装方式(GET /api/trades)

- 基本クエリ: PostgREST で `trade_offers` に `status=eq.open` + streamerフィルタ + `order=created_at.desc` + range ページネーション。
  カード・配信者情報は埋め込み(`offered_card:cards!offered_card_id(...)` 等)で取得
- カード定義が削除済み(`offered_card_id` / `wanted_card_id` が NULL)のopenオファーは一覧から除外する。
  マイトレードの成立履歴表示では `*_card_snapshot` にフォールバックして「削除済みカード」として表示する
- 設定ゲートフィルタ: offered側/wanted側の2系統の `streamers!inner(...)` 埋め込みフィルタ
  (`offered_streamer.trade_enabled=eq.true` 等)で実現する。クロスタブでは両側の
  `cross_channel_trade_enabled=eq.true` も条件に加える。PostgRESTで表現困難な場合は一覧用VIEWを検討(実装時判断)
- **応諾可否(canAccept)**: ログインユーザーの支払い可能カードを別クエリ1本で取得し
  (自分の所持 `user_cards` から「自分がopenオファーに出品中の `offered_user_card_id`」を除外して card_id 集合を作る)、
  アプリ側で各オファーに `canAccept` を付与して返す。自分の出品は `isOwnOffer: true` を返して
  `canAccept` 計算から除外する(UIは「自分の出品」バッジ+キャンセルボタン表示。
  自己応諾はサーバ側でも `TRADE_SELF_ACCEPT` で禁止済み)。
  **除外規則を §4.4 手順4 と完全に一致させる**こと(「ボタン有効なのに押すと CARD_NOT_OWNED」の食い違い防止)。
  クエリは2本固定でありN+1にはならない

### オファー作成の冪等性(POST /api/trades)

- `requestId` はクライアントが `crypto.randomUUID()` で生成し、**リトライ間で同一キーを保持**する
  (このリポジトリにAPI層のrequestId前例はまだ無いため、この規約を本機能で確立する)
- 部分UNIQUE `(offerer_user_id, request_id)` の違反(23505)を捕捉した場合は、
  既存オファーを取得して **200でリプレイ返却**する(409/500にしない)

### バリデーション(POST /api/trades)

- `offered_user_card_id` が自分の所有行であること
- その行が他のopenオファーに出品中でないこと(部分UNIQUEで最終防衛、事前チェックでUX向上)
- 設定ゲート(§3)を満たすこと
- `offered_card_id <> wanted_card_id`
- 「欲しいカード」は `cards.is_active = true` のみ指定可(§3参照)
- 受け取るID(`offeredUserCardId` / `wantedCardId` / `requestId` / パスの `[id]`)はAPI層でUUID形式を
  事前検証し、不正形式は400を返す(Postgres の 22P02 に頼らない。既存の厳格boolean検証と同じ思想)
- 1ユーザーの同時openオファー上限 **10件**(スパム対策。定数 `TRADE_MAX_OPEN_OFFERS`)。
  COUNT→INSERT の並行POSTで僅かに超過しうるが、rate limitがあるため許容する
- rate limit: 既存 `rateLimits` に `tradeWrite`(10回/分)/ `tradeRead`(100回/分。`cardsGet`/`battleGet` の既存値に準拠)を追加
- **重要(独立タスク化)**: `KVRateLimitStorage` と `setRateLimitStorage()` は定義済みだが、
  現状どこからも呼ばれておらず、本番は実質 `MemoryRateLimitStorage`(インスタンスローカル)で動いている。
  本機能はrate limitをスパム・複数アカウント集約対策の防御線として明示的に当てにするため、
  **Cloudflareエントリポイントで `setRateLimitStorage(new KVRateLimitStorage(env.RATE_LIMIT_KV))` を配線する
  対応を独立子issueとし、トレード機能の一般公開前の必須条件とする**(未配線のままならリリースしない)
- 一覧APIのキャッシュ: MVPでは導入しない(検討済み。canAccept がユーザー依存でありキャッシュ効率が悪い。
  配信内告知直後の閲覧集中が実際に問題になったら、共通部分に `unstable_cache` の短TTLキャッシュを検討)

### エラーコード

`ERROR_MESSAGES` に追加: `TRADE_DISABLED` / `TRADE_OFFER_NOT_FOUND` / `TRADE_ALREADY_COMPLETED` / `TRADE_SELF_ACCEPT` / `TRADE_CARD_NOT_OWNED` / `TRADE_OFFER_LIMIT` / `TRADE_BUSY`(デッドロックリトライ失敗)など。i18nはUI側で対応表を持つ。

## 6. UI/UX設計

### 6.1 デザイン原則

- 既存のダークテーマ(`bg-gray-900/800`, `text-white`, アクセント `purple-600`)とTailwind v4規約に従う。新規コンポーネントライブラリは導入しない
- モバイルファースト(視聴者はスマホ利用が多い)。カードグリッドは既存 `SortedCardGrid` の responsive パターンを踏襲
- i18n: `messages/ja.json` / `en.json` に `trade` / `tradeSettings` 名前空間を追加

### 6.2 画面構成とナビゲーション

```
/collection/[streamerId]        既存コレクション → trade_enabled 時のみ「トレード」ボタン表示
/trade/[streamerId]             チャンネル内トレードボード(そのチャンネルのオファー一覧)
/trade/[streamerId]?scope=cross クロスチャンネルタブ(同ページ内タブ切替)
/trade/mine                     マイトレード(自分の出品・成立履歴)
```

クロスチャンネル専用のグローバルボードは作らない(導線が複雑になるため)。
各チャンネルのボードに「チャンネル内」「クロスチャンネル」の2タブを置き、
クロスタブには「そのチャンネルのカードが片側に含まれる」オファーを表示する。

### 6.3 トレードボード画面(/trade/[streamerId])

```
┌──────────────────────────────────────┐
│ ← コレクションに戻る   [チャンネル名] トレードボード │
│ [チャンネル内] [クロスチャンネル]  ← タブ           │
│ [出品する +]                [マイトレード]           │
├──────────────────────────────────────┤
│ フィルタ: 欲しいカード▼ / 出ているカード▼ / レアリティ▼ │
├──────────────────────────────────────┤
│ ┌────────────────────────────────┐   │
│ │ [出品カード画像]  ⇄  [募集カード画像]        │   │
│ │  カード名(レアリティ)   カード名(レアリティ)  │   │
│ │  出品者: displayName ・ 3時間前              │   │
│ │            [この取引に応じる] / [所持していません] │   │
│ └────────────────────────────────┘   │
│ ...(20件ごとにページネーション)                    │
└──────────────────────────────────────┘
```

- オファー行は「もらえるカード(左)⇄ 渡すカード(右)」を**応諾者視点**で表示する
  (出品者視点だと左右が逆になり混乱するため、ボード閲覧者=応諾候補者の視点で統一)
- 応諾ボタンは4状態(APIは `canAccept: 'yes' | 'not_owned' | 'all_listed'` を返し、未ログイン時は省略):
  1. 支払い可能な形で所持 → 有効(purple)「この取引に応じる」
  2. 未所持 → 無効(gray)+「所持していません」
  3. 所持しているが全コピーが自分の出品中 → 無効(gray)+「交換可能な手持ちがありません(出品中)」
     (「所持していません」と混同させない。誤情報はサポート問い合わせの原因になる)
  4. 未ログイン → 有効(purple)「ログインして応じる」→ 既存 `returnTo` パターンでログインへ。
     ※ 一覧閲覧自体は未ログインでも可(既存ページは全面リダイレクト方式のため、
     「閲覧可+アクションのみログイン誘導」は本機能で確立する新パターンであることを実装時に意識する)
- 応諾ボタン付近に注記を常設: 「※複数所持時は最も古い1枚が自動選択されます」
  (取消不可の操作なので、確認モーダルより前の段階で事前告知する)
- 一覧行はモバイル(375px幅程度)ではカード画像2枚を縦積み(もらう→渡す)に折り返す。
  デスクトップ(sm以上)で横並び。既存 `SortedCardGrid` のレスポンシブ切替パターンに準じる
- クロスチャンネルタブでは各カードに配信者アイコン+名前を小さく併記(どのチャンネルのカードか一目で分かるように)
- エラー表示の共通方針: 応諾・出品モーダル内のエラーはモーダル内インライン表示、
  一覧取得エラーは一覧上部のインラインバナー。既存の `setMessage`/`isError` インライン方式に従い、
  新規トーストコンポーネントは導入しない(YAGNI)

### 6.4 応諾確認モーダル

誤操作防止のため確認モーダルを必須にする(取引は即時成立・取消不可のため):

```
┌───────────────────────────┐
│  この取引を成立させますか?              │
│  [渡すカード画像]   →   [もらうカード画像] │
│   渡す: ○○ (R)        もらう: △△ (SR)   │
│  ⚠ 渡すカードはあなたの最も古い1枚が      │
│     選ばれます。取引は取り消せません。     │
│        [キャンセル] [交換する]           │
└───────────────────────────┘
```

- 成立後: モーダル内で成功表示+獲得カードのアップ表示(既存ガチャ演出コンポーネントは流用せず簡素に。YAGNI)
- 失敗時はエラーコードごとに分かりやすい文言をモーダル内に表示:
  - `TRADE_ALREADY_COMPLETED` / `OFFER_INVALID`: 「この取引は成立済み(または無効)です」→ 閉じたら一覧refetch
  - `TRADE_BUSY`: 「混雑しています。しばらくしてから再試行してください」
  - `TRADE_CARD_NOT_OWNED`: 「交換に出せるカードがありません」
  - `TRADE_SELF_ACCEPT`: 「自分の出品には応じられません」(通常UIからは到達しないが文言は定義しておく)
- モーダルのアクセシビリティ: 既存モーダルコンポーネントのfocus管理パターンを踏襲し、
  focus trap + `aria-modal` + Escで閉じる。**初期フォーカスは非破壊的な「キャンセル」ボタン**に置く
  (即時成立・取消不可の操作のため、Enter連打での誤成立を防ぐ)
- 送信中は「交換する」ボタンをdisabled+ローディング表示(連打時の二重モーダル・重複エラー表示の防止。
  冪等性はサーバー側 requestId でも担保)

### 6.5 出品フロー(2ステップモーダル or ページ)

```
Step 1: 渡すカードを選ぶ
  - 自分の所持カード一覧(重複所持カードに「×N」バッジ、重複を先頭にソートし推奨)
  - 出品中の1枚はグレーアウト「出品中」
Step 2: 欲しいカードを選ぶ
  - チャンネル内: その配信者のアクティブカード catalog から選択(未所持カードを強調表示)
  - クロス: 配信者検索/選択 → そのチャンネルのカード選択
    (選択肢はクロス許可(両フラグtrue)の配信者のみ)
確認: 「渡す ○○ ⇄ 欲しい △△ で出品します」→ 作成
```

- 出品成功後はボードに自分のオファーが先頭表示され、フィードバックが即時に得られる

### 6.6 マイトレード(/trade/mine)

- タブ: 「出品中」「成立」「キャンセル」
- 出品中: キャンセルボタン付き
- 成立: 相手displayName・交換内容・日時。自分が応諾した取引も同一リストに表示。
  カード定義が削除済みの場合は `*_card_snapshot` から「削除済みカード」として表示
- **恒常導線(MVP必須)**: 通知(§8)はフェーズ2のため、ボード経由以外の導線が必要。
  `/dashboard/collection`(マイコレクション一覧)のヘッダに「マイトレード」リンクを常設する
  (出品後にボードを離れたユーザーが、配信者URLを踏み直さなくても出品確認・キャンセルに到達できるように)
- 出品フローの送信中ボタンdisabledは §6.4 と同様

### 6.7 配信者ダッシュボード設定UI

既存 `src/components/CardVisibilitySettings.tsx` と同型の `TradeSettings.tsx` を
`src/components/` に追加し、`src/app/dashboard/settings/page.tsx` に組み込む
(hand-rolled toggle + `POST /api/streamer/settings` + 楽観的更新):

```
カードトレード
  [toggle] 視聴者間のカードトレードを許可する
     説明: 視聴者同士があなたのチャンネルのカードを交換できるようになります
  [toggle] クロスチャンネルトレードを許可する(上がONのときのみ操作可)
     説明: あなたのカードを他チャンネルのカードと交換できるようになります。
           相手チャンネル側もクロスチャンネルを許可している必要があります
```

- 親トグルOFF時は子トグルをdisabled表示(依存関係を視覚化)
- 注意書き: 「OFFにすると進行中の出品は一時的に非表示・応諾不可になります(削除はされません)」
- 実装漏れ注意: `src/app/dashboard/settings/page.tsx` 側の streamers SELECT に新フラグを追加(初期値取得)、
  `/collection/[streamerId]` のトレードボタン表示用に streamer フェッチへ `trade_enabled` を追加

### 6.8 アクセシビリティ / 空状態

- 空状態: 「まだ出品がありません。最初の出品をしてみましょう [出品する]」
- トグル・ボタンは既存同様 `aria-label` / `sr-only` を付与
- 交換方向は色だけに頼らず「⇄」アイコン+「渡す/もらう」ラベルで明示

## 7. セキュリティ・整合性の要点

- 成立はRPC内の単一トランザクション+行ロック(二重成立・所有喪失・同時応諾に対して安全)。デッドロックはAPI層で40P01捕捉+リトライ
- 冪等性キー(requestId)を作成・応諾の両方に適用(モバイル回線の二重POST対策)。リプレイ判定は検証より前(§4.4 手順3)
- CSRF・rate limit・セッション認証は既存ミドルウェア関数を全POSTに適用
- RLSは `TO service_role` を明示(00024の教訓)
- 出品一覧APIは設定ゲートをサーバー側で必ず適用(URLを直接叩かれてもOFFチャンネルのオファーは返さない)
- 非正規化カラム(offered_card_id 等)はサーバ導出のみ。クライアントから受けるIDは `offeredUserCardId` / `wantedCardId` / `requestId` に限定
- 譲渡そのものに手数料・回数制限は設けないが、上限10件/ユーザーの同時出品制限でスパム抑止
- **複数アカウントによるカード集約リスク**: 本機能はプラットフォーム初のユーザー間所有権移転であり、
  サブアカウントで「レア出品⇄コモン募集」を作り本アカウントで応諾すれば、複数アカウントの排出を
  1アカウントに集約できる。完全な対策はMVPでは行わない(YAGNI)が、事後検知できるよう
  応諾APIで offerer/accepter の twitch_user_id とrate-limit identifier(IP由来)を構造化ログに残す。
  不正検知の本格対応はフェーズ2の検討項目として子issueに記載
- RMT(リアルマネートレード)対策は本フェーズではスコープ外とし、規約(TOS)への追記検討のみ子issueに記載

## 8. 通知(フェーズ2・優先度低)

MVPでは通知なし(マイトレード画面で確認)。フェーズ2で:
- 成立時に Supabase Realtime broadcast(`trades:${twitchUserId}` チャンネル、既存 `realtime.ts` パターン)
- ヘッダーにバッジ表示、フォールバックはページ表示時のfetch

## 9. 実装フェーズと子Issue分割

各子issueが「実装の詳細設計」を含む。依存順:

1. **UI/UX詳細設計**(§6の具体化: 全画面ワイヤー、状態遷移、文言、i18nキー一覧)
2. **DB: マイグレーション+RPC**(trade_offers、settingsカラム、accept_trade_offer、SQLテスト)
3. **API: オファーCRUD**(作成/一覧/キャンセル/mine、`src/lib/trade.ts`、統合テスト)
4. **API: 応諾エンドポイント**(RPC連携・冪等リプレイ・40P01リトライ。複雑度が突出するため#3から分離)
5. **配信者設定**(settings API拡張+ダッシュボードトグルUI)
6. **視聴者UI: トレードボード+応諾フロー**
7. **視聴者UI: 出品フロー+マイトレード**
8. **rate limit KVストレージ配線**(§5参照。トレード一般公開前の必須条件。既存機能にも波及するため独立issue)
9. **フェーズ2: 成立通知(Realtime)+不正検知・RMT対策(TOS追記含む)の検討** ※優先度低

テスト方針: 2はRPCのSQLテスト(同時応諾・喪失・冪等リプレイ)、3/4はAPI統合テスト(23505リプレイ・40P01写像を含む)、6/7はコンポーネント単体テスト+E2Eシナリオ追記(`E2E_TEST_CASES.md`)。

## 10. レビュー履歴

- 初版に対する厳格レビュー(subagent。codexは本環境に未導入のため代替)で以下を修正済み:
  - 重大: 冪等リプレイ判定を全検証より前に移動(§4.4 手順3)/ `offered_user_card_id` のFK CASCADE廃止(履歴消滅・OFFER_INVALIDパス不成立の矛盾解消)
  - 中: デッドロック方針明記 / 一覧クエリ方式と `canAccept` 仕様確定 / 作成冪等性の23505リプレイ仕様 / インデックス再設計(複合部分+FK支持)/ `is_active` 方針確定
  - 軽微: `is_cross_channel` 生成列化、updated_atトリガー、上限チェック競合の許容明記、コンポーネントパス修正、実装漏れ注意の追記ほか
- チームレビュー(DB/セキュリティ担当)で以下を修正済み:
  - 重大: `offered_card_id` / `wanted_card_id` の CASCADE → **SET NULL + カード情報のJSONBスナップショット**
    (既存 DELETE /api/cards/[id] は無条件ハード削除のため、CASCADEだと配信者のカード整理で成立履歴が消える)
  - 中: 支払いカード選定を「LIMITなし全ロック→選定」の2段構成に修正(00059/00060 のパターン準拠)/
    複数アカウント集約リスクの明記と応諾ログ方針 / rate limit の KVストレージ確認事項
  - 軽微: API層でのUUID形式事前検証 / 40P01リトライのジッター・pg直結時の注意
- チームレビュー(UX担当)で以下を修正済み:
  - 重大: 未ログイン時の応諾ボタン第4状態「ログインして応じる」を定義 / 「所持していません」と
    「全コピー出品中」のラベル分離 / `/trade/mine` への恒常導線(マイコレクションヘッダ)をMVPに追加
  - 中: 「最も古い1枚が自動選択」の事前告知を一覧に常設 / モバイル縦積みレイアウト方針 /
    エラー表示の共通方針(インライン、トースト新設なし)/ モーダルのfocus trap+初期フォーカス=キャンセル
- チームレビュー(運用・コスト担当)で以下を修正済み:
  - 重大: rate limit KVストレージが実際には未配線である事実を確認 → 配線を独立子issue化し
    トレード一般公開前の必須条件に設定
  - 中: API子issueをCRUDと応諾に分割 / `tradeRead` の暫定値確定(100回/分)
  - 軽微: 一覧キャッシュは検討の上MVPでは不採用と明記
- チームリード統合判断: インデックス11本は00071の本番障害の再発防止として妥当(運用担当の検証結果を採用)。
  全レビュワーの重大・中指摘はすべて反映済み
