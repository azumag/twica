# BASE
- research the industry-standard approach to this problem use it to guide yours"
- Detailed comments must be included in the source code to justify the implementation of such logic
- 日本語で応答して

- 作業内容は、厳しいレビューを受けること。
以下の３種類のレビューを受けること
- 自己レビュー
- gemini-cli を用いたレビュー
- codex cli を用いたレビュー

コードの重複や簡潔性、無駄なファイルを作っていないかどうか、使いやすさ、
セキュリティリスク、コストなどのあらゆる点について厳しく指摘するよう指示してください

レビュー修正した後は再度レビューを受け、レビューの指摘が完全にクリアされるまで、修正とレビューを>繰り返せ

- テストに失敗したら、作業に関係なくとも、修正すること

## review aspects
- Code quality and best practices
- Potential bugs and edge cases
- Performance implications
- Security considerations
- **コードの簡潔性**: 過度な抽象化や複雑化を避ける
- 単体テストのカバレッジは十分か？
- YAGNI の原則に乗っ取り、過剰な実装と設計を避ける
