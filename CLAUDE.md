# BASE
- research the industry-standard approach to this problem use it to guide yours"
- Detailed comments must be included in the source code to justify the implementation of such logic
- 日本語で応答して
- テストに失敗したら、作業に関係なくとも、subagentに委任して修正を行うこと

## Review
- 作業内容は subagent を用いて厳しい自己レビューを実施すること
- コードの重複や簡潔性、無駄なファイルを作っていないかどうか、使いやすさ、セキュリティリスク、コストなどのあらゆる点について厳しく指摘してください
- レビュー修正した後は再度レビューを実施し、レビューの指摘が完全にクリアされるまで、修正とレビューを繰り返せ

### review aspects
- Code quality and best practices
- Potential bugs and edge cases
- Performance implications
- Security considerations
- **コードの簡潔性**: 過度な抽象化や複雑化を避ける
- 単体テストのカバレッジは十分か？
- YAGNI の原則に乗っ取り、過剰な実装と設計を避ける
