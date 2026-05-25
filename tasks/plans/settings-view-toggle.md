# 配信設定ページ シンプル/詳細 表示切り替え 実装計画

## 背景

`/dashboard/settings`(配信設定ページ) が肥大化し、新規ユーザーが圧倒される構造になっている。
現状は OBSオーバーレイURL、チャネルポイント、ガチャ効果音、チャット通知、未所持カード表示 の5セクションが常に表示される。

industry-standard: Gmail の Basic/Standard、Stripe や Notion の "Show advanced settings"、
GitHub Settings → Advanced 区切り、と同じ「Progressive disclosure」パターンを採用する。

## 要件 (ユーザー確定)

- **シンプル表示**: OBS URL(プレビュー含む) + チャネルポイント報酬設定 の2つだけ
- **詳細表示**: 全5セクション(=現状と同じ)
- **保存先**: ブラウザの localStorage (DB 変更なし)
- **デフォルト**: 初回はシンプル

## 設計

### コンポーネント構成

`src/components/SettingsViewMode.tsx` (新規, "use client") に以下を集約:

1. `SettingsViewModeProvider` — React Context Provider
   - state: `mode: 'simple' | 'advanced'`
   - localStorage キー: `twica.settingsViewMode`
   - 初期 state は 'simple' (SSR と一致させハイドレーション不整合を防止)
   - `useEffect` で mount 後に localStorage を読み込み state を更新
2. `SettingsViewToggle` — トグル UI (セグメントボタン2つ)
   - クリックで mode を更新し localStorage に保存
3. `AdvancedSettings` — children を内包し mode==='advanced' のときのみ表示
   - SSR 互換のため最初は children を mount 済み + `hidden` 属性で非表示にし
     mode 切替時に DOM 再生成せず状態保持。
   - ただし「初回シンプル」のためサーバ出力にも詳細セクションが含まれる
     → 非ログイン情報リークなし。SEO 影響なし(ダッシュボード配下)。

### ページ改修 (`src/app/dashboard/settings/page.tsx`)

- 全体を `<SettingsViewModeProvider>` でラップ
- ヘッダー右側に `<SettingsViewToggle />` を配置
- `OverlayPreview` の `sideContent` を以下に変更:
  ```tsx
  <>
    <ChannelPointSettings ... />   // シンプル/詳細 両方で表示
    <AdvancedSettings>
      <GachaSoundSettings ... />
      <ChatAnnouncementSettings ... />
      <CardVisibilitySettings ... />
    </AdvancedSettings>
  </>
  ```

### i18n (`messages/ja.json`, `messages/en.json`)

`settingsPage` 配下に以下キーを追加:

```json
"viewMode": {
  "label": "表示モード",
  "simple": "シンプル",
  "advanced": "詳細",
  "ariaLabel": "設定の表示モードを切り替え"
}
```

英語版は "Display mode" / "Simple" / "Advanced" / "Toggle settings display mode"。

### テスト

- `tests/components/SettingsViewMode.test.tsx` (新規, Vitest + Testing Library)
  - Provider 配下で初期 mode が `simple`
  - toggle クリックで `advanced` になり、localStorage に保存される
  - localStorage に値があれば mount 後に反映
  - `AdvancedSettings` は mode==='simple' のとき `hidden` 属性付きで描画

## 影響範囲・リスク

- DB マイグレーション不要 (低リスク)
- 既存ユーザーが次回アクセス時にデフォルトで「シンプル」になる
  → これは仕様。詳細を見たいユーザーは1クリックで切替可能
- ハイドレーション: 初期 state を 'simple' 固定にすることで mismatch 回避
- パフォーマンス: 詳細セクションは依然 dynamic import される。シンプル時も
  プリロードしておくほうがトグル切替時の体験が良い。dynamic import は維持。

## YAGNI ガード

- DB 永続化なし
- アカウント/デバイス間同期なし
- アニメーションは CSS 標準遷移のみ
- 個別セクション単位の表示制御は将来追加せずに済むよう、基本 vs 詳細の2分類のみ
