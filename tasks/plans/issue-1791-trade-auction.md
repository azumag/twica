# トレード: オークション形式の出品 設計ドキュメント (Issue #1791)

親: #715（トレード）／ 問い合わせ: #1788 ／ 関連: #1789（枚数指定）、#1790（求に指定できるカードの制限）、#729（通知・不正対策。MVP後）

仕様の正本は、#1791 の 2026-10-14 の仕様確定コメントと、本書 §1 のオーナー確認事項。本書はそれを現行 runtime（PlanetScale PostgreSQL 固定。`tasks/plans/README.md` 参照）上の DB・API・UI 設計へ落とし込む。
計画レビュー（2026-10-14、1回）の必須指摘 M1〜M9 を反映済み（§11）。

## 1. 仕様（確定事項）

| 項目 | 決定 |
|---|---|
| 出品 | 出品者は所持カード1枚を出品し、期限を 24時間 / 3日 / 7日 から選ぶ。出品したカードは拘束する |
| 入札 | 入札者は**1種類のカード × 枚数（1〜10）**を提示する。入札に出したカードはすべて拘束する |
| 入札の更新 | 1人1オークションにつき有効な入札は1件。期限前なら取り下げ・変更できる |
| 勝者の決定 | 期限後に出品者が1件を選んで成立させる。選ばれなかった入札は解放する |
| 選択期間 | 期限から**72時間**。選ばれなければ流札とし、全カードを解放する |
| 取消 | 有効な入札が1件でもあれば取り消せない。**有効な入札が0件なら、期限の前後に関係なく取り消せる** |
| 入札0件で期限到来 | その時点で流札（出品カードを即時に解放する。72時間待たない） |
| 成立不能な入札 | 期限後でも、成立できない状態（配信者のトレード設定OFF、カードの無効化・削除、`trade_wantable=false`）なら、入札者は取り下げられる |
| 自己入札 | 禁止 |
| 入札カード | `cards.trade_wantable = true` のものに限る（#1790 の制限を適用。オーナー確定）。出品カードと同じカード種別での入札は禁止（既存の `trade_offers_different_cards` に揃える） |
| チャンネル | 既存トレード設定に従う。入札カードの配信者がオークションの配信者と異なればクロスチャンネル扱いで、両配信者の `trade_enabled` と `cross_channel_trade_enabled` を要求する |
| 公開範囲 | 入札の中身（カード・枚数・入札者）は、出品者本人と、自分の入札について入札者本人だけに見せる。他の閲覧者には入札数だけを表示する |
| 上限 | open な通常出品とオークション出品の合計で `TRADE_MAX_OPEN_OFFERS`（10）を共用する。有効な入札は1人10件まで |
| 通知 | 画面内表示のみ。マイトレードに 出品中 / 入札中 / 選択待ち / 成立 / 流札 を表示する。リアルタイム通知は #729 |

### 1.1 業界標準との比較
- 一般的なゲーム内オークションハウスは「単一通貨・最高額で自動落札・入札額をエスクロー」が標準。
- 本機能は入札の対価が任意カード×枚数で単一通貨ではなく、自動落札ができない。そのため「全入札をエスクロー（拘束）＋出品者が選ぶ」という、入札募集（RFQ）型の方式を採る。
- エスクローは資産を移動させず、行ロックと状態で表現する。移転は成立時の1トランザクションだけにする（既存の `accept_trade_offer` と同じ方針で、途中失敗の巻き戻しを不要にする）。

## 2. 用語
- **オークション**: `trade_auctions` の1行。
- **入札**: `trade_auction_bids` の1行。拘束した具体的なコピーは `trade_auction_bid_items` に持つ。
- **拘束**: あるコピー（`user_cards.id`）が、通常出品・オークション出品・有効な入札のいずれかに使われている状態。拘束中のコピーは、他の出品・入札・応諾の支払いに使えない。

## 3. 状態の導出（Cron 不要）

オークションの実効状態は、保存された `status` と時刻から決める。時刻は必ず **DB の `clock_timestamp()`** を使い、Worker の時刻は使わない。RPC の中では、オークション行の `FOR UPDATE` を取った**後で**読む。

> `now()` はトランザクション開始時刻で固定され、行ロック待ちの間も進まない。境界をまたいだ誤判定を防ぐため、`clock_timestamp()` を使う（計画レビュー M3）。

