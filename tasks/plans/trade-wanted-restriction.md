# トレード: 交換対象の制限（出品カードごとのホワイトリスト）設計

状態: **設計 v3（オーナー確認済み・実装着手可。Opus レビューの必須指摘 M1〜M5 反映済み。§12・§13 参照）**／ 親: #715（トレード）／ 関連: #1790（`cards.trade_wantable`）、#1791（オークション）

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
| 判定箇所（#1790 で実装済みの**6箇所**） | ① `createTradeOffer`（出品時）② `listWantableCards`（選択肢）③ **`openOfferConditions`**（ボード `listTradeOffers` とコレクション別ハブ `listTradeOffersByCollection` の絞り込み）④ `tradeableStateFor`（`listMyTradeOffers` のみ）⑤ `precheckTradeAccept`（応諾の事前）⑥ `accept_trade_offer` RPC（応諾の最終判定） | 本機能も**同じ6箇所**に同じ形で足す。権威は ① と ⑥ |
| オークション（#1791） | 入札カードにも `trade_wantable` を適用（`place_trade_auction_bid` と `trade_auction_bid_unsettleable_reason`。`settle_trade_auction` は後者を呼ぶだけ） | **入札カードにも同じ制限を適用する（必須。設定UIより前か同時にリリース）**。§9 |

## 3. 仕様

### 3.1 ルールの意味
- ルール = 「出品カード A に対し、交換対象に指定できるカードの集合 W(A)」。
- **A にルール（親ルール行）が無い → 制限なし**（現状と同じ。既存データは全て制限なし）。
- A にルール（親ルール行）がある → 交換対象は W(A) のカードに限る。**許可カードが0件でも「ルールあり」のまま = 誰も指定できない（fail-closed）**。W(A) に無いカードを指定した出品・応諾は拒否。
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
| 出品 API | `TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED`（HTTP は `TRADE_WANTED_CARD_NOT_WANTABLE` と同じ 409） | `TRADE_WANTED_CARD_NOT_WANTABLE` の**後**に判定。可視性チェック後なので隠しカードの存在は漏れない |
| 応諾 RPC | `WANTED_CARD_NOT_ALLOWED_FOR_OFFERED`（新設。`accept/route.ts` の対応表で `TRADE_OFFER_UNAVAILABLE`/409、`TRADE_ACCEPT_RPC_ERRORS` と #1801 旧アプリ差分テストにも追加） | 旧アプリは未知コードで 500 = 何も移転しない fail-closed（#1790 と同じ）。3引数互換ラッパーは `OFFER_NOT_OPEN` へ読み替え |
| 応諾 precheck | 既存 `TRADE_OFFER_UNAVAILABLE` に畳む | 「非公開 / 非アクティブ / 指定不可 / 制限外」を区別させない（#1790 と同じ秘匿方針） |

## 4. DB 設計

migration は最新+1本（`2026112xxxxxxx_trade_wanted_restrictions.sql`、`-- migration-transaction: required` / `-- migration-providers: planetscale`）。**expand のみ・加法的**。GRANT は既存の流儀どおり migration 末尾に書く（`grants.sql` / `public-schema.sql` に trade 系は無い）。

**親（ルール）+ 子（許可カード）の2テーブル**にする。理由: (1) 子0件でも「ルールあり = 誰も指定できない」を表せる（カード物理削除 `deleteCardPg` で W(A) の最後のカードが消えても制限が外れない = fail-closed）、(2) 親行が設定更新の直列化ロック行になる（§6.1）。

```sql
CREATE TABLE public.trade_wanted_restriction_rules (
  offered_card_id uuid PRIMARY KEY REFERENCES public.cards(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.trade_wanted_restriction_items (
  offered_card_id uuid NOT NULL REFERENCES public.trade_wanted_restriction_rules(offered_card_id) ON DELETE CASCADE,
  wanted_card_id  uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (offered_card_id, wanted_card_id),
  CONSTRAINT trade_wanted_restriction_items_different_cards CHECK (offered_card_id <> wanted_card_id)
);
-- C 削除時の CASCADE が全件走査にならないための逆引き索引（必須）
CREATE INDEX idx_trade_wanted_restriction_items_wanted ON public.trade_wanted_restriction_items (wanted_card_id);
```

