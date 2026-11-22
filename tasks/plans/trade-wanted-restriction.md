# トレード: 交換対象の制限（出品カードごとのホワイトリスト）設計

状態: **設計ドラフト（Opus レビュー待ち）**／ 親: #715（トレード）／ 関連: #1790（`cards.trade_wantable`）、#1791（オークション）

> 現行 runtime は PlanetScale PostgreSQL 固定（`tasks/plans/README.md`）。本書は現行の DB helper（Drizzle + `withDbRetry`）と `db/planetscale/migrations` を前提にする。

## 1. 要望

配信者が、出品されるカードごとに「求む（交換対象）に指定できるカード」を制限できるようにする。

- 例: 出品 A のとき、交換対象に指定できるのは C のみ。
- トレード設定に「交換対象の制限」を追加し、ドロップダウンで登録済みカードを選ぶ。
- **ホワイトリスト方式**。A に C, D を指定したら、A の出品で指定できる交換対象は C と D だけになる。

## 2. 既存機能との関係（調査結果）

| 既存 | 内容 | 本機能との関係 |
|---|---|---|
| `cards.trade_wantable`（#1790） | 「このカードは**どの出品からも**求められない」を示すカード単位フラグ（ブラックリスト的）。`cardTradeSettings` 狭い定義で参照 | **直交**。本機能は「出品カード A → 許可する交換対象の集合」というペア単位の制約。判定は **両方を AND** |
| `TradeSettings.tsx` | `trade_enabled` / `cross_channel_trade_enabled` / `trade_unowned_card_names_visible` の3トグル（`POST /api/streamer/settings`） | 本機能の設定UIの置き場所。ただし既存API/列は boolean 列で、集合は載せない → **別テーブル・別API** |
| 判定箇所（#1790 で実装済みの5箇所） | ① `createTradeOffer`（出品時）② `listWantableCards`（選択肢）③ `tradeableStateFor`（ボード/マイトレードの表示可否）④ `precheckTradeAccept`（応諾の事前）⑤ `accept_trade_offer` RPC（応諾の最終判定） | 本機能も**同じ5箇所**に同じ形で足す。権威は ① と ⑤ |
| オークション（#1791） | 入札カードにも `trade_wantable` を適用（`place_trade_auction_bid` / `settle_trade_auction` / `trade_auction_bid_unsettleable_reason`） | 方針として**入札カードにも同じ制限を適用**（§9 フェーズ2） |

## 3. 仕様

### 3.1 ルールの意味
- ルール = 「出品カード A に対し、交換対象に指定できるカードの集合 W(A)」。
- **A にルールが無い（W(A) の行が0件）→ 制限なし**（現状と同じ。既存データは全て制限なし）。
- A にルールがある → 交換対象は W(A) のカードに限る。W(A) に無いカードを指定した出品・応諾は拒否。
- 判定キーは**出品側カード A の配信者**が持つ。A の配信者だけが W(A) を編集できる。
- 交換対象カード C 自身の `trade_wantable` / 公開範囲（`cardVisibleTo`）/ トレードON等の既存ゲートは**そのまま併用**。W(A) に入っていても C が `trade_wantable=false` なら拒否。

### 3.2 W(A) に入れられるカード
- **A と同じ配信者の、有効（`is_active = true`）なカード**のみ。A 自身は不可。
- 他配信者のカード（クロスチャネル）は W(A) に入れられない。結果として、**ルールのある A はクロスチャネルでは出品できない**（A の配信者は他チャネルのカード一覧を選べないため。「A の配信者が他配信者のカードを指定する」UI/認可は YAGNI として作らない）。
- 1ルールあたりの上限: `TRADE_WANTED_RESTRICTION_MAX_ITEMS = 100`。配信者あたりのルール数上限: 200（`TRADE_WANTED_RESTRICTION_MAX_RULES`）。DB 側の CHECK ではなくAPI層で検証（既存の `TRADE_MAX_OPEN_OFFERS` と同じ流儀）。