```
status='open' かつ t < ends_at                                    → 入札受付中 (bidding)
status='open' かつ ends_at <= t < selection_deadline かつ 有効入札>0 → 選択待ち (selecting)
status='open' かつ ends_at <= t かつ 有効入札=0                     → 流札 (expired、導出)
status='open' かつ selection_deadline <= t                         → 流札 (expired、導出)
status='completed'                                                 → 成立
status='cancelled'                                                 → 取消
status='expired'                                                   → 流札（後処理で確定保存した場合）
```

- `selection_deadline = ends_at + interval '72 hours'` は作成時に保存する（後から規則を変えても、既存オークションの約束が変わらないようにするため）。
- 流札を `status='expired'` として保存するのは、関連 RPC の実行時に行う任意の後処理とし、正しさはそれに依存させない。
- 入札の状態: `active`（有効）/ `withdrawn`（取り下げ・変更）/ `won` / `lost`。オークションが流札・取消になった後の `active` 入札は、親の実効状態から「解放済み」と導出する。

## 4. DB 設計（migration は `db/planetscale/migrations/` に最新+1で1本）

### 4.1 拘束の判定（専用テーブルは作らない）
拘束を一元化する専用テーブルは作らない（計画レビュー M9）。PK 衝突、孤児ロック、バックフィル、期限切れロックの掃除が構造的に発生しない方式を採る。

```sql
-- コピーが拘束中か。呼び出し側は事前に当該 user_cards 行を FOR UPDATE していること。
CREATE FUNCTION public.trade_copy_locked(p_user_card_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.trade_offers o
            WHERE o.offered_user_card_id = p_user_card_id AND o.status = 'open')
    OR EXISTS (SELECT 1 FROM public.trade_auctions a
               WHERE a.offered_user_card_id = p_user_card_id
                 AND public.trade_auction_holds_cards(a.id))
    OR EXISTS (SELECT 1 FROM public.trade_auction_bid_items i
               JOIN public.trade_auction_bids b ON b.id = i.bid_id
               WHERE i.user_card_id = p_user_card_id
                 AND b.status = 'active'
                 AND public.trade_auction_holds_cards(b.auction_id))
$$;
```
- `trade_auction_holds_cards(auction_id)` は、§3 の実効状態が bidding か selecting のとき true を返す。
- **すべての拘束取得・移転経路は同じ手順を踏む**: 対象 `user_cards` 行を id 昇順で `FOR UPDATE` → 所有を再確認 → `trade_copy_locked` で判定（計画レビュー M2）。
  - 対象: 通常出品、オークション作成、入札、応諾の支払い、成立。
  - 同じ行のロックで直列化されるので、2つの経路が同時に同じコピーを拘束することはない。
- **通常出品への適用**: `trade_offers` に BEFORE INSERT トリガーを置く。
  - トリガーは、出品コピーの `user_cards` 行を `FOR UPDATE` し、所有を再確認する。
  - オークション・入札で拘束中なら `RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRADE_CARD_LOCKED'` で拒否する。
  - 同じ通常出品どうしの重複は、既存の部分UNIQUE（`idx_trade_offers_open_user_card`）に任せる（二重の安全装置として維持）。
- **新アプリの `createTradeOffer`**（計画レビュー M1）:
  - 事前チェック（`offeredCopyListed`）を「拘束中」の判定に広げる。
  - INSERT 失敗時、`TRADE_CARD_LOCKED`（P0001）は `TRADE_CARD_ALREADY_LISTED` へマップする。
  - 23505 の既存処理はそのまま残す。
  - 互換性の注記: ロールバック後の旧アプリでは、拘束中コピーの通常出品は 500 で拒否される（データは壊れない。fail-closed）。
- **応諾 `accept_trade_offer`**（4引数版を `CREATE OR REPLACE`。**必ず 20261014100000 版を基にする**。差分テストで固定する）:
  - 支払いコピー選択の除外条件を `NOT public.trade_copy_locked(id)` へ変更する。
  - 2段ロック後の最終確認にも拘束判定を加える（ロック待ちの間に入札で拘束されたコピーを移転しないため）。
  - 返却 JSON、エラーコード、3引数ラッパーは維持する。
- **アプリ側の判定**（`listTradeableOwnedCopies`、`acceptStateFor`）も同じ条件へそろえる。`all_listed` の文言は「出品中・入札中」に合わせる。
- インデックス: `trade_auction_bid_items (user_card_id)`、`trade_auctions (offered_user_card_id) WHERE status = 'open'`。

