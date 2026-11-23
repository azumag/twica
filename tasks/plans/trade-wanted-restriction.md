# トレード: 交換対象の制限（配信者ごとの許可リスト）設計

状態: **設計 v4（配信者ごとに1リスト。v3 の出品カードごとのホワイトリストを置き換える）**／ 親: #715（トレード）／ 関連: #1790（`cards.trade_wantable`）、#1791（オークション）、#2116（v3 の実装。未リリース）

> 現行 runtime は PlanetScale PostgreSQL 固定（`tasks/plans/README.md`）。本書は現行の DB helper（Drizzle + `withDbRetry`）と `db/planetscale/migrations` を前提にする。

## 1. 要望

配信者が「交換対象リスト」を1つだけ持ち、**自分のカードが出品されるとき**、求む（オークションでは入札カード）に指定できるカードをそのリストに限定できるようにする。

- 例: 配信者 S のリストが {C, D} のとき、S のカード A の出品では C と D だけを求むに指定できる。S の別のカード B の出品でも同じリストが適用される。
- **ホワイトリスト方式**。リストに無いカードを指定した出品・入札・応諾は拒否する。
- 通常の出品と、オークションの入札・成立の両方に適用する。

v3（#2116）は「出品カード A ごとに1リスト」だった。オーナー確認の結果、**配信者 S ごとに1リスト**へ仕様変更する。

## 2. 既存機能との関係（調査結果）

| 既存 | 内容 | 本機能との関係 |
|---|---|---|
| `cards.trade_wantable`（#1790） | 「このカードは**どの出品からも**求められない」を示すカード単位フラグ。`cardTradeSettings` の狭い定義で参照 | **直交**。本機能は「出品カードの配信者 S のリスト W(S) に、求めるカードが入っているか」という制約。判定は **両方を AND** |
| `TradeSettings.tsx` | `trade_enabled` / `cross_channel_trade_enabled` / `trade_unowned_card_names_visible` の3トグル（`POST /api/streamer/settings`） | 本機能の設定UIの置き場所。ただし既存API/列は boolean 列で、集合は載せない → **別テーブル・別API** |
| 判定箇所（#1790 で実装済みの**6箇所**） | ① `createTradeOffer`（出品時）② `listWantableCards`（選択肢）③ **`openOfferConditions`**（ボード `listTradeOffers` とコレクション別ハブ `listTradeOffersByCollection` の絞り込み）④ `tradeableStateFor`（`listMyTradeOffers` のみ）⑤ `precheckTradeAccept`（応諾の事前）⑥ `accept_trade_offer` RPC（応諾の最終判定） | 本機能も**同じ6箇所**に同じ形で足す。権威は ① と ⑥ |
| オークション（#1791） | 入札カードにも `trade_wantable` を適用（`place_trade_auction_bid` と `trade_auction_bid_unsettleable_reason`。`settle_trade_auction` は後者を呼ぶだけ） | **入札カードにも同じ制限を適用する（必須）**。§4 |
| 出品カード自身を求むにする操作 | `createTradeOffer` の `TRADE_SAME_CARD`（および `trade_offers_different_cards` CHECK）。オークションは `SAME_CARD` | v3 の「出品カード自身は許可に入れられない」規則は**廃止**するが、この既存判定は**変えない** |

## 3. 仕様

### 3.1 ルールの意味
- ルール = 「配信者 S が持つ交換対象リスト W(S)」。S は最大1つ。
- **S にルール（親ルール行）が無い → 制限なし**（従来どおり。既存データは全て制限なし）。
- S にルールがある → **S のカードが出品カードになるとき**、求める（入札）カードは W(S) のカードに限る。**許可カードが0件でも「ルールあり」のまま = 誰も指定できない（fail-closed）**。
- 判定キーは**出品カードの配信者**。出品カード id から `cards.streamer_id` を引き、その配信者のルールを見る。したがって同じ配信者の全カードに同じ W(S) が適用される。
- 交換対象カード C 自身の `trade_wantable` / 公開範囲（`cardVisibleTo`）/ トレードON等の既存ゲートは**そのまま併用**。W(S) に入っていても C が `trade_wantable=false` なら拒否。
- **カード物理削除でルールは外れない**: 親行は `streamers` に紐づくため、出品カードや許可カードを削除してもルール行は残る。許可カードを全部削除すると W(S) が空になり、誰も指定できない状態が続く（fail-closed）。

