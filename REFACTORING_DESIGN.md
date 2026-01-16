# Twica リファクタリング設計方針

## 1. 現状分析

### プロジェクト概要
- **Tech Stack**: Next.js 16 (App Router), TypeScript, React 19, Supabase, Tailwind CSS v4
- **目的**: Twitch配信者向けカード引きシステム (Gacha)
- **規模**: 約2,000行のソースコード（主要ファイルのみ）

### 課題一覧

| 優先度 | カテゴリ | 問題点 | 影響範囲 |
|--------|----------|--------|----------|
| **高** | アーキテクチャ | SSE接続がメモリ内で管理（serverless非対応） | eventsub/route.ts:13 |
| **高** | コード重複 | Supabaseクライアントのexport名が重複 | lib/supabase/index.ts:2-3 |
| **中** | 可読性 | dashboard/page.tsx が400行超 | 保守性低下 |
| **中** | エラー処理 | APIルートごとにエラー処理パターンが異なる | 全APIルート |
| **中** | パフォーマンス | DBクエリが複数回に分割されている箇所あり | gacha/route.ts, eventsub/route.ts |
| **低** | セキュリティ | デバッグ用のconsole.logが残存 | 複数ファイル |
| **低** | 命名 | 定数が複数のファイルに分散 | constants.ts, ファイル内 |

---

## 2. リファクタリング設計方針

### 2.1 フェーズ1: 基盤整備（優先度: 高）

#### 2.1.1 Supabaseクライアントの整理
**現在の問題**: `client.ts` と `server.ts` の両方で `createClient` をexportし、`index.ts` で同じ名前で再export

```typescript
// src/lib/supabase/index.ts (改善後)
export { createBrowserClient } from './client'
export { createServerClient } from './server'
export { getSupabaseAdmin } from './admin'
export type { Database } from '@/types/database'
```

**変更ファイル**:
- `src/lib/supabase/client.ts` → 関数名変更なし（既に適切）
- `src/lib/supabase/server.ts` → 関数名変更なし（既に適切）
- 使用箇所で明示的なimportに変更

#### 2.1.2 SSE接続管理の外部化
**現在の問題**: In-memory Map使用 → serverless環境で接続消失

```typescript
// src/lib/sse/connection-manager.ts (新規作成)
import { Redis } from '@upstash/redis' // 推奨、またはKVストア

interface SSEConnection {
  streamerId: string
  controller: ReadableStreamDefaultController
  connectedAt: number
}

export class SSEConnectionManager {
  // Redis/KVestoreを使用した実装
}
```

**変更ファイル**:
- `src/app/api/twitch/eventsub/route.ts` → connection-manager.tsを使用
- `src/lib/sse/` ディレクトリを新規作成

---

### 2.2 フェーズ2: ビジネスロジックの分離（優先度: 高）

#### 2.2.1 Gachaサービスの抽出
**現在の問題**: ビジネスロジックがAPIルート内に直接記述

```typescript
// src/lib/services/gacha/service.ts (新規作成)
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { selectWeightedCard } from '@/lib/gacha'
import type { Card, GachaResult } from '@/types/database'

export class GachaService {
  async executeGacha(streamerId: string, userTwitchId: string, userTwitchUsername?: string): Promise<GachaResult> {
    // カード選択〜履歴記録までの一連の処理を実装
  }
}
```

**変更ファイル**:
- `src/app/api/gacha/route.ts` → GachaServiceを使用
- `src/app/api/twitch/eventsub/route.ts` → handleRedemptionをGachaService.move

#### 2.2.2 Result型の導入
**現在の問題**: エラー処理がreturn文とthrowの両方で不一致

```typescript
// src/lib/types/result.ts (新規作成)
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export function ok<T>(value: T): Result<T> { return { ok: true, value } }
export function err<E>(error: E): Result<never, E> { return { ok: false, error } }
```

---

### 2.3 フェーズ3: UIコンポーネントの分割（優先度: 中）

#### 2.3.1 Dashboardページの分割
**現在の問題**: 1ファイル400行超

```
src/app/dashboard/
├── page.tsx           # データフェッチとレイアウトのみ
├── DashboardHeader.tsx
├── StreamerSection.tsx
├── CollectionStats.tsx
├── GachaHistorySection.tsx
└── CollectionGrid.tsx
```

**変更ファイル**:
- `src/app/dashboard/page.tsx` → メインレイアウトのみ
- `src/components/dashboard/` ディレクトリに新コンポーネント配置

---

### 2.4 フェーズ4: 定数と型の整理（優先度: 低）

#### 2.4.1 定数ファイルの統合
**現在の問題**: 定数が複数のファイルに分散

```typescript
// src/lib/constants.ts (統合後)
export const APP = {
  NAME: 'TwiCa',
  SESSION_COOKIE: 'twica_session',
  SESSION_MAX_AGE: 60 * 60 * 24 * 30,
} as const

export const TWITCH = {
  AUTH_URL: 'https://id.twitch.tv/oauth2/authorize',
  TOKEN_URL: 'https://id.twitch.tv/oauth2/token',
  API_URL: 'https://api.twitch.tv/helix',
  SUBSCRIPTION_TYPE: {
    CHANNEL_POINTS_REDEMPTION_ADD: 'channel.channel_points_custom_reward_redemption.add',
  } as const,
} as const
```

---

## 3. 優先順位と実行計画

### Phase 1: 基盤整備（推定工数: 2-3時間）
1. Supabaseクライアントのexport名修正
2. SSE Connection Managerの実装
3. 環境変数の型定義強化

### Phase 2: ビジネスロジック分離（推定工数: 4-6時間）
1. GachaServiceの作成
2. Result型の導入とエラー処理の統一
3. APIルートのリファクタリング

### Phase 3: UI分割（推定工数: 3-4時間）
1. Dashboardページのコンポーネント分割
2. 共通UIコンポーネントの抽出

### Phase 4: コード品質向上（推定工数: 2-3時間）
1. console.logの削除/loggerへの置換
2. 定数ファイルの統合
3. JSDocコメントの追加

---

## 4. 期待される効果

| 指標 | 現在 | 改善後 |
|------|------|--------|
| 単一ファイルの最大行数 | 400行 | 150行以下 |
| ビジネスロジックの凝集度 | 低（APIルート内に分散） | 高（Service層に集約） |
| テスト容易性 | 困難 | 容易（Service単位） |
| Serverless対応 | 未対応（ SSE） | 対応（KVストア使用） |

---

## 5. 注意点

1. **後方互換性の維持**: APIのインターフェース変更なし
2. **段階的移行**: 1ファイルずつリファクタリングし動作確認
3. **型安全性の維持**: TypeScriptの厳格モードを継続
4. **コミット粒度**: 各フェーズごとに個別のコミット
