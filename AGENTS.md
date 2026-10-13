# BASE
- research the industry-standard approach to this problem use it to guide yours"
- Detailed comments must be included in the source code to justify the implementation of such logic
- 日本語で応答して
- テストに失敗したら、作業に関係なくとも、subagentに委任して修正を行うこと

## エージェント委任
- 低リスクで手順が定型、または機械的な調査・修正・検証は、難度とコストに見合う軽量エージェント（利用可能なら低推論モデル）へ積極的に委任する。
- 本番影響、セキュリティ、設計判断、破壊的操作、最終承認は、主担当または適切な上位レビュー担当が保持する。
- 委任時は、所有ファイルまたは責任範囲、他者の変更を巻き戻さないこと、期待成果と検証方法を明記する。
- エージェント枠または利用可能なモデルがない場合は作業を止めず、安全に主担当が実施し、その理由を報告する。

## Review
- 作業内容は厳しい自己レビューを実施すること
- コードの重複や簡潔性、無駄なファイルを作っていないかどうか、使いやすさ、セキュリティリスク、コストなどのあらゆる点について厳しく指摘してください
- 指摘は「必須（マージブロッカー）＝誤動作・データ破損・セキュリティ・退行・CI破壊」と
  「任意（改善推奨）＝設計改善・可読性・命名・軽微な重複」に分類すること
- レビュー修正した後は再度レビューを実施し、必須指摘が解消されるまで修正とレビューを繰り返せ
- 任意指摘は issue へ退避するか次 PR で対応し、修正ループの収束条件にしないこと
- レビュワーはかなり厳しいので、必須指摘がなくなるようにしろ
- PR/コミット件名の末尾に `(#123)` 形式で Issue 番号を付けない。関連 Issue は PR 本文またはコミット本文の `Refs #123` で示し、PR番号との誤読を避ける。

### 緊急本番修正
- 本番障害の緊急修正は、原因を再現する最小テストと必要な静的検証を通した後、レビュー完了を待たずにデプロイして復旧確認を優先する。
- レビューを省略した理由、デプロイ前に実施した検証、本番での復旧確認結果をPRまたは関連Issueへ記録する。
- 復旧確認後は独立した厳格レビューを必ず実施し、必須指摘があればフォローアップPRで解消してから緊急対応を完了とする。
- この節は通常のリリース順序に対する明示的な例外である。緊急対応で先行したゲートは、復旧後にすべて満たすまでリリース完了とは扱わない。

### Preview 実経路テスト
- 詳細な対応表は `docs/QA.md` の「Preview 実経路ゲート」、累積変更時の適用範囲は同じQA.mdの「Preview昇格時の累積変更テスト」を正本として参照する。この節は実行要点のみを示し、QA.md の必須項目を省略する根拠にはならない。
- ガチャ引き換え、オーバーレイ表示、Twitchチャット送信に影響する変更は、本番反映前にpreview環境で実チャネルポイント引き換えを複数回行い、結果を確認する。アップロードに影響する変更は、QA.mdの対応表のupload行にある全項目（実チャネルポイント引き換え、オーバーレイ表示、実ファイルの投入・保存先からの取得・権限境界・Workerログ）を確認する。
- 実経路テストでは、各引き換えが順番にオーバーレイ表示され、対応するTwitchチャットが送信され、関連ログに再試行の滞留やエラーがないことを確認する。
- 配信者本人のアカウントでも、チャンネルがオフラインのままチャネルポイントを引き換えられる。オフラインだけを理由に実経路テストを中止・`実施不可`扱いにせず、正確なTwitchログイン名、preview用報酬、現在のログインセッション、報酬メニュー表示を確認してから交換を試す。
- Twitchがオフラインであること、報酬メニューが見えないこと、固定overlayが黒画面であることは別々のゲートである。overlay表示の失敗を記録しつつ、報酬が利用可能ならチャネルポイント交換、Twitchチャット、履歴、Workerログの確認を独立して続行する。
- Twitch画面の「ビッツとポイントの残高」はBitsを含む複合表示のため、数値だけをチャネルポイント残高と解釈しない。対象チャネルの配信者本人（アカウント所有者）で実引き換えする場合は、ポイント残高表示やBits残高を阻害条件にせず、正確な報酬メニュー表示・交換操作・引き換え結果を一次証拠にする。視聴者アカウントでは実際のチャネルポイント不足を別途確認し、Bits残高を代用根拠にしない。
- 固定overlayを含む実引き換えは、`docs/QA.md` の「固定overlayの先行観測順序」を必ず守る。固定URLを交換前に専用タブで開いて`DO_CONNECTED`/`POLLING_ACTIVE`を確認し、同じタブを維持したまま交換し、受信直後の有効窓（目安2--5秒）でカードDOM・ロード済み画像画素を確認する。交換後に開いたタブ、設定iframe、合成demo、イベントログだけでは合格にしない。
- 緊急本番修正で本番反映を先行した場合も、復旧後のフォローアップ完了前に同じpreview実経路テストを実施し、結果をPRまたは関連Issueへ記録する。