### 3.2 W(S) に入れられるカード
- **S 自身のカード**（有効・無効を問わない）。他配信者のカードは入れられない（API層で検証）。
- **出品カード自身を含められる**（v3 の `offered ≠ wanted` CHECK と「出品カード自身は選択肢に出ない」規則は廃止）。「自分自身を求むにして出品」は既存の `TRADE_SAME_CARD`（出品 API）と `SAME_CARD`（オークション入札）が止める。
- 保存時に無効（`is_active=false`）でも許可する（後から無効化されたカードを含むリストを再保存できなくしないため）。UI では「無効」チップとして表示し、外せる。
- 1リストあたりの上限: `TRADE_WANTED_RESTRICTION_MAX_ITEMS = 100`。**配信者あたりのルール数上限（旧 `TRADE_WANTED_RESTRICTION_MAX_RULES`）は廃止**（1配信者1リストのため）。DB の CHECK ではなく API層で検証（既存の `TRADE_MAX_OPEN_OFFERS` と同じ流儀）。
- クロスチャネル: W(S) は S のカードしか入らないため、ルールのある S のカードは他チャネルのカードとは交換に出せない（従来の仕様と同じ）。UI 文言でも明示する。

### 3.3 既存オファーへの影響（#1790 と同じ扱い）
- ルール追加・変更で条件を満たさなくなった**既存 open オファーは cancelled にしない**。ボードから非表示、応諾不可、出品者のマイトレードでは「応じられない出品」。ルールを戻せばそのまま復活する。
- 出品コピーの拘束（ロック）は変えない。

### 3.4 エラー
| 層 | コード | 備考 |
|---|---|---|
| 出品 API | `TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED`（HTTP 409） | `TRADE_WANTED_CARD_NOT_WANTABLE` の**後**に判定。可視性チェック後なので隠しカードの存在は漏れない |
| 応諾 RPC | `WANTED_CARD_NOT_ALLOWED_FOR_OFFERED`（既存コードを維持。`accept/route.ts` の対応表で `TRADE_OFFER_UNAVAILABLE`/409、`TRADE_ACCEPT_RPC_ERRORS` と #1801 旧アプリ差分テストにも登録済み） | 旧アプリは未知コードで 500 = 何も移転しない fail-closed（#1790 と同じ）。3引数互換ラッパーは `OFFER_NOT_OPEN` へ読み替え（コードは変わらない） |
| オークション | `BID_CARD_NOT_ALLOWED_FOR_OFFERED` / `TRADE_BID_CARD_NOT_ALLOWED_FOR_OFFERED` | v3 から変更なし |
| 応諾 precheck | 既存 `TRADE_OFFER_UNAVAILABLE` に畳む | 「非公開 / 非アクティブ / 指定不可 / 制限外」を区別させない（#1790 と同じ秘匿方針） |

## 4. DB 設計

migration は v3 の次（`20261124000000_trade_wanted_allowlist_per_streamer.sql`、`-- migration-transaction: required` / `-- migration-providers: planetscale`）。**expand のみ・加法的**。

**親（配信者のルール）+ 子（許可カード）の2テーブル**。v3 と同じ理由: (1) 子0件でも「ルールあり = 誰も指定できない」を表せる、(2) 親行が設定更新の対象になる。ただしキーは `streamer_id` にする。

```sql
CREATE TABLE public.trade_wanted_allowlist_rules (
  streamer_id uuid PRIMARY KEY REFERENCES public.streamers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.trade_wanted_allowlist_items (
  streamer_id uuid NOT NULL REFERENCES public.trade_wanted_allowlist_rules(streamer_id) ON DELETE CASCADE,
  wanted_card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (streamer_id, wanted_card_id)
);
-- 許可カード削除時の CASCADE が全件走査にならない逆引き索引（必須）
CREATE INDEX idx_trade_wanted_allowlist_items_wanted
  ON public.trade_wanted_allowlist_items (wanted_card_id);
```