- 判定: 「ルールあり」= 親行の存在、「C が許可」= 子 PK 検索。ルール一覧は `cards` JOIN で配信者ごとに引ける（`streamer_id` の非正規化はしない）。
- **拒否 = ルールあり + 子に (A, C) なし**。**ルールなし → 通過**。
- 同一配信者制約（A と C の `streamer_id` 一致）は**API層で検証**（DBトリガーは置かない）。RPC の判定は集合所属のみを見るので、他配信者のカードが入っても判定は壊れない。
- 権限は既存テーブルと同じく service_role のみ（`REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT … TO service_role`）。
- **`accept_trade_offer`（4引数版）を `CREATE OR REPLACE`**: 土台は現行定義の `20261018030000_trade_auctions.sql`（拘束ロック込み。以降の migration は差し替えていない。実装前に再確認）。`WANTED_CARD_NOT_WANTABLE` ブロックの直後（冪等リプレイ・枚数照合の後、行ロックより前）に**1つの IF 式（1スナップショット）**で足す:
  ```sql
  IF EXISTS (SELECT 1 FROM public.trade_wanted_restriction_rules WHERE offered_card_id = v_offer.offered_card_id)
     AND NOT EXISTS (SELECT 1 FROM public.trade_wanted_restriction_items
                     WHERE offered_card_id = v_offer.offered_card_id
                       AND wanted_card_id  = v_offer.wanted_card_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'WANTED_CARD_NOT_ALLOWED_FOR_OFFERED');
  END IF;
  ```
  差分はこのブロックだけ（migration テストで固定）。ロック順・冪等リプレイ・エラーJSONB方式は不変。ルール行/子行はロックしない（`trade_wantable` と同じ理由）。
- **3引数互換ラッパー**は `20261014100000_card_trade_wantable.sql:286-305` が最新定義なので、これを土台に `IN (...)` へ新コードを加えて `OFFER_NOT_OPEN` に読み替える。
- **オークション**: `place_trade_auction_bid` と `trade_auction_bid_unsettleable_reason`（`settle_trade_auction` は後者を呼ぶだけで差し替え不要）を同 migration で `CREATE OR REPLACE`。入札カードが「オークションの出品カード A のルール」の許可集合に入っていなければ、入札は `BID_CARD_NOT_ALLOWED_FOR_OFFERED`、成立不能判定は同理由（入札者は取り下げ可能 = 既存の「成立不能な入札」仕様に合流）。差分は各関数1ブロックのみ。

### 4.1 migration とアプリの順序（デプロイ窓 #788）
CLAUDE.md の「アプリ先行が必要な migration は別リリース」規約に該当するか: **該当しない（migration 先行で安全）**。テーブル追加と RPC 差し替えだけで、旧アプリは新テーブルを参照せず、未知エラーコードも出ない（ルールが空なら新ブロックは通過する）。逆にアプリ先行のデプロイ窓では:
- 運用の正本は「DB先行適用」（`docs/QA.md`「migrationとアプリの適用順序」）。**PR-1 実装時の決定: アプリ側のデプロイ窓フォールバックは入れない**（migration は main/preview への push で即時適用されアプリより先に入る。6 関数に入れ子を増やす負担と YAGNI を優先。`wantedAllowedForOffered` のコメントに明記）。アプリ先行になった場合は新テーブル無し（42P01）で出品・ボードが一時的にエラーになるが、migration 適用後に自然復旧する。設定 API（PR-2）は未適用時 503 を返す。
- 書き込み（設定API）: 保存不可で `tradeWantedRestrictionsSkippedDeployWindow` を返し、UI は楽観反映をロールバック（既存 `tradeSettingsSkippedDeployWindow` と同じ契約）。

## 5. アプリ側（`src/lib/trade.ts` 中心）

共通の SQL 断片を1つ足し、6箇所から使う（`cardIsWantable` と同じ位置・同じ形）:

```ts
/** offeredCardIdExpr のカードにルール（親行）が無い、または wantedCardIdExpr がそのルールの許可集合（子行）に入っている */
export function wantedAllowedForOffered(offeredCardIdExpr: AnyColumn, wantedCardIdExpr: AnyColumn)
//  NOT EXISTS (… WHERE r.offered_card_id = :offered) OR EXISTS (… WHERE r.offered_card_id = :offered AND r.wanted_card_id = :wanted)
```

| 箇所 | 変更 |
|---|---|
| `createTradeOffer`（`runChecks`） | `wantedAllowed` を 1 行の select 列として追加（追加クエリ無し）。`wantedWantable` の判定の直後に `TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED` を返す |
| `openOfferConditions`（ボード・ハブ） | `cardIsWantable` の隣に `wantedAllowedForOffered` を AND（フォールバックは入れない。§4.1） |
| `tradeableStateFor`（マイトレード） | 同じ断片を AND に追加（`listMyTradeOffers` のみが使う） |
| `precheckTradeAccept` | `wantedAllowed` を select に足し、既存の `TRADE_OFFER_UNAVAILABLE` 条件へ合流 |
| `listWantableCards(twitchUserId, streamerId)` | **シグネチャは変えない**（返す一覧は従来どおり全 wantable）。代わりに §6 のとおり出品フォームへ「ルール表」を別途渡す |
| accept RPC・オークション2関数 | §4 |

