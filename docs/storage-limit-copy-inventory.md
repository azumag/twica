# Storage limit copy inventory

Issue #1354 で扱う固定 10MB 表記の棚卸しです。ここでは文言変更の判断はせず、現行の表示経路と動的な実効上限の正本を分けて記録します。

## 動的な実効上限

- `src/lib/storage-usage.ts`: `getStorageUsage()` が base limit + bonus + plan allowance から `userLimitBytes` を確定する。
- `src/app/api/storage-status/route.ts`: `userLimitFormatted` は `userLimitBytes` から生成する。
- `src/app/dashboard/page.tsx`: 使用量表示は `storageUsage.userLimitBytes` を `formatBytes()` して表示する。

このため、利用者ごとの実効上限そのものは固定 10MB 文字列ではなく `userLimitBytes` を正本とする。

## 固定 10MB 表記

- `src/lib/constants.ts` の `STORAGE_LIMIT_MESSAGES.USER_LIMIT_REACHED`: 外部・未知クライアント向けの互換フォールバック。
- `messages/ja.json` / `messages/en.json` の `CardManager.messages.userLimitReached`: 公式 UI の上限到達メッセージ。
- 同 `CardManager.messages.storageLimitReason`: 公式 UI の容量案内。
- `src/app/plans/page.tsx` の素地プラン「ストレージ容量: 10MB」: プラン一覧上の固定表記。1ファイル上限の 1MB / 5MB / 10MB 表記とは別の項目。

固定値の案内を将来変更する場合は、API 互換文言と ja/en の UI 文言を同時に確認する。プラン一覧の 10MB は利用者ごとの動的 `userLimitBytes` 表示とは用途が異なるため、同じ変更として扱うかは別途判断する。