- 判定: 「ルールあり」= 出品カードの `cards.streamer_id` に対する親行の存在、「C が許可」= 子 PK 検索。
- **拒否 = ルールあり + 子に (S, C) なし**。**ルールなし → 通過**。
- 同一配信者制約（S と C の `streamer_id` 一致）は**API層で検証**（DBトリガーは置かない）。RPC の判定は集合所属のみを見る。
- 権限は既存テーブルと同じく service_role のみ（`REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT … TO service_role`）。
- **`accept_trade_offer`（4引数版）を `CREATE OR REPLACE`**: 土台は v3 migration の最新定義。**制限の確認ブロックだけ**を、以下の形（出品カード → `cards.streamer_id` → ルール）へ置き換える。エラーコード・ロック順・冪等リプレイは不変。
  ```sql
  IF EXISTS (
       SELECT 1
       FROM public.cards AS restriction_offered_card
       JOIN public.trade_wanted_allowlist_rules AS restriction_rule
         ON restriction_rule.streamer_id = restriction_offered_card.streamer_id
       WHERE restriction_offered_card.id = v_offer.offered_card_id
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.cards AS restriction_offered_card
       JOIN public.trade_wanted_allowlist_items AS restriction_item
         ON restriction_item.streamer_id = restriction_offered_card.streamer_id
       WHERE restriction_offered_card.id = v_offer.offered_card_id
         AND restriction_item.wanted_card_id = v_offer.wanted_card_id
     ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'WANTED_CARD_NOT_ALLOWED_FOR_OFFERED');
  END IF;
  ```
  ルール行/子行はロックしない（`trade_wantable` と同じ理由）。1つの IF 式 = 1スナップショット。
- **3引数互換ラッパー**は v3 の読み替えコード（`WANTED_CARD_NOT_ALLOWED_FOR_OFFERED` → `OFFER_NOT_OPEN`）が同じなので、同一定義を `CREATE OR REPLACE` で再掲する（関数の差分はゼロ）。
- **オークション**: `place_trade_auction_bid` と `trade_auction_bid_unsettleable_reason` を同 migration で `CREATE OR REPLACE`。同じ形で、出品カード（`v_auction.offered_card_id`）の `cards.streamer_id` のルールを見る。`settle_trade_auction` は後者を呼ぶだけなので差し替え不要。
- 関数の差分（ブロック以外が v3 の最新定義と一致すること）は `tests/unit/trade-wanted-restriction-migration.test.ts` で固定する。

### 4.1 旧テーブルの扱い

v3 の `trade_wanted_restriction_rules` / `trade_wanted_restriction_items` は **本 migration では削除しない**。

- `docs/QA.md`「migrationとアプリの適用順序」の app-first 規約以前に、`db/planetscale/migrations` の追加migrationは `scripts/db-migrate.js` の非加法ガードで `DROP TABLE` を自動適用できない（`--allow-non-additive` と `APPROVED_CONTRACT_MIGRATIONS` のレビュー済み checksum 登録がない限りブロック）。`tests/unit/db-migrate-non-additive-scan.test.ts` も、承認リストに無い `DROP TABLE` を CI で失敗させる。
- 本 migration で `DROP TABLE` を入れると、その承認リスト追加と手動適用（contract フェーズ）が同一 PR に必要になり、範囲と危険が増える。旧テーブルは新 RPC・新アプリから参照しない置き去りにし、**本ブランチのリリース後（旧 migration が本番 DB に適用された後）に別 Issue（contract migration）で削除**する。
- データ移行は不要: #2116 は未リリースで、旧テーブルには preview の検証データしか無い。production には現時点で旧テーブルが無い（main 未適用）。本ブランチを main へ昇格すると v3 migration も同時に適用され、旧テーブルは**空のまま**作られるが、新 RPC・新アプリは参照しない。preview に残る旧行も新アプリからは見えない。
- `src/lib/db/schema.ts` には、DB に残る旧テーブルを `scripts/verify-db-schema.js` の双方向突き合わせで「DB にだけ存在するテーブル」と誤検出しないため、**削除までの間だけ**旧定義を【旧】コメント付きで残す。

### 4.2 migration とアプリの順序（デプロイ窓 #788）

- 本 migration はテーブル追加と RPC 差し替えだけで、旧アプリを壊さない（旧アプリは新テーブルを参照せず、新しいエラーコードも出ない）。**app-first ヘッダーは付けない**。
- 運用の正本は「DB先行適用」（`docs/QA.md`）。**アプリ側のデプロイ窓フォールバックは入れない**（v3 と同じ。`wantedAllowedForOffered` のコメントに明記）。アプリ先行になった場合は新テーブル無し（42P01）で出品・ボードが一時的にエラーになるが、migration 適用後に自然復旧する。設定 API は未適用時 503 を返す。
- 移行中（v3 アプリが動いている間）に v3 の設定 UI で旧テーブルへ書いた内容は新 RPC では使われない。v3 は未リリースで、preview の検証データだけなので移行しない。