### 3.3 既存オファーへの影響（#1790 と同じ扱い）
- ルール追加・変更で条件を満たさなくなった**既存 open オファーは cancelled にしない**。ボードから非表示、応諾不可、出品者のマイトレードでは「応じられない出品」。ルールを戻せばそのまま復活する。
- 出品コピーの拘束（ロック）は変えない。

### 3.4 エラー
| 層 | コード | 備考 |
|---|---|---|
| 出品 API | `TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED`（HTTP 400/403 は `TRADE_WANTED_CARD_NOT_WANTABLE` と同じ） | `TRADE_WANTED_CARD_NOT_WANTABLE` の**後**に判定。可視性チェック後なので隠しカードの存在は漏れない |
| 応諾 RPC | `WANTED_CARD_NOT_ALLOWED_FOR_OFFERED`（新設） | 旧アプリは未知コードで 500 = 何も移転しない fail-closed（#1790 と同じ）。3引数互換ラッパーは `OFFER_NOT_OPEN` へ読み替え |
| 応諾 precheck | 既存 `TRADE_OFFER_UNAVAILABLE` に畳む | 「非公開 / 非アクティブ / 指定不可 / 制限外」を区別させない（#1790 と同じ秘匿方針） |

## 4. DB 設計

migration は最新+1本（`2026112xxxxxxx_trade_wanted_restrictions.sql`、`-- migration-transaction: required` / `-- migration-providers: planetscale`）。**expand のみ・加法的**。

```sql
CREATE TABLE public.trade_wanted_restrictions (
  offered_card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  wanted_card_id  uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  streamer_id     uuid NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE, -- 認可・一覧用の非正規化
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (offered_card_id, wanted_card_id),
  CONSTRAINT trade_wanted_restrictions_different_cards CHECK (offered_card_id <> wanted_card_id)
);
CREATE INDEX idx_trade_wanted_restrictions_streamer ON public.trade_wanted_restrictions (streamer_id);
-- 逆引き（C 削除時の CASCADE・C を含むルールの検索）用
CREATE INDEX idx_trade_wanted_restrictions_wanted ON public.trade_wanted_restrictions (wanted_card_id);
```

- 「A にルールがあるか」= `EXISTS (… WHERE offered_card_id = A)`、「C が許可か」= PK 検索。判定SQLは主キー索引だけで引ける。
- 同一配信者制約（A と C の `streamer_id` 一致）は**API層で検証**する。DB トリガーは置かない（複数テーブル参照のトリガーは既存でロック順の事故源になった経緯があり、書き込み経路は1本の API に限定できるため）。ただし RPC 側の判定は「W(A) に C がいる」だけを見るので、仮に他配信者のカードが入っても判定は壊れない。
- RLS/権限: 既存テーブルと同じく service_role のみ（`REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT … TO service_role`）。`db/planetscale/grants.sql` / `public-schema.sql` の更新を既存の流儀に合わせる。
- **`accept_trade_offer`（4引数版）を `CREATE OR REPLACE`**: 現行定義は `20261018030000_trade_auctions.sql`（拘束ロック込み）。**これを土台に**、`WANTED_CARD_NOT_WANTABLE` ブロックの直後（冪等リプレイ・枚数照合の後、行ロックより前）に1ブロックだけ足す:
  ```sql
  IF EXISTS (SELECT 1 FROM trade_wanted_restrictions WHERE offered_card_id = v_offer.offered_card_id)
     AND NOT EXISTS (SELECT 1 FROM trade_wanted_restrictions
                     WHERE offered_card_id = v_offer.offered_card_id
                       AND wanted_card_id  = v_offer.wanted_card_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'WANTED_CARD_NOT_ALLOWED_FOR_OFFERED');
  END IF;
  ```
  差分はこのブロックだけ。ロック順・冪等リプレイ・エラーJSONB方式は不変。`trade_wanted_restrictions` 行はロックしない（`trade_wantable` と同じ理由: 設定切替と並行した応諾は「切替の直前に成立した」のと区別できず、ロック順に行を加えるリスクの方が大きい）。
- 3引数互換ラッパーも同 migration で `CREATE OR REPLACE` し、新コードを `OFFER_NOT_OPEN` に読み替える。

