# 画像アップロード機能改修 - 完了

## 概要
Vercel Blob から Supabase Storage への移行、URL指定機能の削除、容量制限の追加

## 変更サマリー

| 項目 | 変更前 | 変更後 |
|------|--------|--------|
| ストレージ | Vercel Blob | Supabase Storage |
| URL指定 | あり | 削除 |
| 容量制限 | なし | 2MB制限 |

## 完了タスク

### 1. `/src/app/api/upload/route.ts` - Supabase Storage化 ✅
- Vercel Blob → Supabase Storage に変更
- 2MBファイルサイズ制限追加
- 許可ファイルタイプ: JPEG, PNG, GIF, WebP

### 2. `/src/components/CardManager.tsx` の修正 ✅
- `@vercel/blob/client` import 削除
- `formData.imageUrl` 削除
- URL入力欄を削除
- ラベルを「画像 (2MBまで)」に変更
- フロントエンド側でも2MBサイズチェック追加
- APIボディのキー名をスネークケースに修正 (image_url, drop_rate)

### 3. `@vercel/blob` パッケージ削除 ✅
```
npm uninstall @vercel/blob
```

### 4. ビルド確認 ✅
```
npm run build - 成功
```

## 備考
- Supabase Storage バケット `card-images` は事前に作成済み (public設定)
- Claude (アーキテクト) と Gemini (PM/QA) の協調で実装完了