## 5. アプリ側（`src/lib/trade.ts` 中心）

共通の SQL 断片 `wantedAllowedForOffered(offeredCardIdExpr, wantedCardIdExpr)` の**シグネチャは変えず**、内部だけを「出品カード → `cards.streamer_id` → 新ルール」へ変える。呼び出し元6箇所は原則そのまま。

```ts
/** offeredCardIdExpr のカードの配信者にルールが無い、または wantedCardIdExpr がその配信者の許可集合に入っている */
export function wantedAllowedForOffered(offeredCardIdExpr: AnyColumn, wantedCardIdExpr: AnyColumn)
//  NOT EXISTS (cards JOIN 新ルール WHERE cards.id = offered)
//  OR EXISTS (cards JOIN 新許可 WHERE cards.id = offered AND wanted_card_id = wanted)
```

| 箇所 | 変更 |
|---|---|
| `createTradeOffer`（`runChecks`） | `wantedAllowed` を 1 行の select 列として追加（追加クエリ無し）。`wantedWantable` の判定の直後に `TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED` を返す |
| `openOfferConditions`（ボード・ハブ） | `cardIsWantable` の隣に `wantedAllowedForOffered` を AND（フォールバックは入れない。§4.2） |
| `tradeableStateFor`（マイトレード） | 同じ断片を AND に追加 |
| `precheckTradeAccept` | `wantedAllowed` を select に足し、既存の `TRADE_OFFER_UNAVAILABLE` 条件へ合流 |
| `listWantableCards(twitchUserId, streamerId)` | **シグネチャも挙動も変えない**（返す一覧は従来どおり全 wantable）。出品フォームへは §5.1 の「許可表」を別途渡す |
| accept RPC・オークション2関数 | §4 |

出品カードの行が無い（カード削除で `offered_card_id` が NULL）場合は断片が「ルールなし」と同じ結果になるが、全ての呼び出し元が `cardIsActive(offered)` 等で先に落とし、`accept_trade_offer` も `OFFER_INVALID` で先に返るため、削除済みカードがこの断片だけを理由に成立しない（RPC と同じ形。§4 のコメント参照）。

### 5.1 出品フォームの絞り込み（UX）

- `trade-create-flow.ts`（`loadTradeCreateFormData`）は `allowedWantedByOfferedCardId: Record<offeredCardId, string[]>` の**形を維持**して返す。ルールは配信者単位だが、クライアントは出品カードで引く。サーバーは「閲覧者の出品可能コピーのカード → それぞれの配信者 → ルールがあれば W(S)」を引き（1クエリ: `cards LEFT JOIN rules LEFT JOIN items`）、値を `wantableCards` の id 集合と交差させる。
- **交差はサーバー側で取る**: RSC props はクライアントへ直列化されるため、非公開カードの id・件数をキーにも値にも含めない。「ルールなし = キー無し」と「ルールあり・交差空 = `[]`」は区別して返す（後者は出品不可の案内に使う）。
- `TradeCreateForm` は選択中の出品コピーの `cardId` を引き、キーがあれば `wantableCards` をその配列に絞る。無ければ従来どおり。クライアントの絞り込みロジック・案内文は v3 から変えない。
- オークションの入札候補（`TradeAuctionDetail.tsx` の `listWantableCards` 流用）にも同じ交差を適用する。`loadAllowedBidCardsForAuction` は、詳細 API が公開として返すオークションの出品カード id をキーに、その配信者のリストを返す（形は v3 と同じ）。
- クライアントの絞り込みは UI 補助。**権威は createTradeOffer / accept RPC / 入札 RPC**（#1790 と同じ）。

## 6. 設定API・UI

### 6.1 API

`PUT /api/streamer/trade-wanted-restrictions`（route パスは v3 から維持。maintenance-write-surfaces も維持）。

```jsonc
// body
{ "allowedWantedCardIds": ["C", "D"] }  // [] = ルール削除（制限なしに戻す）
```