### 4.2 `trade_auctions`
```sql
CREATE TABLE public.trade_auctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  offered_user_card_id uuid NOT NULL,      -- trade_offers と同じく FK なし（コピー削除は成立時の所有確認で検出）
  offered_card_id uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  offered_streamer_id uuid NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE,
  offered_card_snapshot jsonb NOT NULL,
  ends_at timestamptz NOT NULL,
  selection_deadline timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled','expired')),
  winning_bid_id uuid,
  request_id uuid NOT NULL,
  settle_request_id uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (selection_deadline > ends_at)
);
```
- インデックス: `(offered_streamer_id, ends_at)` WHERE status='open'、`(seller_user_id)` WHERE status='open'、`UNIQUE (seller_user_id, request_id)`、`(offered_user_card_id)` WHERE status='open'、FK 列すべて（カスケード用）。
- FK と CASCADE / SET NULL の方針は `trade_offers` に揃える。

### 4.3 `trade_auction_bids` / `trade_auction_bid_items`
```sql
CREATE TABLE public.trade_auction_bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL REFERENCES public.trade_auctions(id) ON DELETE CASCADE,
  bidder_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bid_card_id uuid REFERENCES public.cards(id) ON DELETE SET NULL,   -- 表示はスナップショット
  bid_streamer_id uuid NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE,
  quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 10),     -- TRADE_MAX_WANTED_QUANTITY と同値
  bid_card_snapshot jsonb NOT NULL,
  is_cross_channel boolean NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn','won','lost')),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON public.trade_auction_bids (auction_id, bidder_user_id) WHERE status = 'active';
CREATE UNIQUE INDEX ON public.trade_auction_bids (bidder_user_id, request_id);

CREATE TABLE public.trade_auction_bid_items (
  bid_id uuid NOT NULL REFERENCES public.trade_auction_bids(id) ON DELETE CASCADE,
  user_card_id uuid NOT NULL,
  PRIMARY KEY (bid_id, user_card_id)
);
CREATE INDEX ON public.trade_auction_bid_items (user_card_id);
```

### 4.4 RPC（plpgsql。エラーは `accept_trade_offer` と同じ JSONB 方式）
- **共通のロック順**: オークション行 → 入札行 → `user_cards` 行（id 昇順）。時刻判定と status の再確認は、オークション行のロック取得**後**に `clock_timestamp()` で行う。
- **40P01**: アプリ層で、accept と同じく「1回だけ再試行し、それでもだめなら `TRADE_BUSY`」とする（`withDbRetry` の再試行対象ではないため）。

1. `create_trade_auction(twitch_user_id, user_card_id, duration_hours, request_id)`
   - 冪等リプレイ → `duration_hours` が 24/72/168 のいずれか → `user_cards` を FOR UPDATE して所有確認 → 設定ゲート → カード有効性 → 上限（通常出品とオークションの open 合計。導出上の流札は除く）→ `trade_copy_locked` なら `TRADE_CARD_ALREADY_LISTED` → INSERT。
2. `place_trade_auction_bid(twitch_user_id, auction_id, bid_card_id, quantity, request_id)`
   - オークション行 FOR UPDATE → 冪等リプレイ → `status='open'` かつ `clock_timestamp() < ends_at` → 自己入札禁止 → 出品カードと同じ種別は禁止 → 設定ゲート（クロス判定）。
   - 入札カードの `is_active` と `trade_wantable` を確認する。可視性は「入札カードが出品者に見える」「出品カードが入札者に見える」の両方を要求する（既存の `cardVisibleTo` と同じ規則。計画レビュー M8）。
   - 有効入札の上限（10）を確認する。既存の自分の active 入札があれば withdrawn にする（同じトランザクション内なので、そのコピーはこの入札で再利用できる）。
   - 入札者の `bid_card_id` のコピーを全件 FOR UPDATE する（既存 accept と同じ2段ロック手法）→ `trade_copy_locked` でないものから最古の N 件を選ぶ → 不足なら `TRADE_NOT_ENOUGH_CARDS` → 入札と items を INSERT。
3. `withdraw_trade_auction_bid(twitch_user_id, bid_id)`（状態として冪等なので request_id 不要）
   - 入札をロックなしで読み、auction_id を得る → オークション行 FOR UPDATE → 入札行 FOR UPDATE → 本人確認。
   - 許可条件: 「`clock_timestamp() < ends_at`」または「期限後で、成立不能」（§1 の成立不能条件）。
   - withdrawn にする。
4. `cancel_trade_auction(twitch_user_id, auction_id)`
   - オークション行 FOR UPDATE → 本人確認 → `status='open'` → 有効入札が0件なら cancelled にする（時刻は問わない。計画レビュー M7）。
