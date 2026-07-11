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

## 4. DB設計

スキーマの正はSupabaseマイグレーション(`supabase/migrations/000XX_add_card_trading.sql`)。`src/lib/db/schema.ts` にDrizzle型ミラーを追記。

### 4.1 trade_offers テーブル

所有は row-per-copy モデル(`user_cards` 1行=1枚)なので、オファーは**特定の user_cards 行**を指す。

```sql
CREATE TABLE trade_offers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- 出品者
  offerer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 渡すカードの特定の1枚(所有権チェック・ロック対象)
  offered_user_card_id UUID NOT NULL REFERENCES user_cards(id) ON DELETE CASCADE,
  -- 一覧表示・フィルタ用の非正規化(offered_user_card_id から導出可能だが JOIN 削減のため保持)
  offered_card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  offered_streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  -- 欲しいカード(種別指定。特定の1枚ではない)
  wanted_card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  wanted_streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  -- チャンネル内/クロスの判別(offered_streamer_id = wanted_streamer_id かどうか)
  is_cross_channel BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  -- 成立情報
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_user_card_id UUID,  -- 応諾者が渡した1枚(記録用・FKなし: 移転後も記録を残す)
  completed_at TIMESTAMPTZ,
  -- 作成の冪等性キー(card_stone_transactions と同パターン)
  request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一カード同士の交換は無意味なので禁止
  CONSTRAINT trade_offers_different_cards CHECK (offered_card_id <> wanted_card_id)
);

-- 同じ1枚を複数のopenオファーに同時出品することを防ぐ(部分UNIQUE)
CREATE UNIQUE INDEX idx_trade_offers_open_user_card
  ON trade_offers(offered_user_card_id) WHERE status = 'open';
-- 作成の冪等性
CREATE UNIQUE INDEX idx_trade_offers_offerer_request
  ON trade_offers(offerer_user_id, request_id) WHERE request_id IS NOT NULL;
-- 一覧クエリ用
CREATE INDEX idx_trade_offers_open_offered_streamer ON trade_offers(offered_streamer_id) WHERE status = 'open';
CREATE INDEX idx_trade_offers_open_wanted_streamer ON trade_offers(wanted_streamer_id) WHERE status = 'open';
CREATE INDEX idx_trade_offers_offerer ON trade_offers(offerer_user_id);
```

RLS: 既存パターンに厳密に従う(`00024` の教訓 — 必ず `TO service_role` を明示)。