- 配信者は**セッションから解決**する（body の `streamerId` は受けない。他人の設定を書く余地が無い。v3 の決定を維持）。依頼文の `{ streamerId, allowedWantedCardIds }` は、この安全側の解釈（サーバー解決）で満たす。body に `streamerId` が来ても無視する。
- `allowedWantedCardIds` の全 id が**その配信者のカード**であること、上限内・重複なしを API 層で検証。他人のカード id は一律 404 相当（存在を漏らさない）。**出品カード自身を許可に入れることは許す**（§3.2）。
- 認可・CSRF（`validateCSRFToken`）・`canUseStreamerFeatures`・メンテナンス・レート制限は v3 と同じ。
- 書き込み: **1トランザクションで置換**。最初に配信者行を `FOR NO KEY UPDATE` でロックして同じ配信者の設定更新を直列化し、親行を取得/作成してから子を `DELETE WHERE streamer_id = S` → `INSERT`。NO KEY UPDATE は `cards` などの FK 参照 INSERT（KEY SHARE）をブロックしないため。最終状態を明示するので冪等。
- `[]` の意味: **ルール削除（親行ごと削除 = 制限なしに戻す）**。「ルールは残して誰も指定不可」は UI から作らない（カード削除で自然に起きる状態としてのみ存在し、UI は警告して編集・解除を促す）。
- 検証: 保存時は同一配信者のカードなら無効でも許可（§3.2）。
- `GET` は作らず、初期値は account ページの Server Component で取得（`getTradeWantedRestrictionSettings(streamerId)` → `{ cards: {id,name,rarity,isActive}[], allowedWantedCardIds: string[] | null }`）。`null` = ルール無し、`[]` = ルールあり・許可0件。取得失敗は設定セクションだけ非表示（アカウントページ全体を落とさない）。
- ルール数上限（`TOO_MANY_RULES` / 409）は廃止。

### 6.2 UI（`TradeSettings.tsx` に「交換対象の制限」セクションを追加）

- 見出し「交換対象の制限」＋説明（「あなたのカードが出品されるとき、「求む」に指定できるカードを限定できます。未設定のときは制限なしです」）。
- **カード選択は1つだけ**（v3 の「出品カード」ドロップダウンと一覧を廃止）:
  1. 未設定: 「制限を追加」→「交換対象に追加するカード」ドロップダウンで1枚ずつ追加 → チップ（×で削除）。1枚以上で「保存」。
  2. 設定済み: リストのチップを表示し、「編集」「制限を解除」。
  3. 許可0件のルール: 警告（誰も指定できない）＋「編集」「制限を解除」。
- 自分の有効なカードをすべて候補にする（出品カード自身も含む）。無効カードは新規追加の候補に出さないが、保存済みの無効カードは「無効」チップとして表示し、外せる。
- 上限は `TRADE_WANTED_RESTRICTION_MAX_ITEMS`。上限到達で追加を止め、案内を出す。
- 保存失敗・デプロイ窓 skip は既存パターンどおりメッセージ表示。**楽観更新はしない**（保存成功後に一覧へ反映。v3 の決定を維持）。
- 既存の `ToggleRow` 等の流儀・i18n（`messages/ja.json` / `en.json` の `tradeWantedRestriction.*`）に合わせる。ja/en のキーは揃える。`/guide/trade` の該当節と `TradeGuidePage.tradeGuidePage.streamer.restriction.*` も新仕様に更新する。

## 7. セキュリティ・整合性チェックリスト

- 認可: 設定の編集は S 自身のみ（セッション解決）。許可カードは S のカードに限定（APIで強制。RPC の判定は集合所属のみ）。
- 情報露出: ルールの存在・内容は、出品フォーム用の id 配列（可視カードとの交差でしか効かない）以外は公開しない。ボード/ API に W(S) 全体を返さない。拒否理由は precheck で `TRADE_OFFER_UNAVAILABLE` に畳む。
- 原子性: 置換は1トランザクション＋配信者行ロックで直列化。RPC は読み取りのみで新しいロックを持ち込まない。
- 冪等: 設定 PUT は最終状態を書く。出品/応諾の冪等リプレイは「検証より前」の既存順序を維持（リプレイ時に制限判定を再評価しない）。
- 退行ガード: ルールの無い配信者のカードは従来と完全に同じ結果になること（既存テストが無修正で通る）。
- カード削除: **どのカードを削除してもルール行は残る（fail-closed）**。許可カードを全部削除しても W(S) は空のまま制限が続く。配信者行の削除（アカウント削除）でのみ CASCADE で消える。

## 8. v3（出品カードごと）からの変更理由

