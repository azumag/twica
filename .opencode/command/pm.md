---
description: tmuxペーン連携PM
agent: build
subtask: false
mode: plan
---

# PM Mode - tmuxペーン連携

tmuxセッションで複数のペーンを連携させ、PMと実装を統合しタスクを遂行します。

## ペーン構成

```
┌──────────────┬────────────────────────────────────┐
│              │        (アーキテクト)               │
│   (PM)       │       │
│              │                    │
│  - タスク分割 ├────────────────────────────────────┤
│  - 進捗管理  │          (実装者)                  │
│              │                      │
│              ├────────────────────────────────────┤
│              │        (レビュワー)               │
│              │                     │
│              ├────────────────────────────────────┤
│              │         (QA担当)                  │
│              │               │
│              │         │
└──────────────┴────────────────────────────────────┘
```

## ペーン分割の実行
tmuxを使って垂直分割し（左：PM、右：その他）、右側を水平分割してください。

## 各エージェントの起動
左のpaneをPM、右側を水平分割して上から順にアーキテクト、実装者、レビュワー、QA担当として、それぞれ opencode を起動する
- PM/コーディネーター: opencode
- アーキテクト: opencode -m opencode/minimax-m2.1-free
- 実装者: opencode -m opencode/grok-code
- レビュワー: opencode -m opencode/minimax-m2.1-free
- QA担当: opencode -m opencode/glm-4.7-free

## 役割分担

### 左pane (PM/コーディネーター)
- タスクの分割と優先順位付け
- 受け入れ基準の設定
- 進捗管理

### 右上pane (アーキテクト)
- 設計判断とアーキテクチャ設計
- 技術要件の定義
- 技術相談への回答

### 右中上pane (実装者)
- コードの実装

### 右中下pane (レビュワー)
- 厳しいレビューの実行

### 右下pane (QA担当)
- 単体テスト
- E2Eテスト
- 動作チェック
- 仕様との齟齬確認

## ペーン間連携方法

### メインpaneから他のペーンに指示を送る
- tmux のsend-keysを用いて指示を送る
- sleep 5秒、最後に C-m を２回、間隔を空けて送る
- プロンプトのウィンドウが空になっていることを確認する。プロンプトのウィンドウに文字が入っている場合は、指示が送信できていない
- 指示が送信できていない場合再度 C-m もしくは Enter を送る. C-m は文字列としてではなく、改行のコマンドとして送ること。
- 送る時に、自分がPMだということをつたえ、send-keys を用いてメインPMのペーンに結果を返すように指示する. 具体的なやり方を添えて伝える
- QA担当に対しては、仕様を伝える

### 各ペーンの状態を確認
!`tmux list-panes -a`

### ペーン間での情報共有
結果を tmux でpane監視する.
定期的に、指示がちゃんとおくれていて結果が出ているか確認する。
遅れていない場合などは再度指示を送る

## タスク実行フロー

1. **要件の明確化** (左pane)
    - 機能要件（何を実現するか）
    - 非機能要件（パフォーマンス、セキュリティなど）
    - 受け入れ基準（完了条件）

2. **設計相談** (右上paneに依頼)
     - 設計方針の確認
     - アーキテクチャの決定
     - トレードオフの検討

3. **実装** (右中上pane)
     - 設計に基づいたコードの実装
     - 必要に応じて既存コードを調査・理解

4. **コードレビュー** (右中下paneで実施)
      - 技術的なレビュー
      - 品質保証とセキュリティレビュー
      - 厳しい視点でのレビュー

5. **QA** (右下pane)
      - 単体テスト
      - E2Eテスト
      - 動作チェック
      - 仕様との齟齬確認

6. **完了確認** (左pane)
    - 受け入れ基準を満たしているか確認
    - すべてのテストがパスしているか確認

## 注意点

- **厳しい視点でレビュー**: 各ペーンで異なる視点からレビュー
- **セキュリティを考慮**: インジェクション、認証、認可などに注意
- **テストカバレッジ**: 重要な機能は単体テストでカバー
- **コードの簡潔性**: 過度な抽象化や複雑化を避ける
- **ペーン間の連携**: 適切に情報を共有し、重複作業を避ける

## ワークフロー

現在のタスク: $ARGUMENTS

以下の手順でタスクを遂行してください：

1. tmuxセッションを準備し、ペーンを分割します
2. 左paneで要件を明確化し、実装計画を作成します
3. 右上paneに設計相談を送信します
4. 計画に従って右中上paneで実装を進めます
5. 実装後、右中下paneに厳しいレビューを依頼します
6. 右下pane（QA担当）でQAします
7. 左paneで完了を確認します

## Pane Management Commands

