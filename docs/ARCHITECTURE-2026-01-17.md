# Twica Architecture Document

## 1. 機能要件（What to Achieve）

### 1.1 配信者機能（Streamer Features）
- **Twitch OAuth 認証**: 配信者は Twitch アカウントでサインアップ・ログイン
- **カード管理**: カードの作成、編集、削除、画像アップロード（Supabase Storage, 2MB制限）
- **ガチャ設定**: ドロップ率（drop_rate）とレアリティ（common, rare, epic, legendary）の設定
- **チャンネルポイント報酬連携**: Twitch EventSub によるリアルタイム通知受信
- **統計・履歴**: 自分の配信でのガチャ履歴閲覧、コレクション統計

### 1.2 視聴者機能（Viewer Features）
- **カード獲得**: チャンネルポイント報酬を使用してガチャを実行
- **コレクション管理**: 所有カード一覧、レアリティ別フィルタリング
- **履歴閲覧**: 自分のガチャ履歴の確認

### 1.3 リアルタイム機能（Real-time Features）
- **オーバーレイ配信**: 配信画面にガチャ結果をリアルタイム表示（SSE）
- **イベント通知**: 新しいカード獲得時に即時通知

### 1.4 管理機能（Admin Features）
- **環境変数検証**: 開発時に必須変数の存在確認
- **セッション管理**: JWTベースのセッション、有効期限チェック

---

## 2. 非機能要件（Non-Functional Requirements）

### 2.1 パフォーマンス（Performance）
| 指標 | 目標値 | 備考 |
|------|--------|------|
| API レスポンス時間 | < 500ms | ガチャ実行、カード取得等 |
| 画像アップロード | < 2MB | ファイルサイズ制限 |
| データベースクエリ | < 100ms | 適切なインデックス設計 |
| SSE レイテンシ | < 100ms | オーバーレイ表示遅延 |

### 2.2 セキュリティ（Security）
- **認証**: Supabase Auth + Twitch OAuth
- **認可**: Row Level Security (RLS) ポリシーによるアクセス制御
- **署名検証**: Twitch EventSub メッセージの HMAC-SHA256 署名検証
- **環境変数**: サービスロールキーなど秘密情報はサーバー側のみ
- **XSS 防御**: エラーパラメータのエンコード
- **入力検証**: すべての API 入力に対するバリデーション

### 2.3 可用性（Availability）
- **自動デプロイ**: Vercel CI/CD による main ブランチからの自動デプロイ
- **エラーハンドリング**: API ルートでの統一されたエラーレスポンス
- **バックアップ**: Supabase 自動バックアップ（日次）

### 2.4 保守性（Maintainability）
- **TypeScript 厳格モード**: 型安全性の確保
- **コード規約**: ESLint + Prettier
- **ドキュメント**: JSDoc コメント
- **テストカバレッジ**: E2E テストによる主要機能検証

### 2.5 スケーラビリティ（Scalability）
- **サーバーレスアーキテクチャ**: Vercel Serverless Functions
- **DB プール**: Supabase 接続プール（自動）
- **外部ストレージ**: Supabase Storage による画像管理

---

## 3. 受け入れ基準（Acceptance Criteria）

### 3.1 機能完了条件
- [ ] 配信者が Twitch ログインで認証できる
- [ ] 配信者がカードを作成・編集・削除できる
- [ ] 配信者がチャンネルポイント報酬と連携できる
- [ ] 視聴者がチャンネルポイントでガチャを実行できる
- [ ] 視聴者が自分のコレクション・履歴を閲覧できる
- [ ] オーバーレイでリアルタイムにガチャ結果が表示される

### 3.2 品質完了条件
- [ ] すべての E2E テストが成功する
- [ ] ESLint でエラー0件
- [ ] TypeScript 型チェックでエラー0件 (`tsc --noEmit`)
- [ ] ビルドが成功する (`npm run build`)
- [ ] ローカル開発環境で動作確認完了

### 3.3 セキュリティ完了条件
- [ ] すべての環境変数が `.env.local.example` に記載されている
- [ ] RLS ポリシーが適切に設定されている
- [ ] Twitch EventSub 署名検証が実装されている
- [ ] console.log が本番コードから削除されている

---

## 4. 設計方針（Design Principles）

### 4.1 クラウドネイティブ（Cloud Native）
- PaaS（Vercel + Supabase）を活用し、インフラ管理コストを最小化
- サーバーレスアーキテクチャでスケーラビリティを確保

### 4.2 型安全（Type Safety）
- TypeScript 厳格モードでコンパイル時エラーを排除
- Supabase 型生成（`supabase gen types typescript`）で DB との整合性を維持

### 4.3 関心の分離（Separation of Concerns）
- API Routes: HTTP リクエスト/レスポンス処理
- Business Logic: ガチャアルゴリズム、データ検証
- Data Access: Supabase クエリ抽象化
- UI Components: ビューのみ担当