### 4.1 migration とアプリの順序（デプロイ窓 #788）
CLAUDE.md の「アプリ先行が必要な migration は別リリース」規約に該当するか: **該当しない（migration 先行で安全）**。テーブル追加と RPC 差し替えだけで、旧アプリは新テーブルを参照せず、未知エラーコードも出ない（ルールが空なら新ブロックは通過する）。逆にアプリ先行のデプロイ窓では:
- 読み取り（出品判定・選択肢・ボード・precheck）: `42P01`（テーブル無し）で**制限なしへ縮退**（migration 前は制限が存在し得ないので近似ではなく正確）。`withTradeAuctionSchemaFallback` と同じ形のラッパー `withTradeWantedRestrictionFallback` を `trade.ts` に置き、既存の入れ子（auction → wantable → nameOnly）の最内に1段足す。
- 書き込み（設定API）: 保存不可で `tradeWantedRestrictionsSkippedDeployWindow` を返し、UI は楽観反映をロールバック（既存 `tradeSettingsSkippedDeployWindow` と同じ契約）。

## 5. アプリ側（`src/lib/trade.ts` 中心）

共通の SQL 断片を1つ足し、5箇所から使う（`cardIsWantable` と同じ位置・同じ形）:

```ts
/** offeredCardIdExpr のカードにルールが無い、または wantedCardIdExpr がそのルールの許可集合に入っている */
export function wantedAllowedForOffered(offeredCardIdExpr: AnyColumn | SQL, wantedCardIdExpr: AnyColumn, withoutRestrictions: boolean)
//  withoutRestrictions → TRUE（デプロイ窓）
//  NOT EXISTS (… WHERE r.offered_card_id = :offered) OR EXISTS (… WHERE r.offered_card_id = :offered AND r.wanted_card_id = :wanted)
```

| 箇所 | 変更 |
|---|---|
| `createTradeOffer`（`runChecks`） | `wantedAllowed` を 1 行の select 列として追加（追加クエリ無し）。`wantedWantable` の判定の直後に `TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED` を返す |
| `tradeableStateFor` | AND に `wantedAllowedForOffered(offered_card_id, wanted_card_id)` を追加（ボード・マイトレードの「応じられない出品」判定が共通なので1箇所） |
| `precheckTradeAccept` | `wantedAllowed` を select に足し、既存の `TRADE_OFFER_UNAVAILABLE` 条件へ合流 |
| `listWantableCards(twitchUserId, streamerId)` | **シグネチャは変えない**（返す一覧は従来どおり全 wantable）。代わりに §6 のとおり出品フォームへ「ルール表」を別途渡す |
| accept RPC | §4 |

### 5.1 出品フォームの絞り込み（UX）
出品フォームは「出品コピー選択 → 求めるカード選択」の2段で、`trade-create-flow.ts` が `ownedCopies` と `wantableCards` を**先に両方**サーバーで読む。出品コピー選択後に選択肢を絞るため:
- `trade-create-flow.ts` が `allowedWantedByOfferedCardId: Record<offeredCardId, string[]>` を追加で返す。対象は「ビューアーの出品可能コピー（`ownedCopies`）のカード」のうち**ルールを持つもの**だけ（1クエリ: `WHERE offered_card_id = ANY($ownedCardIds)`）。
- `TradeCreateForm` は選択中の出品コピーの `cardId` を引き、ルールがあれば `wantableCards` を W(A) との交差に絞る。ルールが無ければ従来どおり。
- 秘匿: 返すのは card id の配列のみで、名前・画像は既存の `wantableCards`（可視性フィルタ済み）経由でしか出ない。可視でないカードの id が W(A) にあっても、交差で落ちるので漏れない。
- クライアントの絞り込みは UI 補助。**権威は createTradeOffer / accept RPC**（#1790 と同じ）。
- W(A) との交差が空（許可カードが全て非公開/無効など）の場合は、「このカードには現在交換対象がありません」の案内を出し、出品ボタンを無効化。

## 6. 設定API・UI