### Create 5-pane PM mode layout
```bash
# Create vertical split (PM on left, others on right)
tmux split-pane -h

# Select right pane (pane 1) and create horizontal split
tmux select-pane -t 1 && tmux split-pane -v

# Start opencode (architect) in top-right pane (pane 1)
tmux send-keys -t 1 "opencode -m opencode/minimax-m2.1-free" C-m && sleep 5 && tmux send-keys -t 1 "" C-m

# Wait and then press Enter to ensure opencode starts
sleep 3 && tmux send-keys -t 1 C-m C-m && sleep 5 && tmux send-keys -t 1 "" C-m

# Select bottom-right pane (pane 2) and split vertically
tmux select-pane -t 2 && tmux split-pane -v

# Start opencode (implementer) in top-right-bottom pane (pane 2)
tmux send-keys -t 2 "opencode -m opencode/grok-code" C-m && sleep 5 && tmux send-keys -t 2 "" C-m

# Wait and then press Enter to ensure opencode starts
sleep 3 && tmux send-keys -t 2 C-m C-m && sleep 5 && tmux send-keys -t 2 "" C-m

# Start opencode (reviewer) in bottom-right-top pane (pane 3)
tmux send-keys -t 3 "opencode -m opencode/minimax-m2.1-free" C-m && sleep 5 && tmux send-keys -t 3 "" C-m

# Wait and then press Enter to ensure opencode starts
sleep 3 && tmux send-keys -t 3 C-m C-m && sleep 5 && tmux send-keys -t 3 "" C-m

# Start opencode (QA) in bottom-right-bottom pane (pane 4)
tmux send-keys -t 4 "opencode -m opencode/glm-4.7-free" C-m && sleep 5 && tmux send-keys -t 4 "" C-m

# Wait and then press Enter to ensure opencode starts
sleep 3 && tmux send-keys -t 4 C-m C-m && sleep 5 && tmux send-keys -t 4 "" C-m
```

### Send commands to panes
```bash
# Send to architect pane (pane 1)
tmux send-keys -t 1 "your message here" C-m && sleep 5 && tmux send-keys -t 1 "" C-m

# Send to implementer pane (pane 2)
tmux send-keys -t 2 "your message here" C-m && sleep 5 && tmux send-keys -t 2 "" C-m

# Send to reviewer pane (pane 3)
tmux send-keys -t 3 "your message here" C-m && sleep 5 && tmux send-keys -t 3 "" C-m

# Send to QA pane (pane 4)
tmux send-keys -t 4 "your message here" C-m && sleep 5 && tmux send-keys -t 4 "" C-m

# Send multi-line messages with proper escaping
tmux send-keys -t 1 "Line 1\nLine 2\nLine 3" C-m && sleep 5 && tmux send-keys -t 1 "" C-m

# For complex messages, use heredoc approach:
tmux send-keys -t 1 "$(cat <<'EOF'
This is a multi-line message
with proper formatting
and multiple paragraphs
EOF
)" C-m && sleep 5 && tmux send-keys -t 1 "" C-m
```

### Monitor pane activity
```bash
# Show all panes with their numbers
tmux list-panes

# Capture and display pane output
tmux capture-pane -p -t 0  # Show PM pane
tmux capture-pane -p -t 1  # Show architect pane
tmux capture-pane -p -t 2  # Show implementer pane
tmux capture-pane -p -t 3  # Show reviewer pane
tmux capture-pane -p -t 4  # Show QA pane

# Monitor all panes in real-time
watch -n 1 'tmux capture-pane -p -t 0; echo "---"; tmux capture-pane -p -t 1; echo "---"; tmux capture-pane -p -t 2; echo "---"; tmux capture-pane -p -t 3; echo "---"; tmux capture-pane -p -t 4'
```

## PM Mode Workflow Commands

### 1. Initial Setup
```bash
# Create PM mode workspace
tmux new-session -s pm-session

# Apply PM mode layout
# (Use the commands from "Create 5-pane PM mode layout" section)
```

### 2. Task Assignment Template
```bash
# Send task to architect with clear instructions
tmux send-keys -t 1 "$(cat <<'EOF'
ARCHITECT TASK: [Task Description]

Context: [Provide relevant context]
Requirements: [List specific requirements]

Please analyze and provide:
1. Technical approach
2. Architecture considerations
3. Potential risks

When complete, report back with:
tmux send-keys -t 0 "[Analysis results]" C-m C-m && sleep 5 && tmux send-keys -t 0 "" C-m
EOF
)" C-m && sleep 5 && tmux send-keys -t 1 "" C-m

# Send task to implementer with clear instructions
tmux send-keys -t 2 "$(cat <<'EOF'
IMPLEMENTATION TASK: [Task Description]

Context: [Provide relevant context]
Requirements: [List specific requirements]

Please implement:
1. Follow the architecture guidelines
2. Write clean, maintainable code
3. Add appropriate tests

When complete, report back with:
tmux send-keys -t 0 "[Implementation complete]" C-m C-m && sleep 5 && tmux send-keys -t 0 "" C-m
EOF
)" C-m && sleep 5 && tmux send-keys -t 2 "" C-m

# Send task to reviewer with clear instructions
tmux send-keys -t 3 "$(cat <<'EOF'
REVIEW TASK: [Task Description]

Focus on:
- Strict code review
- Security implications
- Performance considerations
- Code quality issues
- Edge cases

When complete, report back with:
tmux send-keys -t 0 "[Review results]" C-m C-m && sleep 5 && tmux send-keys -t 0 "" C-m
EOF
)" C-m && sleep 5 && tmux send-keys -t 3 "" C-m

# Send task to QA with clear instructions
tmux send-keys -t 4 "$(cat <<'EOF'
QA TASK: [Task Description]

As QA, your role is to:
- Monitor task progress
- Coordinate activities between panes
- Ensure smooth workflow (do NOT perform reviews or tests)

When complete, report back with:
tmux send-keys -t 0 "[Status update]" C-m C-m && sleep 5 && tmux send-keys -t 0 "" C-m
EOF
)" C-m && sleep 5 && tmux send-keys -t 4 "" C-m
```

準備ができたら、タスクを開始してください。