### 4.4 セキュリティファースト（Security First）
- 最小権限の原則（RLS）
- サービスロールキーはサーバー側のみ
- 外部入力の厳格な検証

---

## 5. アーキテクチャ決定（Architecture Decisions）

### 5.1 システムアーキテクチャ

```mermaid
graph TB
    subgraph "Client Layer"
        Browser[配信者ブラウザ]
        Overlay[オーバーレイ表示]
    end
    
    subgraph "API Layer"
        NextJS[Next.js App Router]
        AuthRoutes[/api/auth/*]
        CardsRoutes[/api/cards/*]
        GachaRoutes[/api/gacha/*]
        EventSubRoute[/api/twitch/eventsub]
        EventsRoute[/api/events/[streamerId]]
    end
    
    subgraph "Business Logic"
        GachaService[ガチャサービス]
        Validation[入力検証]
    end
    
    subgraph "Infrastructure"
        SupabaseAuth[Supabase Auth]
        SupabaseDB[(PostgreSQL)]
        SupabaseStorage[Supabase Storage]
        TwitchAuth[Twitch OAuth]
        TwitchEventSub[Twitch EventSub]
    end
    
    Browser -->|OAuth| TwitchAuth
    Browser -->|JWT| SupabaseAuth
    Browser -->|REST| AuthRoutes
    Browser -->|REST| CardsRoutes
    Overlay -->|SSE| EventsRoute
    
    AuthRoutes --> SupabaseAuth
    CardsRoutes --> SupabaseDB
    CardsRoutes --> SupabaseStorage
    GachaRoutes --> GachaService
    GachaService --> SupabaseDB
    
    TwitchEventSub -->|Webhook| EventSubRoute
    EventSubRoute --> GachaService
    GachaService -->|通知| EventsRoute
    
    GachaService --> SupabaseDB
```

### 5.2 データフロー

**ガチャ実行フロー**:
1. 視聴者がチャンネルポイント報酬を使用
2. Twitch EventSub が Webhook 送信
3. `/api/twitch/eventsub` が通知受信・署名検証
4. GachaService がガチャ実行（ウェイト付き抽選）
5. 結果を DB 保存（user_cards, gacha_history）
6. SSE 接続へ通知
7. オーバーレイでリアルタイム表示

**カード管理フロー**:
1. 配信者が Twitch ログイン
2. JWT トークン発行
3. カード作成 API 呼び出し
4. 画像を Supabase Storage にアップロード
5. カードデータを DB に保存
6. RLS ポリシーで所有権チェック

### 5.3 テーブル設計

| テーブル | 主キー | 外部キー | 用途 |
|----------|--------|----------|------|
| `streamers` | `id` (UUID) | - | 配信者情報 |
| `cards` | `id` (UUID) | `streamer_id` | カードマスタ |
| `users` | `id` (UUID) | - | 視聴者情報 |
| `user_cards` | `id` (UUID) | `user_id`, `card_id` | 所有カード |
| `gacha_history` | `id` (UUID) | `card_id`, `streamer_id` | ガチャ履歴 |

### 5.4 ディレクトリ構造

```
src/
├── app/
│   ├── api/                    # API Routes
│   │   ├── auth/               # 認証関連
│   │   ├── cards/              # カード管理
│   │   ├── gacha/              # ガチャ実行
│   │   ├── twitch/             # Twitch連携
│   │   └── events/             # SSE イベント
│   ├── dashboard/              # 配信者ダッシュボード
│   └── overlay/                # オーバーレイ表示
├── components/                 # UI コンポーネント
├── lib/                        # ユーティリティ
│   ├── supabase/               # Supabase クライアント
│   ├── services/               # ビジネスロジック
│   ├── gacha.ts                # ガチャアルゴリズム
│   ├── constants.ts            # 定数
│   ├── env-validation.ts       # 環境変数検証
│   ├── session.ts              # セッション管理
│   └── error-handler.ts        # エラーハンドリング
└── types/                      # 型定義
    └── database.ts             # DB 型（Supabase生成）
```

---

## 6. トレードオフの検討（Trade-offs）

### 6.1 React 19 vs 18
| 選択 | メリット | デメリット |
|------|----------|------------|
| **React 18（推奨）** | Next.js 16 と互換性あり | 新機能未使用 |
| React 19 | 最新機能使用 | 互換性リスク（未リリース版） |

**決定**: **React 18.2.2** にダウングレード（Next.js 16 の推奨バージョン）

### 6.2 SSE 接続管理
| 選択 | メリット | デメリット |
|------|----------|------------|
| **メモリ内（現在）** | 実装簡易・コスト0 | Serverless で接続消失 |
| Redis/Upstash KV | Serverless 対応 | 追加コスト（$0.50/月〜） |
| Supabase Realtime | 既存インフラ活用 | SSE ではなくWebSocket |