### 6.1 API
`PUT /api/streamer/trade-wanted-restrictions`（新規 route。既存 `POST /api/streamer/settings` は boolean 列用なので拡張しない）。

```jsonc
// body
{ "streamerId": "...", "offeredCardId": "...", "allowedWantedCardIds": ["C", "D"] }  // [] = ルール削除（制限なしに戻す）
```
- 認可: 既存 `settings` route と同じ（セッションから配信者を解決し、`streamerId` が本人であること）。`offeredCardId` と全 `allowedWantedCardIds` が**その配信者の有効カード**であること、`offeredCardId` が `allowedWantedCardIds` に含まれないこと、上限内・重複なし、をAPI層で検証。他人のカード id は一律 404 相当（存在を漏らさない）。
- 書き込み: **1トランザクションで置換**（`DELETE WHERE offered_card_id = A` → `INSERT`）。最終状態を明示するので冪等（`withDbRetry` の idempotent）。部分更新（追加/削除差分）は並行編集で消し合うので採らない。
- メンテナンスモード・レート制限は既存 settings route と同じ扱い。
- `GET` は作らず、初期値は account ページの Server Component で `getStreamerCollectionSettings` と同じ流儀で取得（`dashboard-data.ts` に `getTradeWantedRestrictions(streamerId)` を追加。`{ cards: {id,name,rarity}[], rules: Record<offeredCardId, string[]> }`）。取得失敗は設定セクションの該当部分だけ非表示（アカウントページ全体を落とさない）。

### 6.2 UI（`TradeSettings.tsx` に「交換対象の制限」セクションを追加）
- 既存トグル群の下に見出し「交換対象の制限」＋説明（「出品されるカードごとに、求むに指定できるカードを限定できます。未設定のカードは制限なしです」）。
- **ルール一覧**: 行 = `[出品カードの名前（レアリティ）] → [許可カードのチップ…]` ＋「編集」「制限を解除」。
- **ルール追加/編集フォーム**:
  1. 「出品カード」ドロップダウン（`<select>`。未設定のカードのみ。編集時は固定）
  2. 「交換対象にできるカード」ドロップダウン（`<select>`で1枚ずつ選んで「追加」→チップ化、×で削除。出品カード自身は選択肢から除外）
  3. 「保存」（許可カードが0件のときは無効。解除は専用ボタン）
- 保存失敗・デプロイ窓 skip は既存パターンどおりメッセージ表示。保存済みの値は楽観更新後に失敗したら元へ戻す。
- 既存の `ToggleRow` 等の流儀・i18n（`messages/ja.json` / `en.json` の `tradeSettings.*`）に合わせる。`TradeSettingsMock`（ガイド）と `/guide/trade` に1段落追記。
- カード数が多い配信者（最大1000枚）向けに、`<select>` は `rarity_order, name` 順。検索付きコンボボックスは YAGNI（要望は「ドロップボックス」）。

## 7. セキュリティ・整合性チェックリスト
- 認可: 設定の編集は A の配信者のみ。A と C の所属配信者一致をAPIで強制（RPC の判定は集合所属のみ）。
- 情報露出: ルールの存在・内容は、出品フォーム用の id 配列（可視カードとの交差でしか効かない）以外は公開しない。ボード/ API に W(A) 全体を返さない。拒否理由は precheck で `TRADE_OFFER_UNAVAILABLE` に畳む。
- 原子性: 置換は1トランザクション。RPC は読み取りのみで新しいロックを持ち込まない。
- 冪等: 設定 PUT は最終状態を書く。出品/応諾の冪等リプレイは「検証より前」の既存順序を維持（レプライ時に制限判定を再評価しない）。
- 退行ガード: ルール0件の A は従来と完全に同じ結果になること（既存テストが無修正で通る）。
- カード削除: `ON DELETE CASCADE`。**C が削除され W(A) が空になると A は「制限なし」に戻る**（fail-open になる点。§8 の論点 1）。

