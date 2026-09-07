# Pack completion rewards implementation plan

主担当が直接実装・検証・レビューする（ユーザー指定により委任禁止）。

**Goal:** #720 のパックコンプ報酬を、循環するコンプ条件なしで提供する。
**Architecture:** PlanetScale RPC が設定不変条件・現在の所有・一度だけの付与を保証する。
サーバーサービスが安全な viewer props を作成し、既存画面に小さな専用 UI を統合する。
**Tech Stack:** PostgreSQL, postgres.js, Drizzle, Next.js, React, Vitest.
**Spec:** ../specs/2026-09-07-pack-completion-rewards-design.md

## Constraints
- inactive 報酬は全体・パックの進捗から除外。0種類は未コンプ。
- 付与履歴と user_cards は同一トランザクション。履歴は解除で消さない。
- CSRF/session/rate limit/ownership を変更 API 全体に適用。
- 未取得カードの id/name/image_url を viewer props に含めない。
- 既存の dirty checkout と sources は変更しない。

## 1. DB と判定
- [x] tests/unit/pack-completion-reward.test.ts に default/named/zero/inactive の判定テストを追加して失敗を確認。
- [x] src/lib/pack-completion-reward.ts に resolvePendingRewardGrants と viewer 状態型を実装。
- [x] db/planetscale/migrations/20260907000000_add_pack_completion_rewards.sql に設定/履歴、RPC、カード保護、rename カスケードを追加。
- [x] src/lib/db/schema.ts / src/types/database.ts を同期。
- [x] 実ローカル PostgreSQL に適用し重複付与、未達、active 化競合、rename 衝突を検証。

## 2. API と付与サービス
- [x] src/lib/services/pack-completion-reward.ts に一覧/付与、失敗時の安全な表示継続を追加。
- [x] src/app/api/streamer/pack-completion-rewards/route.ts に GET/PUT/DELETE を追加。
- [x] src/app/api/cards/[id]/route.ts で保護エラーを409に変換。
- [x] API のCSRF・権限・不正入力・DB未適用・RPC失敗テストを実施。

## 3. 画面
- [x] PackCompletionRewardSettings.tsx を CardPackModal/CardManager へ統合。
- [x] PackCompletionRewards.tsx を StreamerCollection へ統合。
- [x] collection/[streamerId]/page.tsx で付与と直後の所有データ整合を処理。
- [x] SortedCardGrid の報酬バッジと ja/en 翻訳を追加。
- [x] 未取得情報の非露出、獲得表示、既存進捗不変のテストを実施。

## 4. 検証とリリース
- [x] 型/lint/関連テスト/全体unit/build、自己レビューで必須指摘を解消。
- [ ] preview PR、CI、自動レビュー、固定preview画面で検証。
- [ ] 累積差分の QA 分類と必須ゲートを満たして main/production/tag を確認。