5. `settle_trade_auction(twitch_user_id, auction_id, bid_id, request_id)`
   - オークション行 FOR UPDATE → 冪等リプレイ（`settle_request_id`）→ 出品者本人 → `status='open'` かつ `ends_at <= clock_timestamp() < selection_deadline` → 入札行 FOR UPDATE、active であることを確認。
   - 設定ゲート、両カードの `is_active`、入札カードの `trade_wantable` を再確認する。成立できない場合は JSONB エラーを返し、出品者が別の入札を選べるようにする。
   - 出品コピーと入札コピーを id 昇順で FOR UPDATE → 所有を再確認（欠けていれば `AUCTION_BID_INVALID`）→ 移転件数を検査（`TRADE_PAYER_TRANSFER_MISMATCH` 相当）。
   - 所有権を移転する（出品コピー → 入札者、入札コピー群 → 出品者）→ 対象入札を won、他を lost → オークションを completed。

### 4.5 migration の安全策（計画レビュー M5・M6）
- 新規テーブルと関数の追加が主で、既存テーブルへの変更は `trade_offers` のトリガー追加と `accept_trade_offer` の置き換えだけ。
- `SET LOCAL lock_timeout`（例 5s）を設定し、本番の書き込みブロックを短く抑える（このリポジトリでは初の導入なので、理由をコメントに書く）。
- 権限は既存トレード RPC と同じく `REVOKE ALL ... FROM PUBLIC, anon, authenticated` とする。

### 4.6 migration 未適用の窓（計画レビュー M6）
アプリのデプロイと migration の適用は非同期（`docs/db-driver-migration.md`）。新アプリが先に出ても既存画面を壊さない。
- 拘束判定のクエリが 42P01/42883（テーブルや関数が無い）になったら、「オークション・入札の拘束なし」として従来の判定へ縮退する。既存の 42703 フォールバックと同じパターンを使う。
- オークション API は、テーブルが無ければ 503 `TRADE_AUCTION_UNAVAILABLE` を返す。UI はオークションのタブと導線を出さない。
- `/api/trades/mine` は拡張しない。オークションは別エンドポイントにして、失敗しても既存のマイトレードを落とさない。