### 5.1 出品フォームの絞り込み（UX）
出品フォームは「出品コピー選択 → 求めるカード選択」の2段で、`trade-create-flow.ts` が `ownedCopies` と `wantableCards` を**先に両方**サーバーで読む。出品コピー選択後に選択肢を絞るため:
- `trade-create-flow.ts`（`loadTradeCreateFormData`）が `allowedWantedByOfferedCardId: Record<offeredCardId, string[]>` を追加で返す。対象は「ビューアーの出品可能コピー（`ownedCopies`）のカード」のうち**ルールを持つもの**だけ（1クエリ: 親 JOIN 子、`offered_card_id = ANY($ownedCardIds)`）。
- **交差はサーバー側で取る**: 返す配列は W(A) ∩ `wantableCards` の id 集合のみ。RSC props はクライアントへ直列化されるため、非公開カードの id・件数を含めない（`trade-create-flow.ts` の「hidden card names/images are never serialized into the client props」不変条件の維持）。「ルールなし = キー無し」と「ルールあり・交差空 = `[]`」は区別して返す（後者は出品不可の案内に使う）。
- `TradeCreateForm` は選択中の出品コピーの `cardId` を引き、キーがあれば `wantableCards` をその配列に絞る。無ければ従来どおり。
- オークションの入札候補（`TradeAuctionDetail.tsx` の `listWantableCards` 流用）にも同じ交差を適用する。
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
- 書き込み: **1トランザクションで置換**。先に親行を `INSERT … ON CONFLICT (offered_card_id) DO UPDATE SET updated_at = now()` で**取得・ロック**してから、子を `DELETE WHERE offered_card_id = A` → `INSERT`。親行ロックで同一 A への並行 PUT が直列化され「後勝ちの最終状態」になる（READ COMMITTED で DELETE→INSERT だけだと、並行時に和集合になる／23505 で 500 になる。`withDbRetry` は 23505 を再試行しない）。配信者あたりのルール上限の検査も同トランザクション内。最終状態を明示するので冪等。部分更新（差分）は採らない。
- `[]` の意味: **ルール削除（親行ごと削除 = 制限なしに戻す）**。「ルールは残して誰も指定不可」は UI から作らない（カード削除で自然に起きる状態としてのみ存在し、UI は「指定できるカードがありません」と警告して編集を促す）。
- 検証: W に `is_active=true` を必須にすると、後から無効化された C を含む既存ルールが再保存できなくなる。**保存時は同一配信者のカードなら無効でも許可**し、UI は「無効」チップとして外せるようにする（実行時は `cardIsActive` で落ちる）。
- CSRF（`validateCSRFToken`）と `canUseStreamerFeatures` を既存 settings route と同様に適用。
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
- 原子性: 置換は1トランザクション＋親行ロックで直列化。RPC は読み取りのみで新しいロックを持ち込まない。
- 冪等: 設定 PUT は最終状態を書く。出品/応諾の冪等リプレイは「検証より前」の既存順序を維持（レプライ時に制限判定を再評価しない）。
- 退行ガード: ルールの無い A は従来と完全に同じ結果になること（既存テストが無修正で通る）。
- カード削除: C が削除されると子行が CASCADE で消えるが、親行は残るので W(A) が空になっても**制限は外れない（fail-closed）**。A が削除されると親・子とも消える。

## 8. レビュー論点の結論（Opus レビュー反映）
1. fail-open → **親子2テーブルで fail-closed**（§4）。
2. クロスチャネル → W(A) は同一配信者カードのみ、ルールのある A はクロスチャネル不可。UI 文言で明示。出品フォームでは、クロスチャネルの want を選んだ後にルールのある A のコピーを選択前に無効表示にする。
3. オークション → **必須**。設定UIより前か同時にリリース。差し替えは2関数。
4. `accept_trade_offer` 差し替え → 方針どおり。差分1ブロックを migration テストで固定（`trade-auction-migration.test.ts` と同方式）。
5. テーブル設計 → 親子2枚。`streamer_id` 非正規化なし、`wanted_card_id` 索引は必須。
6. 判定箇所の漏れ → `openOfferConditions` とオークション入札候補（§2・§5 に反映）。通知・監査（`getTradeOfferAuditParticipants`）は影響なし。