```sql
ALTER TABLE trade_offers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_offers TO service_role;
CREATE POLICY "Service can manage trade_offers" ON trade_offers
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

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

### 4.4 成立RPC: accept_trade_offer

成立処理は競合(同一オファーへの同時応諾、出品カードの喪失)があるため、
`exchange_duplicate_card_for_stones`(migration 00059/00060)と同じ
**SECURITY DEFINER plpgsql RPC + FOR UPDATE ロック + request_id 冪等性** で実装する。

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
3. 検証(失敗時はエラーコードを含むJSONBを返す):
   - `status = 'open'` であること(二重成立防止)
   - 応諾者 ≠ 出品者(自己応諾禁止)
   - 設定ゲート再チェック: 両配信者の `trade_enabled`(クロスなら `cross_channel_trade_enabled` も)
   - 出品カード実在チェック: `SELECT ... FROM user_cards WHERE id = offered_user_card_id AND user_id = offerer_user_id FOR UPDATE`
     — 出品者がその1枚をまだ所有しているか。喪失していたら offer を `cancelled` にして 'OFFER_INVALID' を返す
   - 応諾者の支払いカード選択: `SELECT id FROM user_cards WHERE user_id = 応諾者 AND card_id = wanted_card_id
     AND id NOT IN (自分のopenオファーの offered_user_card_id) ORDER BY obtained_at ASC, id ASC LIMIT 1 FOR UPDATE`
     — 最も古い1枚を自動選択(出品中の1枚は除外)。無ければ 'CARD_NOT_OWNED'
4. 冪等性: `INSERT`ではなく`trade_offers`のUPDATE前に、`accepted_by_user_id`と`request_id`一致なら成立済み結果を再返却
   (二重POST対策。詳細は 00060 の再生パターンを踏襲)
5. 所有権の移転(row-per-copy なので UPDATE で user_id を付け替える):
   - `UPDATE user_cards SET user_id = 応諾者, obtained_at = now() WHERE id = offered_user_card_id`
   - `UPDATE user_cards SET user_id = 出品者, obtained_at = now() WHERE id = 応諾者の支払いカードid`
   - ※ 新規発行ではないため `max_issuance_count`(発行上限)には影響しない
6. `UPDATE trade_offers SET status='completed', accepted_by_user_id=..., accepted_user_card_id=..., completed_at=now(), request_id=p_request_id(応諾側キーとして別カラム accepted_request_id に保存)`
7. 成立結果JSONBを返す(両カード情報を含む)

補足: オファー作成時の request_id は出品の冪等性、応諾時のキーは `accepted_request_id UUID` カラム(+ 部分UNIQUE `(accepted_by_user_id, accepted_request_id)`)として分離する。

権限: `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO service_role;` + `SET search_path = public, pg_temp`。

### 4.5 キャンセル

出品者本人によるキャンセルは競合が単純(open→cancelled のCAS)なので、RPCにせず
API側で `UPDATE trade_offers SET status='cancelled' WHERE id=? AND offerer_user_id=? AND status='open'` の条件付きUPDATEで実装する。

## 5. API設計

既存の規約(validateContentType → validateCSRFToken → getSession → rate limit → getSupabaseAdmin → users.id解決 → 処理 → handleApiError)に厳密に従う。ロジックは `src/lib/trade.ts` に置く。まずはPostgRESTパスのみ実装(pg-direct二重化はフラグ運用が始まってから。YAGNI)。

| Method | Path | 概要 |
|---|---|---|
| GET | `/api/trades?streamerId=&scope=in_channel\|cross_channel&wantedCardId=&offeredCardId=&page=` | openオファー一覧。設定ゲートを満たすもののみ返す。ページネーション必須(20件/頁) |
| POST | `/api/trades` | オファー作成 `{ offeredUserCardId, wantedCardId, requestId }` |
| GET | `/api/trades/mine` | 自分のオファー一覧(open/completed/cancelled、自分が応諾した取引も含む) |
| POST | `/api/trades/[id]/accept` | 応諾 `{ requestId }` → RPC呼び出し |
| POST | `/api/trades/[id]/cancel` | 出品者本人のキャンセル |
| POST | `/api/streamer/settings` | 既存エンドポイントに `tradeEnabled` / `crossChannelTradeEnabled` キーを追加 |

### バリデーション(POST /api/trades)

- `offered_user_card_id` が自分の所有行であること
- その行が他のopenオファーに出品中でないこと(部分UNIQUEで最終防衛、事前チェックでUX向上)
- 設定ゲート(§3)を満たすこと
- `offered_card_id <> wanted_card_id`
- 1ユーザーの同時openオファー上限 **10件**(スパム対策。定数 `TRADE_MAX_OPEN_OFFERS`)
- rate limit: 既存 `rateLimits` に `tradeWrite`(例: 10回/分)/ `tradeRead` を追加

### エラーコード

`ERROR_MESSAGES` に追加: `TRADE_DISABLED` / `TRADE_OFFER_NOT_FOUND` / `TRADE_ALREADY_COMPLETED` / `TRADE_SELF_ACCEPT` / `TRADE_CARD_NOT_OWNED` / `TRADE_OFFER_LIMIT` など。i18nはUI側で対応表を持つ。

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
- 応諾ボタンの状態:
  - 募集カードを所持 → 有効(purple)
  - 未所持 → 無効(gray)+「所持していません」ラベル
  - 自分の出品 → 「自分の出品」バッジ+キャンセルボタン
- クロスチャンネルタブでは各カードに配信者アイコン+名前を小さく併記(どのチャンネルのカードか一目で分かるように)
- 未ログイン時は閲覧可・応諾ボタンでログイン導線(既存 `returnTo` パターン)

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

- 成立後: 成功トースト+獲得カードのアップ表示(既存ガチャ演出コンポーネントは流用せず簡素に。YAGNI)
- 失敗時(先に成立された等): 「この取引は成立済みです」を表示し一覧をrefetch

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
- 成立: 相手displayName・交換内容・日時。自分が応諾した取引も同一リストに表示
- バッジ通知(§8)からの遷移先

### 6.7 配信者ダッシュボード設定UI

`src/app/dashboard/settings` の既存 `CardVisibilitySettings.tsx` と同型の
`TradeSettings.tsx` を追加(hand-rolled toggle + `POST /api/streamer/settings` + 楽観的更新):

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

### 6.8 アクセシビリティ / 空状態

- 空状態: 「まだ出品がありません。最初の出品をしてみましょう [出品する]」
- トグル・ボタンは既存同様 `aria-label` / `sr-only` を付与
- 交換方向は色だけに頼らず「⇄」アイコン+「渡す/もらう」ラベルで明示

## 7. セキュリティ・整合性の要点

- 成立はRPC内の単一トランザクション+行ロック(二重成立・所有喪失・同時応諾に対して安全)
- 冪等性キー(requestId)を作成・応諾の両方に適用(モバイル回線の二重POST対策)
- CSRF・rate limit・セッション認証は既存ミドルウェア関数を全POSTに適用
- RLSは `TO service_role` を明示(00024の教訓)
- 出品一覧APIは設定ゲートをサーバー側で必ず適用(URLを直接叩かれてもOFFチャンネルのオファーは返さない)
- 譲渡そのものに手数料・回数制限は設けないが、上限10件/ユーザーの同時出品制限でスパム抑止
- RMT(リアルマネートレード)対策は本フェーズではスコープ外とし、規約(TOS)への追記検討のみ子issueに記載

## 8. 通知(フェーズ2・優先度低)

MVPでは通知なし(マイトレード画面で確認)。フェーズ2で:
- 成立時に Supabase Realtime broadcast(`trades:${twitchUserId}` チャンネル、既存 `realtime.ts` パターン)
- ヘッダーにバッジ表示、フォールバックはページ表示時のfetch

## 9. 実装フェーズと子Issue分割

各子issueが「実装の詳細設計」を含む。依存順:

1. **UI/UX詳細設計**(§6の具体化: 全画面ワイヤー、状態遷移、文言、i18nキー一覧)
2. **DB: マイグレーション+RPC**(trade_offers、settingsカラム、accept_trade_offer、単体テスト)
3. **API: トレードエンドポイント一式**(作成/一覧/応諾/キャンセル/mine、`src/lib/trade.ts`、統合テスト)
4. **配信者設定**(settings API拡張+ダッシュボードトグルUI)
5. **視聴者UI: トレードボード+応諾フロー**
6. **視聴者UI: 出品フロー+マイトレード**
7. **フェーズ2: 成立通知(Realtime)** ※優先度低

テスト方針: 2はRPCのSQLテスト(同時応諾・喪失・冪等性)、3はAPI統合テスト、5/6はコンポーネント単体テスト+E2Eシナリオ追記(`E2E_TEST_CASES.md`)。