**決定**: **Phase 1 ではメモリ内維持**（小規模稼働のため）→ スケール時に Redis 移行

### 6.3 エラー処理戦略
| 選択 | メリット | デメリット |
|------|----------|------------|
| **try-catch + throw** | コードがシンプル | エラー伝播の追跡困難 |
| Result 型 | エラー明示・テスト容易 | コード量増加 |

**決定**: **Service 層で Result 型導入**（API ルートは try-catch）

### 6.4 RLS vs サービス層認可
| 選択 | メリット | デメリット |
|------|----------|------------|
| **RLS + サービス層認可** | 多重防御 | 実装コスト増 |
| RLS のみ | DB レベルで完結 | ビジネスロジックが分散 |

**決定**: **RLS を主軸に、サービス層で軽微なビジネスルール実装**

### 6.5 画像ストレージ
| 選択 | メリット | デメリット |
|------|----------|------------|
| **Supabase Storage** | 既存アカウント活用・1GB無料 | 超過時に有料 |
| Vercel Blob | ネイティブ連携 | 追加コスト |

**決定**: **Supabase Storage**（既に移行済み、コスト最適化）

---

## 7. 実装フェーズ（Implementation Phases）

### Phase 1: 基盤整備（Foundation）【優先度: 高】
- React バージョン修正（19 → 18.2.2）
- 環境変数の実行時検証強化（エラーで停止）
- 統一エラーハンドリングミドルウェア
- console.log 削除・ロガー導入
- セッション Cookie 定数抽出

**完了条件**: lint エラー0、typecheck エラー0

### Phase 2: ビジネスロジック分離（Service Layer）【優先度: 高】
- `GachaService` クラス作成
- ガチャロジックを API Routes から抽出
- Result 型導入
- Supabase クライアント export 名整理

**完了条件**: Service 層の単体テスト可能

### Phase 3: SSE 接続管理改善（Real-time）【優先度: 中】
- Upstash Redis 導入（オプション）
- SSE Connection Manager 実装
- EventSub ルート refactoring

**完了条件**: 複数インスタンスで接続維持

### Phase 4: UI コンポーネント分割【優先度: 中】
- Dashboard ページ分割（400行 → 150行以下）
- コンポーネント抽出
- 共通 UI コンポーネント作成

**完了条件**: 単一ファイル最大行数 < 150

### Phase 5: テスト強化【優先度: 低】
- ユニットテスト追加
- Playwright 拡張

**完了条件**: カバレッジ 70% 以上

---

## 8. 環境変数一覧

| 変数名 | 必須 | 用途 |
|--------|------|------|
| `NEXT_PUBLIC_APP_URL` | Yes | アプリケーション URL |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase プロジェクト URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase 匿名キー |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase サービスロールキー |
| `TWITCH_CLIENT_ID` | Yes | Twitch クライアント ID |
| `TWITCH_CLIENT_SECRET` | Yes | Twitch クライアントシークレット |
| `NEXT_PUBLIC_TWITCH_CLIENT_ID` | Yes | Twitch パブリッククライアント ID |
| `TWITCH_EVENTSUB_SECRET` | Yes | Twitch EventSub 署名シークレット |
| `BLOB_READ_WRITE_TOKEN` | No（廃止予定） | Vercel Blob トークン |

---

## 9. 技術スタック

| カテゴリ | 技術 | バージョン |
|----------|------|-----------|
| フレームワーク | Next.js | 16.1.1 |
| UI | React | 18.2.2（予定） |
| UI | React DOM | 18.2.2（予定） |
| DB | Supabase | ^2.90.0 |
| 認証 | Supabase Auth | ^0.8.0 |
| 外部 API | Twitch API / EventSub | - |
| スタイル | Tailwind CSS | ^4 |
| テスト | Playwright | ^1.57.0 |
| Lint | ESLint | ^9 |
| ホスティング | Vercel | - |

---

## 10. リスクと緩和策（Risks & Mitigations）

| リスク | 影響 | 緩和策 |
|--------|------|--------|
| React 19 互換性 | デプロイ失敗 | React 18 にダウングレード |
| SSE 接続消失 | オーバーレイ停止 | Redis 移行（Phase 3） |
| Supabase 費用増 | コスト増 | RLS によるアクセス制御・監視 |
| Twitch API 変更 | 連携失敗 | バージョン固定・エラーログ |
| 画像容量超過 | ストレージ不足 | 2MB 制限・定期監視 |

---

## 11. 参考・関連ドキュメント

- [README.md](../README.md) - プロジェクト概要
- [TODO.md](../TODO.md) - タスク一覧
- [REFACTORING_DESIGN.md](../REFACTORING_DESIGN.md) - リファクタリング計画
- [process.md](../process.md) - 変更履歴

---

**作成日**: 2026-01-17
**最終更新**: 2026-01-17
**ステータス**: Draft → 実装フェーズへ進行可