## 8. レビューしてほしい論点
1. **fail-open の穴**: W(A) の最後のカードが削除（`cards` の hard delete）されると、ルールが消えて制限なしに戻る。対策案: (a) 許容して UI/ドキュメントに明記、(b) `trade_wanted_restrictions` にルール行テーブル（`offered_card_id PK, restricted=true`）を足して「ルール行あり＋許可0件 = 誰も指定できない」にする（fail-closed だがテーブル2枚）、(c) `cards` の無効化（`is_active=false`）は行を残すので既に fail-closed。どれが妥当か。
2. **クロスチャネル**: W(A) を同一配信者カードに限り、ルールのある A はクロスチャネル出品不可とする判断は妥当か。代案は他配信者のカードも W(A) に入れられるようにする（認可・UI が大きく増える）。
3. **オークション**: 入札カードにも同制限を適用する（フェーズ2）方針でよいか。`place_trade_auction_bid` / `settle_trade_auction` / `trade_auction_bid_unsettleable_reason` の3関数の差し替えが必要で、migration が大きい。
4. **`accept_trade_offer` の差し替え**: `grep -l accept_trade_offer db/planetscale/migrations/*` の結果、定義を持つ最新は `20261018030000_trade_auctions.sql`（`20261019000000_trade_auction_review_followups.sql` を含む以降の migration は差し替えていない。2026-11-22 時点で確認済み、実装前に再確認する）。差分1ブロック以外を触っていないことを migration テストで固定する方針で十分か。
5. **テーブル設計**: 複合PK＋2索引（§4）でよいか。`streamer_id` の非正規化は不要か（一覧は `cards` JOIN でも取れる）。
6. 抜けているチェックポイント（判定箇所 5 箇所以外で `cardIsWantable` / `trade_wantable` を使っている所がないか）。

## 9. 実装の分割

| PR | 内容 |
|---|---|
| PR-1 | migration（テーブル＋`accept_trade_offer` 4/3引数）、`trade.ts`（SQL断片・`createTradeOffer`・`tradeableStateFor`・`precheckTradeAccept`）、エラーコード/文言（`constants.ts`・`trade-api.ts`・`trade-client.ts`・route・`messages`）、migration テスト、PG 結合テスト（accept RPC） |
| PR-2 | 設定 API、`dashboard-data.ts` の取得、`TradeSettings` UI、出品フォームの絞り込み（`trade-create-flow` / `TradeCreateForm`）、ガイド更新 |
| PR-3（任意・要判断） | オークション入札への適用（3関数の差し替え） |

PR-1 → PR-2 の順なら、PR-1 単体では設定手段が無いので挙動は変わらない（安全にリリース可能）。

## 10. テスト計画
- 単体: `wantedAllowedForOffered` 断片、`createTradeOffer`（ルール無し=従来／許可内／許可外／`trade_wantable=false`との AND／デプロイ窓縮退）、`precheckTradeAccept`、`tradeableStateFor`、設定 API（認可・他人のカード・自己指定・上限・重複・空配列=解除・冪等・メンテナンス・デプロイ窓）、`TradeSettings`（追加・編集・解除・失敗ロールバック）、`TradeCreateForm`（絞り込み・交差が空）。
- migration テスト: `accept_trade_offer` の差分が1ブロックのみであること、3引数ラッパーの読み替え、grants。
- PG 結合テスト（`tests/integration/*-pg.test.ts` の流儀）: ルールあり/なしでの応諾、ルール変更後の既存オファーの応諾拒否→戻して復活、CASCADE。
- Preview 実経路: トレードは `docs/QA.md` の実経路ゲート対象（ガチャ/overlay/chat/upload）外。ブラウザで「ルール設定 → 許可外が選べない → 許可内で出品 → 別アカウントで応諾」を確認する（本番アカウントを変更する操作は CLAUDE.md の制約に従い、preview の検証用データで行う）。

## 11. YAGNI として今回やらないこと
- 交換対象側 C からの制限（「C は A の出品でしか求められない」）、ブラックリスト方式、レアリティ単位の一括ルール、ルールのコピー/一括編集、検索付きコンボボックス、クロスチャネルの許可集合、ルール変更の履歴・通知。