## 9. 実装の分割

| PR | 内容 |
|---|---|
| PR-1（実装済み: migration `20261123000000_trade_wanted_restrictions.sql`、実PG結合テストで検証） | migration（親子テーブル、`accept_trade_offer` 4/3引数、オークション2関数）、`trade.ts`（SQL断片・6判定箇所）、`trade-auction.ts` のエラー対応、エラーコード/文言（`constants.ts`・`trade-api.ts`・`trade-client.ts`・route 対応表・`TRADE_ACCEPT_RPC_ERRORS`・#1801 旧アプリ差分テスト）、migration テスト、PG 結合テスト。**設定手段が無いのでユーザー向け挙動は変わらない** |
| PR-2 | 設定 API、`dashboard-data.ts` の取得、`TradeSettings` UI、出品フォーム／オークション入札候補の絞り込み（サーバー側交差）、ガイド更新 |

オークション適用を PR-1 に含めることで、PR-2 で UI を公開した時点で通常出品・オークションの両方が制限される。

## 10. テスト計画
- 単体: `wantedAllowedForOffered` 断片、**ボード・ハブ・マイトレード・precheck で同じオファーの可否が一致する**ケース、`createTradeOffer`（ルール無し=従来／許可内／許可外／`trade_wantable=false`との AND／デプロイ窓縮退）、`precheckTradeAccept`、`tradeableStateFor`、設定 API（認可・他人のカード・自己指定・上限・重複・空配列=解除・冪等・メンテナンス・デプロイ窓）、`TradeSettings`（追加・編集・解除・失敗ロールバック）、`TradeCreateForm`（絞り込み・交差が空）。
- migration テスト（既存データ保全）: 新migrationに `DROP` / `ALTER TABLE`（既存テーブル）/ `UPDATE` / `DELETE` / `TRUNCATE` が無く、操作が「新2テーブルの CREATE・索引・GRANT・既存関数の `CREATE OR REPLACE`」だけであることを固定する。
- migration テスト: `accept_trade_offer` の差分が1ブロックのみであること、3引数ラッパーの読み替え、grants。
- PG 結合テスト（`tests/integration/*-pg.test.ts` の流儀）: ルールあり/なしでの応諾、ルール変更後の既存オファーの応諾拒否→戻して復活、CASCADE。
- Preview 実経路: トレードは `docs/QA.md` の実経路ゲート対象（ガチャ/overlay/chat/upload）外。ブラウザで「ルール設定 → 許可外が選べない → 許可内で出品 → 別アカウントで応諾」を確認する（本番アカウントを変更する操作は CLAUDE.md の制約に従い、preview の検証用データで行う）。

## 11. YAGNI として今回やらないこと
- 交換対象側 C からの制限（「C は A の出品でしか求められない」）、ブラックリスト方式、レアリティ単位の一括ルール、ルールのコピー/一括編集、検索付きコンボボックス、クロスチャネルの許可集合、ルール変更の履歴・通知。

## 12. Opus レビュー（2026-11-22）の反映記録
必須 M1〜M5 を反映（実コードで裏取り済み）。
- M1 判定箇所は6箇所（ボード/ハブは `openOfferConditions`）→ §2・§5
- M2 設定 PUT の並行実行 → 親行ロックで直列化 → §6.1
- M3 カード物理削除による fail-open → 親子2テーブル → §4
- M4 非公開カード id の props 露出 → サーバー側交差 → §5.1
- M5 オークション未対応だと素通り → 必須化・PR-1 に統合 → §4・§9
任意指摘（3引数ラッパーの土台、HTTP 409、grants の流儀、42P01 のテーブル名限定、無効カードの再保存、CSRF、クロスチャネルUX、1 IF 式）も上記へ反映済み。

## 13. オーナー確認済み事項（2026-11-22）
- **クロスチャネル**: W(A) は A と同じ配信者のカードのみ。ルールのある A はクロスチャネルで出品できない（§3.2）。→ 了承。
- **オークション**: 通常出品と**同じ設定**（出品カード A ごとの許可集合）を入札カードにも適用する。別設定は設けない（§4・§9。PR-1 に含める）。→ 必須と確定。
- **既存データ**: migration は加法的で、既存の設定・出品・入札・所持カードを変更しない。適用直後は全カード「制限なし」。保全はテストで固定する（§10）。ルール追加後に条件外となった既存オファー／入札は cancel せず、非表示・応諾不可（入札は取り下げ可）で、ルールを戻せば復活する（§3.3）。