### E2Eと内部保守経路の境界
- 通常リリースで必須なのは、利用者の操作から利用者が観測できる結果までのE2E（引き換え、overlay、chat、履歴など）である。Worker/DBログはその結果を相関する証拠であり、内部関数・管理APIを直接呼ぶこと自体をE2Eとは扱わない。
- Queue replay、maintenance EventSub、DB outbox relayなど、通常の利用者操作から直接到達しない内部経路が、秘密情報を要求する管理エンドポイントでしか実行できない場合、その秘密情報を要求・取得・入力してPreview E2Eを満たそうとしてはならない。実チャネルポイントの追加消費や本番相当の管理API呼び出しによる代替も禁止する。
- 内部経路そのものを変更した場合だけ、秘密情報を使わないunit/integration/contract/maintenance testを別枠で行う。安全なテストハーネスがなければ内部テスト基盤の`blocked`として記録し、利用者向けE2Eの未達とは混同しない。

### review aspects
- Code quality and best practices
- Potential bugs and edge cases
- Performance implications
- Security considerations
- **コードの簡潔性**: 過度な抽象化や複雑化を避ける
- 単体テストのカバレッジは十分か？
- YAGNI の原則に乗っ取り、過剰な実装と設計を避ける

## Preview 障害のエージェント起票とリリース規則
- Issue起票、証拠のredaction、重複判定、通常リリースと緊急本番修正の優先関係、同じpreview HEADに含まれる**全PRの累積変更**のテスト範囲は、`docs/QA.md` の「Preview昇格時の累積変更テスト」を正本として、その手順どおりに行う。

## リリースPRのタイトル・本文規則
- previewからmainへ昇格するリリースPRは、リリース内容が一般ユーザーにも伝わる具体的なタイトルにする。`release: #1102/#1105 R2 fixtureとDiscord通知をmainへ昇格` のような、番号や内部作業名だけの抽象的なタイトルは禁止する。
- PR本文は、まず一般ユーザー向けに「何が変わるか」「誰に影響するか」「どのように使えるか」を説明し、その後に技術詳細を記載する。技術詳細には、累積対象PR、各HEAD SHA、preview merge SHA、レビュー・CI・Workers Builds・デプロイ・ブラウザー・実経路の確認状態を含める。
- 昇格PRの作成・更新後は本文を読み戻し、一般ユーザー向け説明が先頭にあり、技術詳細と累積SHAの証跡が後続していることを確認してから、mainへのマージ判定へ進む。

## 通常リリースの順序
- 最新のGitHub状態を取得してbaseが`preview`のオープンPRを列挙し、各PRの最新HEAD SHAを固定して一件ずつ処理する。draft、closed、既処理PR、同じpreview HEADの既存昇格PRを重複処理しない。
- テスト・previewデプロイより先にレビュー状態を判定する。必須指摘、必須スレッド、changes requested、必須レビュー不足が一つでも残るPRは`テスト対象外`として止める。
- 必須レビューが解消されたPRだけ、`docs/QA.md` の通常ゲートとPreview累積変更テストに従って、同じpreview HEADに含まれる全PRの累積変更を検証する。必須ゲートを省略して成功扱いにしない。
- 必須ゲート成功後だけ固定HEADをpreviewへマージし、preview ref、CI、Workers Builds/デプロイ、必要なブラウザー・実経路・安全なGETを確認する。実経路に影響する累積変更では`twica-preview-real-redemption`の手順を適用する。
- preview検証後は同じpreview HEADの昇格PRを一つだけ用意し、上記のタイトル・本文規則を満たすことを読み戻して確認する。main必須CIとWorkers Buildsがすべて成功した場合だけmainへマージする。
- mainマージ後はmain SHA、Auto Releaseのタグと本文、productionのWorkers/補助Worker、公開エンドポイントのGETを確認する。タグまたは本番デプロイの証拠が無い場合は成功扱いにせず停止する。

## 実行環境とCloudflare MCP
- このリリース手順を実行するエージェントはsandbox内で動作する。ローカルの`wrangler`/CLIは、sandboxのネットワーク・認証・ファイルシステム制約により利用できない場合がある。
- `wrangler`が利用できない、または認証・接続に失敗した場合は、接続済みのCloudflare MCPを代替経路として検討し、Workers Builds、Workerのデプロイ状態、Observability/ログなど、許可された読み取り・操作を確認する。MCPで確認した証拠も実測結果として記録する。
- Cloudflare MCPが未認証または失敗した場合は、トークン・Cookie・秘密情報の要求、取得、保存、認証回避をせず停止し、必要なユーザー操作と阻害理由を報告する。MCPやローカルCLIの結果だけで、GitHub Actions/Workers Buildsなどの必須ゲートを省略して成功扱いにしてはならない。
- previewの動作確認先は固定URL `https://twica-preview.tsubasa-azumagakito.workers.dev` とし、Cloudflareが発行する個別のpreview URLを確認先として扱わない。
## Cloudflare 操作

- 新規Cloudflare操作は cf-first とし、`cf cli search` で探索してから対象・引数を確認する。新規設定は可能な範囲で `cloudflare.config.ts`、新規独立Workerは Vite + Cloudflare Vite plugin を優先する。
- 既存Wranglerプロジェクトでは `cf migrate` のレビュー前に `cf init/dev/build/deploy` などbuildを伴うコマンドを実行しない（追加の対象は下記運用文書を参照）。自動設定が既存TOMLのentrypointやbindingを引き継がないため。
- 本体のOpenNext / Workers Builds、preview/prod、secret、補助Workerの配備有無を維持する。移行のparityと明示fallbackは [Cloudflare cf-first運用](docs/cloudflare-cf-migration.md) を参照する。
- Wranglerを無条件に追加・更新しない。利用時はfallback理由と対象を明示する。設定移行にruntime互換日更新、DB変更、secret更新、resource作成、配備を混ぜない。
