PR #1779 の独立レビューで出た任意指摘への対応です。**base を preview にしています。**

## なぜ base が preview なのか

`git ls-tree origin/preview -- src/app/trade src/components` で確認したところ、preview には既にトレード視聴者UI一式が揃っています（`TradeBoard.tsx` / `TradeCreateForm.tsx` / `MyTrades.tsx` / `TradeCancelModal.tsx` と `src/app/trade/` 配下）。#1779 はその領域を main 版に置き換える PR なので、**preview に対しては適用できません**（preview 側の新しい実装を巻き戻してしまいます）。

指摘の対象（`tradeSettings.visibilityNotice`）は preview にも存在するので、preview ベースで文案だけを修正します。

## 指摘内容

`visibilityNotice` が「上の「コレクション公開設定」」を参照していましたが、**preview にその名前のセクションは存在しません**。

preview の実態（`src/app/dashboard/account/page.tsx` L97-124）:

- `CardVisibilitySettings` と `TradeSettings` はどちらも `dashboard/account` の「配信者向け: コレクションの公開とトレード」セクション内
- 並び順は `CardVisibilitySettings` → `TradeSettings`（= すぐ上、は正しい）
- `SettingsLayout` のサイドバー advanced セクションに `visibility` / `trade` の項目は**無い**（`overlay / reward / sound / announcement / liveDirectory / share` のみ）

## 変更内容

- `messages/ja.json` / `messages/en.json`: 参照先を存在する名前に変更
  - 「上の「コレクション公開設定」」→ 「すぐ上の「未所持カードの表示設定」」（`cardVisibilitySettings.title` の実値）
  - “in \"Collection visibility\" above” → “in \"Unowned Card Visibility\" just above”
  - トグル名は **変更なし**。preview の `form.showDetails` は「未所持カードの名前・画像・説明を公開する」で、元の文案と一致していたため
- `src/components/TradeSettings.tsx`: コメントの「公開設定カードは同じ画面のすぐ上にある」という記述を、実際の DOM 構成（`dashboard/account` のセクション内で `CardVisibilitySettings` → `TradeSettings` の順）に書き換え

## 検証（Node 22 = `.node-version` と同一、preview HEAD `e0f820d5` ベース）

- `npm run typecheck` → エラーなし
- `npm run lint:i18n` → エラーなし
- `npx vitest run tests/unit/i18n-message-parity.test.ts` → 4 passed（ja/en キー整合）
- `npx vitest run tests/unit/trade-service.test.ts` + `trade-accept-service.test.ts` + `components/trade-settings.test.tsx` → 70 passed
- `npx vitest run tests/unit` → 412 files / **4744 passed**
- `node -e "require('./messages/ja.json'); require('./messages/en.json')"` → JSON valid

## 補足

- base は `origin/preview`。分岐元確認済み（`git log --oneline origin/preview..HEAD` は本PRの1コミットのみ）
- 挙動・公開判定・DB の変更はありません（文案とコメントのみ）
- PR #1787 は同じ修正の main ベース版です。preview 側はこちらで、main 側は #1787 で、それぞれ管理してください

Refs #1779