1. **仕様の単純化**: オーナー要望は「配信者ごとに1つの交換対象リスト」。出品カードごとのリストは設定・一覧・判定キーがカードに依存し、同じ配信者のカードを増やすたびに設定が増える。配信者単位なら設定は1つで、通常出品・オークションの全カードに一貫して適用できる。
2. **出品カードに依存しないリスト**: v3 の「出品カード自身は許可に入れられない」CHECK と、UI/Auction props の「出品カード自身は選択肢に出ない」規則が不要になる。`offered ≠ wanted` は既存の `TRADE_SAME_CARD` / `SAME_CARD` が別途止めるため、挙動は変えない。
3. **fail-closed の維持**: 親行のキーを `offered_card_id` から `streamer_id` に変えても、親子2テーブル構成・許可0件でもルールを残す性質は維持する。カード物理削除ではルールが外れない（むしろ v3 より強くなる: 出品カードの削除でもルールが残る）。
4. **変更範囲の最小化**: 判定 SQL 断片のシグネチャ、呼び出し元6箇所、出品フォームの props 形（`Record<offeredCardId, string[]>`）、オークション詳細の props 形、エラーコード、UI の絞り込みロジックは変えない。変えるのは DB のキー、設定 API の body、設定 UI、設定の読み取り形だけ。
5. **移行**: #2116 は未リリース（preview のみ）。旧テーブルは preview に適用済みで、行は検証データだけ。本 migration は新テーブルを作り、旧テーブルは参照しないが、非加法ガードのため残す（§4.1）。production には旧テーブルが存在しない（main 未適用）。旧テーブルの削除は #2116 のリリース後の別 Issue で contract migration として行う。

## 9. 実装の分割

v4 は1つの変更（migration + アプリ + テスト + 設計書）として実装する。v3 の PR-1/PR-2 のような分割はしない（既存の v3 実装を置き換えるため、途中状態で設定 UI と DB が食い違う期間を作らない）。

## 10. テスト計画

- 単体: `wantedAllowedForOffered` 断片（`cards` JOIN 新テーブル、旧テーブルを参照しない）、`createTradeOffer`（ルール無し=従来／許可内／許可外／`trade_wantable=false`との AND／`TRADE_SAME_CARD`）、`precheckTradeAccept`、`tradeableStateFor`、設定 API（認可・他人のカード・自己カード許可・上限・重複・空配列=解除・メンテナンス・未適用時503）、設定 UI（追加・編集・解除・空リスト警告・無効チップ・失敗時非楽観）、`TradeCreateForm`（絞り込み・交差が空）。
- migration テスト: 新migrationに `DROP` / `ALTER TABLE`（既存テーブル）/ `UPDATE` / `DELETE` / `TRUNCATE` が無く、操作が「新2テーブルの CREATE・索引・COMMENT・GRANT・既存関数の `CREATE OR REPLACE`」だけであること。旧 migration を編集していないこと。差し替える4関数（3引数ラッパーは変更なし）の差分が制限ブロックのみであること、grants。
- PG 結合テスト（`tests/integration/*-pg.test.ts` の流儀）: 配信者単位の制限、ルール0件の fail-closed、カード削除でルールが残る、他配信者のカードに影響しない、オークション入札・成立、応諾、既存オファーの非表示→復活。
- 設定データ層: 置換・削除・冪等・並行・無効カード・他配信者拒否・読み取り（`null` と `[]` の区別）・許可表（キーは出品カード、値は交差、非公開 id を含まない）。
- Preview 実経路: トレードは `docs/QA.md` の実経路ゲート対象（ガチャ/overlay/chat/upload）外。ブラウザで「リスト設定 → 許可外が選べない → 許可内で出品 → 別アカウントで応諾」を確認する（本番アカウントを変更する操作は CLAUDE.md の制約に従い、preview の検証用データで行う）。

## 11. YAGNI として今回やらないこと

- 交換対象側 C からの制限（「C は S の出品でしか求められない」）、ブラックリスト方式、レアリティ単位の一括ルール、複数リスト、リストのコピー/一括編集、検索付きコンボボックス、クロスチャネルの許可集合、ルール変更の履歴・通知、旧テーブルの同一 migration での削除。

## 12. v3 レビュー記録（参考）

v3 では Opus レビューの必須 M1〜M5（判定箇所6箇所、設定 PUT の並行実行、カード物理削除による fail-open、非公開カード id の props 露出、オークション未対応）を反映した。v4 はこの結論（親子2テーブル、配信者行ロック、サーバー側交差、オークション適用、非公開 id をキーにも値にも含めない）をそのまま引き継ぐ。