## 5. API
| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/trades/auctions?streamerId=&scope=&page=` | ボード一覧（受付中・選択待ち）。入札数と自分の入札状態を含む。絞り込みは DB 時刻で行う |
| POST | `/api/trades/auctions` | 作成（`requestId` 必須） |
| GET | `/api/trades/auctions/[id]` | 詳細。入札の中身は出品者本人と、自分の入札について入札者本人にだけ返す |
| POST | `/api/trades/auctions/[id]/bids` | 入札・入札変更 |
| POST | `/api/trades/auctions/[id]/bids/[bidId]/withdraw` | 取り下げ |
| POST | `/api/trades/auctions/[id]/cancel` | 取消 |
| POST | `/api/trades/auctions/[id]/settle` | 出品者による成立（`bidId`, `requestId`） |
| GET | `/api/trades/auctions/mine` | 自分のオークションと入札（状態別） |

- 認証と rate limit は既存の `tradeWrite` / `tradeRead` を共用する（`src/lib/trade-api.ts`）。
- エラーコードは既存のトレードエラー体系へ追加し、ja/en の文言を用意する。
- クロスチャンネルの見つけ方: 既存ボードのクロスタブと同じ規則で、相手側のボードにも表示する。

## 6. UI
- トレードボード（`/trade/[streamerId]`）に「オークション」タブを追加する。行には、出品カード、残り時間（受付中）または「選択待ち」、入札数、自分の入札状態を表示する。
- オークション詳細では、入札・変更・取り下げができる。カード選択は出品フロー Step 2 の UI を再利用し、`trade_wantable` と可視性を反映する。出品者は、ここで入札一覧を見て成立させる。
- 出品フローの最初に「通常出品 / オークション」を選ぶ。オークションでは期限（24時間/3日/7日）を選ぶ。
- マイトレードに「オークション」タブを追加する。
  - 自分の出品: 出品中 / 選択待ち（成立操作）/ 成立 / 流札・取消
  - 自分の入札: 入札中 / 落札 / 落選・解放
- 時刻はサーバーが返す ISO 時刻を、クライアントで相対表示する。期限の境界はサーバーで判定する。
- PR-2 で確定した画面構成（タブの URL、詳細ページ、migration 窓の「準備中」表示など）は §13 を参照。

## 7. セキュリティ・整合性
- 拘束の排他の正本は「`user_cards` 行の FOR UPDATE ＋ `trade_copy_locked`」で、全経路に一律で適用する。アプリ層の事前チェックは補助。
- 成立は1トランザクションで移転と状態確定を行い、冪等キーで再送を吸収する。時刻は `clock_timestamp()` で判定する。
- 入札の中身は限定公開にし、可視性は入札時と表示時の両方で確認する。
- 談合・自作自演（サブアカウントでの入札）は #729 の不正対策の対象で、MVP では検知しない（#715 の判断を踏襲）。
- 監査ログ: 作成・入札・取り下げ・取消・成立を構造化ログで記録する。
- 石交換 RPC（休眠中）が将来公開されたら、`trade_copy_locked` の判定を追加する必要がある（注記）。

## 8. テスト
- 実PG統合テストを新ファイルで追加し、**`.github/workflows/ci.yml` の path filter と明示実行ステップへ登録する**（登録しないと CI で走らない）。
  - 拘束の排他: 通常出品 × オークション × 入札の全組み合わせ。トリガー経由の `TRADE_CARD_LOCKED` も含む。
  - 時刻の境界: 過去の `ends_at` / `selection_deadline` を INSERT して作る。
  - 流札後の解放と、その後の再出品・応諾支払いへの再利用。
  - 入札0件の取消（期限前・期限後）。
  - 成立時の移転・冪等リプレイ・件数検査。成立不能時のエラーと、入札者の取り下げ。
  - `trade_wantable=false` と設定 OFF での拒否。
  - accept の契約が不変であること（#1789/#1790 の既存テストは全てそのまま通す）。
- 2接続での並行テスト（`tests/fixtures/add-card-trading-concurrency.sh` 型）: 入札 × 通常出品、入札変更 × 成立、成立 × 期限境界。
- migration 未適用の窓のテスト（42P01/42883 での縮退、オークション API の 503）。
- ユニットテスト: API の入力検証とエラーマッピング、UI の状態表示、i18n。

## 9. 実装の分割（preview 向け PR）
1. **PR-1（DB + API）**: migration（テーブル、関数、トリガー、accept の置き換え）、`trade.ts` の拘束判定の統一と窓フォールバック、オークションの service と API。
2. **PR-2（UI）**: ボードのタブ、詳細、出品フローの分岐、マイトレード。

各 PR で独立レビューを1回実施する（DB・トレード実経路のため）。

## 10. オーナー確認済み事項（2026-10-14）
- 入札カードに `trade_wantable` を適用する。
- 入札は1種類 × 枚数（1〜10）。
- 選択期間は72時間。
- 成立不能な入札は、期限後でも入札者が取り下げられる。

## 11. 計画レビュー（2026-10-14）の反映
| 指摘 | 対応 |
|---|---|
| M1 トリガー由来の 23505 が 500 になる | 専用ロックテーブルをやめ、トリガーは P0001 `TRADE_CARD_LOCKED` を出す。新アプリは `TRADE_CARD_ALREADY_LISTED` にマップ。旧アプリの 500 は互換性注記 |
| M2 拘束取得経路の直列化が無い | 全経路で `user_cards` FOR UPDATE → 所有再確認 → `trade_copy_locked` |
| M3 `now()` 固定による境界誤判定 | ロック取得後に `clock_timestamp()` で判定し、status も再確認 |
| M4 offer の DELETE で孤児ロック | 専用テーブルを作らないので発生しない |
| M5 バックフィル順序・lock_timeout | バックフィル不要。`SET LOCAL lock_timeout` を設定 |
| M6 migration 窓で既存画面が壊れる | 42P01/42883 フォールバック、オークション API は 503、mine は別エンドポイント |
| M7 入札0件で72時間拘束 | 入札0件ならいつでも取消可。期限到来時点で流札 |
| M8 入札カードの公開範囲・成立時の再検証 | 入札の中身は本人だけに表示。入札時に可視性・有効性・wantable、成立時に有効性・wantable・設定を再確認（成立時の可視性は §12 の理由で再確認しない） |
| M9 より単純な代替 | 採用（§4.1） |
| 任意: FK・インデックス、上限の共用、page 方式、withdraw の request_id 不要、同種別入札の禁止、クロスの見つけ方 | §1・§4・§5 に反映 |

## 12. PR-1 実装時に確定・変更した点（2026-10-17）

実装は `db/planetscale/migrations/20261018030000_trade_auctions.sql`、`src/lib/trade.ts`、`src/lib/trade-auction.ts`、`src/app/api/trades/auctions/**`。§4〜§5 からの変更と、設計書で未確定だった点の決定を記録する。

| 項目 | 設計（§4〜§5） | 実装 | 理由 |
|---|---|---|---|
| 拘束判定の関数 | `trade_copy_locked` 1つ | `trade_copy_auction_locked`（オークション・入札だけ）と `trade_copy_locked`（＝通常出品 OR 前者）の2つ | トリガーが `trade_copy_locked` を使うと、通常出品どうしの重複まで `TRADE_CARD_LOCKED` になり、旧アプリが知っている 23505 → `ALREADY_LISTED` の挙動が変わる。トリガーは前者だけを見て、重複は部分UNIQUE に任せる（§4.1 の意図どおり） |
| 関数の volatility | `STABLE` | `VOLATILE` | `clock_timestamp()` は VOLATILE。STABLE と宣言すると同じ文の中で結果を使い回してよいことになるため |
| トリガーの所有確認 | 所有を再確認する | 行があり、所有者が出品者と違えば P0001 `TRADE_CARD_NOT_OWNED`。行そのものが無い（削除済み）場合は通す | 他人のコピーを通常出品で拘束させない（新所有者が取り消せなくなる）ことが目的。行が無い場合は誰のコピーも拘束せず、従来どおり応諾時に `OFFER_INVALID` で cancelled になる。既存の `tests/fixtures/add-card-trading-postgres.sql` は存在しないコピーの出品を INSERT しており、既存契約を変えないため |
| 入札時の可視性 | RPC で確認 | アプリ層の事前チェック（`precheckBidVisibility`）で、既存の `cardVisibleTo` を SQL のまま再利用 | 可視性規則を PL/pgSQL に二重実装しない（計画レビュー M8 の「既存規則の再利用」）。accept の `precheckTradeAccept` と同じ分担で、RPC は所有・ロック・時刻・設定・有効性・wantable を持つ |
| 成立時の可視性 | 再確認する | 再確認しない（有効性・wantable・設定・所有は RPC がロック下で再確認する） | 出品者は入札時に可視性規則を満たした入札の中身を既に見ており、成立で入札カードは出品者へ移る。後から可視性が変わっても守るものが無く、再確認すると「出品者は選べず、入札者も取り下げられない」入札が生じる |
| 成立不能の判定 | settle と withdraw に個別 | `trade_auction_bid_unsettleable_reason(bid_id)` に一本化し、settle・withdraw・詳細 API の `settleable` が同じ関数を使う | 「出品者が選べない入札」と「入札者が取り下げられる入札」を常に一致させるため。所有コピーの欠落（削除・移動）も成立不能に含める |
| 取消・取り下げと選択期限後 | 未記載 | 選択期限後（導出上の流札）は、有効入札があっても取消でき、取り下げもできる | どちらも全カード解放済みで、記録を変えるだけで害が無い（マイトレードの整理用） |
| 入札変更の失敗時 | 未記載 | 旧入札のコピーを再利用できるものとして選定し、検証がすべて通ってから旧入札を withdrawn にして新入札を INSERT する | JSONB エラーを返すとトランザクションは commit されるため、先に withdrawn にすると「変更に失敗したのに旧入札が消える」ことになる |
| 未知ユーザー | 未記載 | RPC は JSONB `USER_NOT_FOUND` を返し、API は 401 `UNAUTHORIZED` | セッションがあるのに users 行が無い場合だけで、500 にする理由が無い |
| オークション作成時の設定ゲート | 設定ゲート | 出品カードの配信者の `trade_enabled` だけ | オークションは出品時点では相手のチャンネルが決まらない。クロスチャンネルの可否は入札時に両配信者の設定で判定する |
| クロスタブ | 既存ボードと同じ規則 | 配信者 X のボードのクロスタブ = X 以外のチャンネルのオークションで、X と出品チャンネルの両方が `trade_enabled` と `cross_channel_trade_enabled` を許可しているもの | オークションには「求」側が無い。X のカードで入札できるオークションを出すのが、通常のクロスタブ（X に関わる出品）に相当する |
| マイトレード API | `/api/trades/auctions/mine` | `?role=selling\|bidding&page=`（既定 selling）。bidding は自分の非 withdrawn 入札があるオークション。入札の状態は `active / won / lost / released`（`released` = active のまま親が拘束しなくなった） | UI（PR-2）の2タブにそのまま対応させる |
| 取り下げ API | `/bids/[bidId]/withdraw` | パスの `[id]` は URL の形だけで、RPC は入札から親オークションを引く（ロック順 オークション → 入札） | 設計どおり request_id 不要。所有者確認は RPC が行う |
| エラーコード | 追加する | `TRADE_AUCTION_UNAVAILABLE`(503) / `TRADE_AUCTION_NOT_FOUND`(404) / `TRADE_AUCTION_NOT_OPEN` / `TRADE_AUCTION_STILL_BIDDING` / `TRADE_AUCTION_EXPIRED` / `TRADE_AUCTION_HAS_BIDS` / `TRADE_AUCTION_SELF_BID`(400) / `TRADE_AUCTION_BID_NOT_FOUND`(404) / `TRADE_AUCTION_BID_NOT_ACTIVE` / `TRADE_AUCTION_BID_LOCKED` / `TRADE_AUCTION_BID_LIMIT` / `TRADE_AUCTION_BID_INVALID` / `TRADE_BID_CARD_UNAVAILABLE`(400) / `TRADE_BID_CARD_NOT_WANTABLE` / `TRADE_NOT_ENOUGH_CARDS`（無印は 409）。ja/en 文言あり | ステータスは `src/lib/trade-api.ts` の `TRADE_AUCTION_ERROR_STATUS` に一元化 |
| 既知の情報ビット | — | 入札カードが出品者に見えない場合も `TRADE_BID_CARD_UNAVAILABLE` を返す。入札者は「出品者がそのカードを持っていない（非公開チャンネル）」ことを1ビット知りうる。カード名は漏れない | 拒否しないと入札の中身が出品者への名前の漏えい経路になるため、こちらを優先した |

### 12.1 独立レビュー（PR #1850）の必須指摘 M1 の反映（2026-10-18）

期限の境界で拘束の排他が破れる問題を、ロック取得「後」の時刻の再判定で塞いだ。§4.4 の「時刻判定はオークション行のロック取得後」を、**時刻判定より後に取るすべての行ロックの後にも再判定する**、に強める。

| 指摘 | 対応 |
|---|---|
| (a) 入札が出品コピーをロックしない。締切直前に始まった入札が締切後に commit するまでの間に、出品者が同じコピーを通常出品できる（入札0件で締切済みとして、トリガーが通してしまう） | `place_trade_auction_bid` のロック集合に `offered_user_card_id` を加え、入札者のコピーと合わせて id 昇順で取る。ロック後に `clock_timestamp() < ends_at` を再判定する。トリガーは同じ行を待ってから判定するので、選択待ちの拘束を見て拒否する |
| (b) 成立が時刻判定の後、コピーのロック待ちの間に選択期限を越えうる。その間に、同じ入札コピーで別オークションへの入札が成功する | `settle_trade_auction` は、全コピーをロックした後に `selection_deadline` を再判定し、`AUCTION_EXPIRED` を返す |
| 任意1 | 成立の防御を、通常出品だけでなく、他のオークション・他の有効入札による拘束（自分自身の拘束は除く）にも広げた |
| 任意5 | 入札は、ロック後に出品者がまだ出品コピーを所有していること（と通常出品に使われていないこと）を確認する。満たさなければ `AUCTION_NOT_OPEN` |

回帰テスト: `tests/fixtures/trade-auction-concurrency.sh` の S7（a）と S8（b）。修正前の migration で失敗し、修正後に通ることを実測した。並行テストの順序制御は、固定の sleep から `pg_stat_activity` のポーリングに変えた。固定 sleep では、接続1の起動が遅れると S4 が逆順になり、偽陽性で失敗することがあったため。

テスト（§8 の PR-1 分）:
- 実PG統合: `tests/integration/trade-auction-pg.test.ts`（CI 登録済み）。
- 2接続の並行: `tests/fixtures/trade-auction-concurrency.sh`（CI 登録済み）。S4 は、settle の時刻判定を `now()` に置き換えると失敗することを確認済み（判定がロック取得後の `clock_timestamp()` であることの回帰ガード）。
- migration 窓: `tests/unit/trade-service.test.ts`（42P01/42883 での縮退）、`tests/unit/trade-auction-service.test.ts` / `tests/unit/trade-auction-api.test.ts`（503）。
- accept の差分固定: `tests/unit/trade-auction-migration.test.ts`。

## 13. PR-2（UI）実装時に確定・変更した点（2026-10-18）

実装は `src/app/trade/[streamerId]/page.tsx`（タブ）、`src/app/trade/[streamerId]/auctions/[auctionId]/page.tsx`（詳細）、`src/components/TradeAuction*.tsx`・`MyTradeAuctions.tsx`・`TradeCardChoiceList.tsx`、`TradeCreateForm.tsx`（出品形式の選択）、`MyTrades.tsx`（タブ）、`src/lib/use-trade-list.ts`（型パラメータ化）、`src/lib/trade-client.ts`。API・DB・RPC は変更していない。

| 項目 | 設計（§4.6・§6） | 実装 | 理由 |
|---|---|---|---|
| ボードのタブ | 「オークション」タブを追加 | `?tab=auction` を `?scope=cross` と直交させ、オークションタブの中に「このチャンネル / 他チャンネル」のサブタブを置く（クロス許可時のみ）。サブタブは `GET /api/trades/auctions` の `scope` にそのまま対応 | 既存の in_channel / cross の2タブ構造と API の scope を崩さずに、クロスチャンネルのオークションも辿れるようにするため。タブを4つ並べるより 375px で収まる |
| migration 未適用の窓 | タブと導線を出さない | タブと出品形式の選択は常に出し、オークション API が 503 `TRADE_AUCTION_UNAVAILABLE` のとき、タブの中身（ボード・詳細・マイトレード）を「準備中」の表示にする。出品の送信が 503 なら既存のエラー文言（`errorTradeAuctionUnavailable`）を出す | タブを隠すにはボード描画ごとにサーバーでスキーマを確認する問い合わせが1本増える。窓はデプロイ時の短時間で、既存画面は別エンドポイントなので壊れない（指示の「または『準備中』」を採用） |
| オークション詳細 | ページかモーダルか未定 | ページ `/trade/[streamerId]/auctions/[auctionId]`。`[streamerId]` は入札に使うカードのチャンネル（ボードのチャンネル） | 入札のカード候補（`trade_wantable`・可視性を SQL で適用済み）をサーバーで用意する必要があり、出品フロー（ページ）と同じ構成にした。オークション本体は API から取得（rate limit と入札内容の開示規則を API に一本化） |
| 入札カード候補 | Step 2 の UI を再利用 | `listWantableCards`（wantable + 可視性）∩ 自分の所持コピー。拘束されていないコピー数（`freeCount`）を表示し、0枚・出品カードと同種は選べない。入札変更時は、変更前の入札と同じカードならその枚数も使える枚数に足す | 入札は自分のカードでしか出せないため未所持カードは出さない（名前も送らない）。RPC は変更前の入札のコピーを再利用するため |
| カード選択 UI | Step 2 を再利用 | Step 2 のタイル一覧を `TradeCardChoiceList` に切り出し、出品フローと入札フォームの両方で使う | 同じ見た目・`aria-pressed`・無効理由の `title` を保つため。どのカードを出すかは各フローが決める |
| 期限の初期値 | 未記載 | 初期選択なし（明示的に選ぶまで送信不可） | 期限はカードと全入札の拘束期間を決めるため |
| 取消ボタン | 入札0件なら取消可 | `status='open'` かつ有効入札0件のとき表示（期限前・期限後とも）。入札がある間はボタンを出さず理由を表示 | 仕様どおり。期限後の入札0件は導出上の流札だが、取消で記録を整理できる（§12） |
| 成立・取消・取り下げの場所 | 詳細で成立 | 3つとも詳細ページだけに置く。マイトレードの「選択待ち」には成立操作への目立つリンクを出す | 成立には入札一覧（出品者だけが詳細 API で受け取る）が必要。操作の入口を1か所にして二重送信の管理を単純にする |
| 二重送信 | 既存パターン | 操作中は詳細の全操作ボタンを無効化。入札は「カード + 枚数」に束縛した requestId（出品フローと同じ）、成立は入札ごとの requestId（応諾と同じ）を、成功まで保持して再送で再利用。取り下げ・取消は状態冪等なので requestId なし（API どおり） | 通信断の後の再送を冪等リプレイにするため |
| 書き込み後の更新 | 未記載 | 通信断以外の応答（成功・拒否とも）の後に、詳細を再取得し、一覧キャッシュを破棄し、`router.refresh()` で入札候補の空き枚数を更新する | 拒否（期限切れ等）は表示が古いことを意味するため。境界判定はサーバーに任せ、失敗はエラー文言で案内する |
| 一覧キャッシュ | `use-trade-list` のパターン | `useTradeList` を型パラメータ化し、`rowsKey: "auctions"` と 503 の `unavailable` を追加して再利用（ボードは shared + viewerKey、マイトレードは mount 単位） | 2つ目のキャッシュ実装を作らない。オークションの行も viewer 固有（`isOwnAuction`・`myBid`）なので viewerKey の名前空間が必要 |
| 時刻表示 | クライアントで相対表示 | 「残りX日Y時間 / X時間Y分 / X分 / まもなく締切」を30秒ごとに再計算。締切・選択期限の日時も併記 | 7日のオークションが作成直後に「残り6日」と切り捨てて見えないようにするため。表示だけで、境界はサーバーが判定する |
