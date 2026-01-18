# 依頼内容

## Issue #47: Code Quality - Hardcoded Strings in React Components

### 依頼事項
React コンポーネント（`src/components/`）に含まれるハードコードされた日本語文字列を `src/lib/constants.ts` に定数として一元管理してください。

### 詳細要件

1. **UI 文字列定数の作成**
   - `src/lib/constants.ts` に `UI_STRINGS` 定数を追加
   - 設計書に記載されている構造に従って定義

2. **コンポーネントの更新**
   - `TwitchLoginButton.tsx` の文字列を定数化
   - `Header.tsx` の文字列を定数化
   - `Collection.tsx` の文字列を定数化
   - `CardManager.tsx` の文字列を定数化
   - その他のコンポーネントの文字列を定数化

3. **検証**
   - lint と test がパスすること
   - CI がパスすること

### 設計書参照
- 詳細な設計: `docs/ARCHITECTURE.md` の「Code Quality - Hardcoded Strings in React Components」セクション
