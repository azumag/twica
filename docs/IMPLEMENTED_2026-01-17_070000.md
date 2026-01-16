# 実装記録

## 実装日

2026-01-17

## レビュー対応

Issue #11: カードアップロード容量制限の実装に関するレビュー修正

## 対応したレビュー項目

### 1. セキュリティ上の問題: MIMEタイプと拡張子の両方を検証 (高)

**ファイル**: `src/lib/upload-validation.ts`

**変更内容**:
- MIMEタイプに加えて拡張子検証を追加
- `getFileExtension()`関数を追加してファイル名から拡張子を取得
- `validateFileType()`関数を追加してMIMEタイプと拡張子の整合性を検証
- `TYPE_TO_EXTENSIONS`マッピングを追加してJPEG/PNGのみを許可

```typescript
const TYPE_TO_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
};
```

### 2. UXの不整合: エラー表示を統一 (中)

**ファイル**: `src/components/CardManager.tsx:85`

**変更内容**:
- `handleSubmit`内の検証失敗時に`alert()`を使用していた箇所を`setUploadError()`に変更
- ファイル選択時とフォーム送信時のエラー表示が統一された

### 3. file.nameのnull/undefinedチェック (中)

**ファイル**: `src/app/api/upload/route.ts:26-28`

**変更内容**:
- `file.name`がnull、空文字、または空白のみの場合に400エラーを返す検証を追加
- 型アサーション`(file as File)`を削除し、nullチェック後に`file`を直接使用

```typescript
if (!file || !file.name || file.name.trim() === '') {
  return NextResponse.json({ error: 'ファイル名が空です' }, { status: 400 });
}
```

## 検証結果

- [x] コードの型チェックが通る
- [x] セキュリティ要件（MIME + 拡張子検証）が満たされる
- [x] UXが一貫している（すべてuploadErrorステートを使用）
- [x] file.nameのnullチェックが実装されている
