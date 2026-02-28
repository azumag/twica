# BASE
- research the industry-standard approach to this problem use it to guide yours"
- Detailed comments must be included in the source code to justify the implementation of such logic
- 日本語で応答して
- テストに失敗したら、作業に関係なくとも、subagentに委任して修正を行うこと

## 実装計画立案時のルール
- ユーザーに計画を提示する前に、 codex コマンドで計画のレビューを行うこと
- 本質的でない指摘は無視しても良い
```
# initial plan review
codex exec "please review: {plan_full_path}"

# updated plan review
codex exec resule --last "plan updated: {plan_full_path}"
```

## Review
- 作業内容は subagent を用いて厳しい自己レビューを実施すること
- コードの重複や簡潔性、無駄なファイルを作っていないかどうか、使いやすさ、セキュリティリスク、コストなどのあらゆる点について厳しく指摘してください
- レビュー修正した後は再度レビューを実施し、レビューの指摘が完全にクリアされるまで、修正とレビューを繰り返せ
- レビュワーはかなり厳しいので、指摘がなくなるようにしろ


### review aspects
- Code quality and best practices
- Potential bugs and edge cases
- Performance implications
- Security considerations
- **コードの簡潔性**: 過度な抽象化や複雑化を避ける
- 単体テストのカバレッジは十分か？
- YAGNI の原則に乗っ取り、過剰な実装と設計を避ける

## Final team review
自己レビュー後、チームを作成し、多角的な視点からレビューを行なってください。あなたは技術のスペシャリストとして全体を監督し、また自身もレビューを行うこと。ただし、ほとんど実害がないような過剰レビューは必要ない。他エージェントは適宜役割を設定し sonnet を指定すること。エージェント同士にもクロスレビュー、相互議論をさせよ。本番障害、既存構成の破壊的変更やユーザ影響などについて重要視せよ。 チームからのレビューを統合しチームリードレビューを行う際、指摘されている確認推奨事項（メソッド実装など）は自分で確認し、まとめ、適宜優先度を判断すること。


