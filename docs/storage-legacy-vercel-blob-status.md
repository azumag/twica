# 旧Vercel Blob URL互換の撤去条件と現状（Issue #1688）

対象: https://github.com/azumag/twica/issues/1688
確認日: 2026-10-07 UTC。**結論: 互換コードは撤去しない（保留）。**
DB の 0 件確認が取れていないため、Issue の方針どおり削除は行わない。

## 互換 surface の棚卸し（現行維持）

| 箇所 | 内容 | 扱い |
| --- | --- | --- |
| `src/lib/validations.ts` `TRUSTED_IMAGE_DOMAINS` | `blob.vercel-storage.com` / `public.blob.vercel-storage.com` は画像拡張子検証をスキップ | 維持 |
| `src/lib/storage-utils.ts` `isVercelBlobUrl()` / `isStorageUrl()` | 旧 Vercel Blob URL を自前ストレージ扱い | 維持 |
| `src/lib/storage-cleanup.ts` | 旧 Vercel Blob URL は R2 実体削除せず DB 記録のみ削除 | 維持 |
| `tests/unit/storage-utils.test.ts` | 旧 URL を storage URL として扱う契約を固定 | 維持 |
| `tests/unit/api/upload-delete-ownership.test.ts` | 旧 URL の互換削除挙動を固定 | 維持 |

R2 / Twitch CDN（`static-cdn.jtvnw.net`）/ 一般外部画像 URL の既存挙動は変更しない。

## read-only 調査の状態

- 本実行環境から見える接続済み Supabase 側は旧 TwiCa 環境であり、現行 repo の正本 DB
  である PlanetScale の current Preview / Production を表すものではない。
  そのため旧環境の値は本調査の証跡に使わない。
- 現行 PlanetScale への許可された read-only 接続は本実行環境から利用できないため、
  DB 証跡は未取得のままである。
- 受け入れ条件どおり、**0 件確認なしに互換コードを削除する変更は行わない。
  証跡は捏造しない。**

## 次の調査手順（DB アクセス権を持つ実行者向け、すべて読み取り専用）

```sql
-- 1. blob_files の legacy 件数（storage_type が直接の判定材料）
SELECT storage_type, COUNT(*) FROM blob_files GROUP BY storage_type;
SELECT COUNT(*) FROM blob_files WHERE url LIKE '%blob.vercel-storage.com%';

-- 2. cards.image_url の legacy 残存
SELECT COUNT(*) FROM cards WHERE image_url LIKE '%blob.vercel-storage.com%';

-- 3. 効果音 URL の legacy 残存
SELECT COUNT(*) FROM streamers WHERE gacha_sound_url LIKE '%blob.vercel-storage.com%';
```

`blob_files.storage_type` は `'r2' | 'vercel'`（DB 側 CHECK 制約）で、
`url` は公開 URL が主キー。`streamers.twitch_profile_image_url` /
`users.twitch_profile_image_url` は Twitch CDN の外部 URL であり本調査の対象外。

## 完了条件の対応

- [x] read-only 調査結果を記録（本書: DB 証跡未取得・旧環境は証跡に不使用）
- [x] 旧 URL が 0 件でない扱いのため削除しない理由を記録（本書）
- [ ] 旧 Vercel Blob URL が 0 件と確認できたら、互換 runtime surface を最小差分で撤去する別 PR
- [x] R2 / Twitch CDN / 一般外部画像 URL の回帰テストを維持（本 PR では runtime・テスト無変更）
- [ ] 実経路確認が必要な場合はコード CI と区別して記録（Preview / Production の実データ確認時に追記）

Refs #1688 #837 #830 #112
