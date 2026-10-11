PR #1779 の独立レビューで出た未解決の任意指摘1件に対応します。

## 指摘内容

`tradeSettings.visibilityNotice` の文案が、**preview の配置を前提**にしていました。

- 「上の「コレクション公開設定」」→ main の `SettingsLayout` にそのセクション名は無く、実ナビ名は **「公開設定」**（`settingsPage.advanced.section.visibility` / “Visibility”）
- 「未所持カードの名前・画像・説明を公開する」→ 実トグル名は **「未所持カードの画像・説明を公開する」**（`cardVisibilitySettings.form.showDetails` / “Reveal image and description of unowned cards”）

指摘のとおり、`src/lib/dashboard-data.ts` / `SettingsLayout.tsx` を確認したところ、設定画面の advanced セクション並びは `announcement → visibility → liveDirectory → trade → share` なので、**公開設定はトレード設定のすぐ上**にあり「上の」という位置関係自体は正しいです。セクション名とトグル名だけを実物に合わせます。

## 変更内容

- `messages/ja.json` / `messages/en.json`: `tradeSettings.visibilityNotice` を実ナビ名・実トグル名に修正
- `src/components/TradeSettings.tsx`: `visibilityNotice` の説明白コメントを修正。指摘どおり「同じ画面のすぐ上」は配置前提だったので、`SettingsLayout` の実際のセクション並び（visibility → liveDirectory → trade）を明記

## 検証（Node 22 = `.node-version` と同一）

- `npm run typecheck` → エラーなし
- `npx eslint`（変更3ファイル）→ `messages/*.json` は eslint 対象外の warn のみ、エラーなし
- `npm run lint:i18n` → エラーなし
- `npx vitest run tests/unit/i18n-message-parity.test.ts` → 4 passed（ja/en のキー整合）
- `npx vitest run tests/unit/trade-service.test.ts` + `trade-accept-service.test.ts` → 66 passed
- `npx vitest run tests/unit` → 402 files / 4646 passed
- `node -e "require('./messages/ja.json'); require('./messages/en.json')"` → JSON として valid

## 補足

- このブランチは PR #1779 の head（`2240438c`）をそのまま含み、その上に1コミット追加しています
- 挙動・公開判定・DB の変更はありません（文言とコメントのみ）

Refs #1779
