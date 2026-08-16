# 現行 QA

## 通常ゲート

```bash
npm run check:supabase-shutdown
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run workers:build
npm run auxiliary-workers:build
npm run check:supabase-shutdown -- --require-open-next --require-aux-workers
```

analysis dashboard は `analysis/` で `npm ci`, `npx tsc --noEmit`, `npm run build` を実行し、
生成 bundle に旧 provider が含まれないことを CI で確認します。

## Preview 実経路ゲート

下記の対応表のいずれかの行に該当する変更は preview へ配備し、対応表で決まる**すべての確認必須項目**を実行します。複数の経路にまたがる変更は項目番号の和集合とし、共有 DB/OAuth/Worker/queue の影響経路を特定できない場合は 1-7 をすべて対象にします。

- DB または OAuth: 1, 2, 3, 4, 5, 6, 7
- Worker または queue の共有基盤（下記の個別経路に分類できない変更）: 1, 2, 3, 4, 5, 6, 7
- EventSub または gacha: 1, 2, 3, 4, 5
- overlay: 1, 2, 3, 4, 5
- chat: 1, 2, 3, 4
- queue replay: 1, 2, 3, 4
- WebSocket または polling gap recovery: 1, 5
- analysis dashboard またはその集計: 6
- upload: 1, 2, 7

対応表の行に該当する項目は対象外にできません。対応表にない影響について追加の項目確認を対象外とする場合だけ、その影響と判断理由を昇格PRへ明記し、未記録のまま省略してはなりません。

この対応表は `docs/E2E_SCENARIO.md` に定義された Preview Twitch 実経路の必須シナリオを置き換えません。変更が同シナリオの対象になる場合は、対応表の項目と併せて該当シナリオも実行します。

1. Twitch の実チャネルポイント報酬を複数回引き換える。
2. 各結果が順番どおり overlay に表示される。
3. 各結果の chat メッセージが送信される。
4. EventSub direct と Queue replay の両経路を確認する。
5. overlay WebSocket を再接続し、polling gap recovery で欠落・重複がないことを確認する。
6. analysis dashboard の主要集計が PlanetScale の値と一致することを確認する。
7. 対象ファイルのアップロード、保存先からの取得、権限境界、Workerログを確認する。

production 反映後は同じ主要経路を smoke test し、旧 provider の outbound request と
Secret access がゼロであることを観測してから旧 Secret を削除します。

## Preview昇格時の累積変更テスト

previewからmainへ昇格する際のテスト対象は、起点となった単一PRではなく、同じpreview HEADに含まれる昇格対象**全PRの累積変更**とする。

- mainとの差分およびpreview→main昇格PRの差分を固定し、含まれる全PR番号・各HEAD SHA・preview merge SHAを記録する。
- 各PRの呼び出し元、共有契約、DB/キュー/Worker/overlay経路を横断して確認し、PR同士の組み合わせによる退行も対象にする。
- いずれかの構成PRが上記「Preview 実経路ゲート」の対応表のいずれかの行に該当する場合、対応表で決まる全項目を累積変更全体に対して再実行し、履歴、チャット、overlay、Workerログを相関させる。対応表の行に該当する項目は除外できず、対応表にない影響について追加確認を対象外とする場合だけ、その影響と理由を昇格PRへ記録する。単一PRだけのテスト成功や合成demo表示は代替にならない。
- 累積変更のいずれかに必須レビュー・必須CI・実経路ゲートの未達があれば、（緊急本番修正の例外を除き）昇格を止め、原因と対象PRをIssueまたは昇格PRへ記録する。
- 構成PRを切り離す場合は、対象PRをrevertする変更をpreviewへ反映して新しいHEADを作り、旧 `release-unit` 行を `superseded` へ in-place 更新し、置換先の `status=open` 行が同じ本文書き込み後に存在することをensureする（未登録なら追加し、既存なら追加せずopen状態を検証する）。置換先のHEAD SHAとrevertの証拠を記録し、残りのPRだけを新しいリリース単位として再レビュー・再テストする。`superseded` は終端状態で未解消単位には数えない。未達ゲートを飛ばして部分昇格してはならない。
- fix-forwardで旧preview HEADを昇格対象から外し、revertではない修正で置換先HEADを作る場合は、旧 `release-unit` 行を `abandoned` へ in-place 更新し、置換先HEAD SHAとredaction済みの理由・証拠を記録する。置換先の `status=open` 行が同じ本文書き込み後に存在することをensureし（未登録なら追加、既存なら追加せずopen状態を検証）、`abandoned` は終端状態で未解消単位には数えない。旧行の終端化、置換先行のensure、読み戻し検証を一つでも完了できない場合は旧行を変更せず `blocked` としてリリースを阻害する。
- リリース単位自体を撤回し置換先HEADを作らない場合は、旧 `release-unit` 行を `cancelled` へ in-place 更新し、redaction済みの撤回理由・証拠と、対象PR番号・旧HEAD SHAがpreview→main昇格PRの差分および累積release-unit一覧から除外されたことをGitHub/昇格PR本文の最新読み戻しで確認した証拠を、同じ本文書き込みで記録する。`cancelled` は終端状態で未解消単位には数えず、旧行の更新・撤回理由・除外確認の記録・読み戻し検証を一つでも完了できない場合は旧行を変更せず `blocked` としてリリースを阻害する。
- 構成PRを再投入する場合は、revertのrevertを含む新しいPRとして、累積変更全体を再レビュー・再テストする。
- Issueを作成する場合は、対象環境を `preview` または `production` のいずれかに固定し、事象名を次の閉じた集合から選ぶ: `ci-failure`、`workers-build-failure`、`deploy-failure`、`health-check-failure`、`real-path-db`、`real-path-oauth`、`real-path-eventsub`、`real-path-gacha`、`real-path-overlay`、`real-path-chat`、`real-path-upload`、`real-path-queue-replay`、`real-path-websocket-gap-recovery`、`real-path-analysis-dashboard`、`unknown-failure`。該当しない場合は `unknown-failure` とする。タイトルは `[preview-gate] <対象環境>: <事象名>` とし、重複判定キーはこのタイトルの対象環境と事象名だけにする。HEAD/merge SHAはキーに含めず、Issue本文の観測メタデータとして追記する。
- 新規Issueの本文は、`<!-- preview-gate-issue-lease: owner=<実行ID>; lease_until=<UTC ISO8601> -->` 行、完全一致する見出し `## Release units`、その直下の `<!-- release-unit-migration: v1 -->`、その直後の単一リスト、最初の `release-unit: preview-head:<SHA>; status=open` 行の順に作成する。本文の作成後に読み戻してlease行・見出し・marker・marker直後のリスト・行がそろっていることを確認できない場合は `blocked` としてリリースを阻害する。
- 起票前に `auto-generated` と `bug` の両ラベルの存在を確認し、無ければ作成する。ラベルの作成・付与に失敗した場合は起票せず、阻害理由を記録する。**Issue作成時には必ず両ラベルを付与する。**重複判定の本命は、`GET /repos/azumag/twica/issues?state=open&per_page=100&page=<n>` を`Link: rel="next"`が無くなるまで全ページ走査して得た項目のうち、`pull_request`フィールドを持たないIssueのタイトル完全一致である。完全一致Issueのラベルが欠けていれば両ラベルを修復してから使用する。REST Issues List APIが失敗した場合は起票せず、阻害状態を記録して次回の同じリリースゲート実行で再試行する。GitHub Searchを使う場合も `repo:azumag/twica is:issue is:open in:title "[preview-gate] <対象環境>: <事象名>"` に限定し、候補取得後にタイトル完全一致を確認する。Searchはラベル欠損Issueを見落とし得るため、REST結果を常に優先する。
- GitHub Searchは補助であり、重複判定の唯一のガードにしない。マーカーの正本は、同じpreview HEADのpreview→main昇格PRが存在する場合はそのPR、存在しない場合は**同じpreview HEADから当該リリース単位として列挙した昇格対象PR**のうち最小のPR番号とし、選択したPR番号をリリース記録へ記載する。マーカーは正本PRの**1つの機械可読コメントを更新**して管理し、コメント内にキーごとの状態行を置き、各キーについて常に最新状態だけを有効とする。ここでいう正本Issueのマーカーは、正本PR上のコメントから正本Issue番号を指す状態行を管理することをいう。状態は次のいずれかである: `<!-- preview-gate-key: <対象環境>: <事象名>; state=pending; owner=<実行ID>; lease_until=<UTC ISO8601> -->`、`<!-- preview-gate-key: <対象環境>: <事象名>; state=created; issue=#<番号> -->`、`<!-- preview-gate-key: <対象環境>: <事象名>; state=retired; issue=#<番号> -->`、`<!-- preview-gate-key: <対象環境>: <事象名>; state=blocked; issue=#<番号またはunknown>; reason=<redacted-summary>; at=<UTC ISO8601> -->`。昇格PRが後から作られた場合は、起点PRの最新マーカー状態を昇格PRへ移送し、起点PR側には移送先PR番号を記録する。両方を同時に正本として扱わない。
- preview HEADの変化でcanonical PRを選び直す場合は、pending/created/retired/blockedを含む同じ`<対象環境>: <事象名>`キーの全状態を、リリース記録に残る旧canonical PRから新canonical PRへ先に移送する。旧canonicalのキー行・Issue番号・lease状態を同じread-modify-writeで新canonicalへmergeし、旧canonicalには単独の `preview-gate-moved: to=#<PR番号>` 行を残し、両PRを読み戻して状態集合と移送先PR番号を検証するまで、新canonicalで`pending`作成、Issue起票、状態遷移を行ってはならない。旧canonicalが特定できない、複数の値が衝突する、または移送・読み戻しに失敗する場合は新canonicalを`blocked`としてリリースを阻害し、HEAD変更でblocked状態を消してはならない。
- canonical markerの`reason=<redacted-summary>`は、redaction後に改行（LF/CR）、`;`、`<!--`、`-->`、バッククォート、`<`、`>`を含めず、ASCII英数字・空白・`.`・`_`・`-`だけで120文字以内に正規化する。正規化できない入力は`_`へ置換し、正規化後の1行全体を検証してから書き込む。canonicalコメント内の同一キーは常に1行だけとし、複数行を読み戻した場合は行順や`at`を推測せず`blocked`として解消する。したがって「最新状態」は、readback後に正本コメントに1行だけ残った状態を指す。
- 正本PRのcanonical markerコメントは、リポジトリの既定ブランチ`main`から読み戻した`.github/preview-gate-release-bots.txt`に1行ずつ固定した許可投稿者に含まれ、本文の1行目が単独の固定文字列 `<!-- preview-gate-marker -->` で、2行目以降が許可された `preview-gate-key` / `preview-gate-lease` / `preview-gate-moved` 行だけで構成されるコメントとする。allow-listはpreview HEADや昇格PRの差分から読まず、`main` refまたはファイルの読み戻しに失敗した場合は`blocked`とする。allow-listファイルがmainにまだ存在しない初回導入中は、このPRをmainへ反映してmainからファイルを読み戻せるようになるまで、previewゲートを実行せず、状態・Issue操作を行わない`blocked`として報告する。自由文、引用、箇条書き、コードフェンス、バッククォート、`release-unit` 行を含むコメントはcanonical候補にしない。allow-listファイルはUTF-8の1行1ログインで、空行と`#`始まりの行だけを無視し、前後空白の除去や大文字小文字の正規化は行わず、不正な行があれば`blocked`とする。コメント一覧を全ページ読み戻し、許可投稿者の構造条件を満たす該当コメントが複数ある場合はcomment IDが最小のものだけを正本コンテナとする。状態入力・lease入力・旧形式migration候補も許可投稿者のコメントに限定する。allow-list外コメントは本文を状態・証拠・migration・衝突判定へ収集・解析せず、Issue番号やleaseも取り込まない。全ページ読み戻しはコメントの存在と許可投稿者によるcanonical IDの確定にだけ使う。実行時のGitHub認証ログインがこのファイルに無い場合は、コメントを書き込まず`blocked`として停止する。
- 固定マーカーがまだ無い既存PRを一度だけ移行する場合も、`.github/preview-gate-release-bots.txt`の許可投稿者コメントだけから、行全体が専用構文に一致し、前後空白・Markdown引用/箇条書き・コードフェンス・バッククォートを含まない `preview-gate-key` 行と旧形式のキー行を収集し、redaction・重複検証を行う。旧コメントの専用lease行はseedせず、正本コンテナを確定した後に現在の実行IDでcanonical PR leaseを取得する。候補の同一キーの状態、owner、lease期限、Issue番号が同一ならcomment ID最小の正本コンテナへmergeし、値が異なる場合は古い行を推測して採用せず、正本コンテナの対象キーを正式な`state=blocked; issue=#unknown; reason=marker-state-conflict; at=<UTC ISO8601>`または`state=blocked; issue=#unknown; reason=issue-id-conflict; at=<UTC ISO8601>`へ更新して読み戻し、Issue操作を停止する。allow-list外の行はこの衝突判定にも使わず、既存Issueの重複防止は必ずRESTのタイトル完全一致確認で行う。
- 該当するcanonicalコメントが無い場合は、まず固定マーカーだけを含む空のコメントを1つ作成し、作成直後に全ページを再取得してcomment ID最小を正本に確定する。正本の作成・読み戻しに成功するまで状態操作を行ってはならず、失敗時は`blocked`とする。正本確定後に上記のallow-list内の旧形式行を収集してmerge・読み戻しし、衝突があれば正本の対象キーへ`blocked`を書き込む。衝突が無ければキー行だけをseedし、seedと読み戻しに成功するまでIssue操作を行わない。他の同マーカーコメントは状態判定に使わず、正本への統合・読み戻しが完了するまで削除・クローズ扱いにしない。
- `marker-state-conflict`または`issue-id-conflict`を正本へ書き込んだ後は、その正本のblocked行を回復用の唯一の状態とし、非canonicalコメントの行を再度衝突として再判定しない。次回実行はRESTで同一タイトルのIssueとラベルを再確認し、`issue=#unknown`なら正しいIssue番号を正本行へ修復する。open Issueが見つからない場合は全stateの完全一致Issueを確認し、クローズ済みまたは未作成ならcanonical PR leaseを保持したまま`pending`から新規Issueを作成して読み戻し、`created`へ遷移する。active leaseが無いこととこの遷移を読み戻せない場合だけ`blocked`のままリリースを阻害する。
- 正本PRの機械可読markerコメントの更新と、起点PRから正本PRへのmarker移送は、canonical PR単位のowner・期限レコードで協調する。GitHubのコメント更新は原子的なロックとして扱えないため、更新前に最新コメントを取得し、他キーの全状態行を保持したまま対象キーだけをmergeして書き込み、直後に全コメントを読み戻してcanonicalコメントの内容と対象状態を検証する。所有者不一致・期限切れ・読み戻しで他の書き込みを観測した場合は書き込みを続けず、最新コメントを再取得して冪等にmerge・再適用し、3回で成功しなければ`blocked`としてリリースを阻害する。markerの読み戻し確認が成功するまで、対応するIssueの状態変更やクローズを完了扱いにしてはならない。
- leaseの正本は、canonical PR用は正本PRの機械可読markerコメント内の `<!-- preview-gate-lease: scope=canonical-pr:<PR番号>; owner=<実行ID>; lease_until=<UTC ISO8601> -->` 行、Issue用は対象Issue本文の`## Release units`の直前に置く `<!-- preview-gate-issue-lease: owner=<実行ID>; lease_until=<UTC ISO8601> -->` 行とする。Issue用leaseを正本PRコメントに置いてはならず、異なるpreview HEADから同じIssueを更新する実行も必ずこのIssue本文の同じ行を読み戻して協調する。本文の形状は、完全一致見出し1個、見出し直下のmigration marker 1個、marker直後の単一リスト1個、各SHAの`release-unit`行1行を先に検証する。migration markerが無い、またはこの形状検証に失敗した場合だけ、最新本文を取得し、既存本文の全release-unit行を保持しながら欠けているissue lease行・見出し・marker・marker直後の単一リストを重複なくread-modify-writeで修復する。markerが無い場合は修復後に旧形式行のmigrationを実行し、移行と読み戻しが完了した同じ本文書き込みでmarkerを追加する。markerが既にある場合は旧形式migrationを再実行せず、既存のrelease-unit行を保持した形状修復だけを行う。issue lease行の不在だけで形状が正しい場合はbootstrapを起動せず、lease取得のread-modify-writeだけを行う。修復後の読み戻しで見出し・marker・marker直後のリストが各1個であることを確認できない場合は状態操作を行わず`blocked`とする。`owner` はスケジュール実行ごとに一意な実行ID、TTLは取得時から10分で、GitHub API応答の`Date`ヘッダーを基準に2分ごとまたは期限の2分前に同じread-modify-write手順で`lease_until`を更新する。更新に失敗した、またはAPI時刻が期限に達した実行は直ちに書き込み・クローズを中止して`blocked`とし、期限切れを確認した別実行だけが最新本文・コメントを読み戻して再取得する。canonical PR leaseを先に協調し、Issue本文・証拠コメント・クローズを扱う時はIssue本文のissue leaseも協調する。対象のmarker・Issue本文・証拠コメントの読み戻し検証が完了した後に専用行を同じread-modify-writeで削除し、削除の読み戻しに失敗した場合は`blocked`とする。`pending`の10分リースはIssue作成操作だけを保護する別物であり、これらのleaseの代替にならない。
- まずREST Issues List APIで完全一致Issueを確認し、見つかれば既存Issue本文のmigration・読み戻し検証を先に完了してから`created`マーカーを設定し、そのIssueへ証拠をコメントする。Issueが無く`pending`のリースが期限内なら新規起票せず、期限とキーを阻害理由として記録する。期限切れならREST APIで再確認し、なお無ければ新しい10分間の`pending`マーカーを設定してからIssueを作成する。マーカーが無い場合も同じ順序で`pending`を設定してから作成する。`created`マーカーのIssueがクローズ済み・削除済みなら、そのマーカーを`retired`へ更新し、同じキーの新しいリリース単位として`pending`から再起票する。
- 既存Issueの本文に `<!-- release-unit-migration: v1 -->` が無い場合は、本文と、`.github/preview-gate-release-bots.txt`の許可投稿者コメントから旧形式の `release-unit: preview-head:<SHA>; status=<open|resolved|superseded|abandoned|cancelled>` 行を収集し、redaction・重複検証を行ったうえで `Release units` 本文の単一リストへ移行し、同じ本文にこの移行完了マーカーを追加する。allow-list外コメントの本文は移行候補・証拠・衝突判定に使わない。本文と許可コメントで同一SHAの状態が衝突する場合は安全側として `open` を採用し、コメント由来の `resolved` は移行時に `open` として再検証対象にする。`superseded` 行は置換先HEAD SHAとrevertの証拠がそろっている場合だけ保持し、`abandoned` 行は置換先HEAD SHAとredaction済みの理由・証拠がそろっている場合だけ保持し、`cancelled` 行はredaction済みの撤回理由・証拠と対象PR/旧HEAD SHAの昇格差分・累積release-unit一覧からの除外確認の読み戻し証拠がそろっている場合だけ保持する。必要な証拠が欠ける場合は終端状態を `open` として再検証対象にする。マーカーの書込み、移行、読み戻しのいずれかに失敗した場合は、クローズ・再起票・状態変更を行わず `blocked` としてリリースを阻害し、次回実行で同じ移行を再試行する。移行完了後は許可コメント内の旧行を一覧判定に使わず、コメントは証拠の追記だけにする。
- 完全一致Issueを見つけた場合は、`created` マーカーの設定や証拠コメントの追記より先に、上記の本文・許可コメントのmigration、`## Release units`・migration marker・全release-unit行の読み戻し検証を完了する。読み戻しでは完全一致見出しがちょうど1個、見出し直下のmigration markerがちょうど1個、marker直後のリストがちょうど1個、各SHAの`release-unit`行がちょうど1行であることを確認する。移行完了マーカーの存在だけでは成功とみなさず、本文形状または読み戻し検証に失敗した場合は `created` への遷移やコメント追記を行わず `blocked` として次回実行に回す。
- `superseded` または `abandoned` 化は、置換先の `release-unit: preview-head:<新SHA>; status=open` 行が同じIssue本文の同じ書き込み後に存在することをensureした場合にだけ許可する。未登録なら追加し、既存なら追加せず`status=open`であることを検証する。旧行の終端状態への更新、置換先行のensure、必要な証拠、読み戻し検証を一つでも完了できない場合は旧行を変更せず `blocked` としてリリースを阻害する。
- `superseded`/`abandoned`の置換先行について、上記で「追加」と表記した箇所はすべて「同じ本文書き込み後に存在することをensureする」の意味とし、同一SHAの既存`status=open`行を再追加してはならない。既存行が`open`以外、重複、または読み戻しで一意に確認できない場合は状態を推測せず`blocked`とする。
- `cancelled` 化は置換先行を要求せず、撤回理由・証拠と対象PR/旧HEAD SHAの昇格差分・累積release-unit一覧からの除外確認の読み戻し証拠を同じIssue本文の同じ書き込みで追加する場合にだけ許可する。旧行の終端状態への更新、理由または除外確認の追加、読み戻し検証を一つでも完了できない場合は旧行を変更せず `blocked` としてリリースを阻害する。
- 重複Issueを正本へ統合する際は、`superseded`/`abandoned`/`cancelled` 行、置換先HEAD SHA、revertまたはfix-forwardまたは撤回の理由・証拠も全release-unit情報として移送・読み戻し検証の対象に含める。これらを移送できない場合は重複Issueを閉じず `blocked` としてリリースを阻害する。
- 同一Issueの`Release units`本文更新、新しいrelease-unitの追加、状態遷移、証拠コメント、正本PRのmarker更新、クローズは、上記のissue leaseを協調し、常に最新本文を取得して全行を冪等にmerge・書き込み・読み戻し検証する。所有者不一致、期限切れ、他の書き込みの観測、またはleaseの再取得・再適用に失敗した場合は書き込みやクローズを行わず`blocked`としてリリースを阻害する。
- `release-unit` は固定したpreview HEAD SHAを使う `preview-head:<SHA>` とし、preview merge SHA・昇格PR番号はその単位の観測メタデータとして同じIssueへ記録する。Issue本文の `Release units` 単一リストを正本とし、各単位を `release-unit: preview-head:<SHA>; status=<open|resolved|superseded|abandoned|cancelled>` の形式で一度だけ行として置く。必須レビュー・必須CI・preview/実経路確認・必要なゲートの確認結果を単一のリリース担当者が集約し、すべて完了した時だけ、既存の `open` 行を本文内で in-place 更新して `resolved` にする（`resolved` 行を追記してはならない）。対象PRの切り離しで置換先HEADが作られた場合だけ、旧行を `superseded` へ in-place 更新して置換先SHAとrevertの証拠を記録する。revertではないfix-forwardで旧HEADを昇格対象から外す場合は、旧行を `abandoned` へ in-place 更新して置換先SHAとredaction済みの理由・証拠を記録する。リリース単位自体を撤回する場合は、旧行を `cancelled` へ in-place 更新してredaction済みの撤回理由・証拠と、対象PR/旧HEAD SHAが昇格差分・累積release-unit一覧から除外されたことの読み戻し証拠を記録する。`superseded`/`abandoned` では置換先の `status=open` 行を同じ本文書き込みで追加し、終端状態は未解消単位に数えない。Issueコメントは証拠の追記だけに使い、release-unit一覧の判定には使わない。新しいSHAの同一事象でも重複起票せず、最新本文を再取得して既存の全`preview-head:<SHA>`行を保持したまま、未登録の`preview-head:<新SHA>`を`status=open`として本文の単一リストへ一度だけ追加し、読み戻しで新行と既存行のSHA集合・一行性を検証してから、その単位の証拠をコメントする。本文への追加または読み戻し検証に失敗した場合は`blocked`としてリリースを阻害する。Issueは**現在列挙されている未解消（`open`）のリリース単位がゼロ**になった時だけクローズし、`open`単位が一つでもある間はクローズしてはならない。クローズ済みIssueに同じキーが再発した場合は、`retired`マーカーから新しいリリース単位の`pending`へ進み、新しいIssueを作成する。クローズ時は対応するマーカーを`retired`へ更新する。
- Issue作成直前にREST Issues List APIでタイトル完全一致をもう一度確認し、既存Issueがあれば作成せず追記する。作成に成功したら直ちに`created; issue=#<番号>`マーカーを設定する。作成応答が不明、または作成後のマーカー更新に失敗した場合でも、次回の同じリリースゲート実行はREST Issues List APIの完全一致を先に行い、見つかったIssueへ追記してマーカーを修復する。完全一致Issueが無く、`pending`リースが期限切れになった場合だけ再起票を許可する。REST、ラベル、マーカー、Issue作成のいずれかが失敗した場合は正本PRのマーカーを`blocked`へ更新し、キー・失敗した操作・時刻・(redacted)済みエラー概要を記録する。次回の同じリリースゲート実行がこの`blocked`を再確認して、成功すれば`pending`または`created`へ遷移させて再試行する。マーカー更新自体に失敗した場合は起票せず、その失敗を最終報告の阻害理由として残す。10分間の`pending`リースはIssue作成操作だけを保護し、実経路テスト全体の期限ではない。通常のスケジュール実行は同一リリース単位を直列処理する。Issue本文の`Release units`を更新する前には必ず最新本文を再取得し、その本文に存在する全`preview-head:<SHA>`を保持したまま、対象SHAの状態遷移をマージして書き込む。書き込み直後に本文を再取得し、書き込み前に存在した全`preview-head:<SHA>`の集合が保持され、各SHAが本文の`release-unit`行にちょうど一行ずつ存在し、今回意図した状態遷移（新しい`open`行の追加、`open`→`resolved`、`open`→`abandoned`（置換先`status=open`行を同じ書き込みで追加）、`open`→`superseded`（置換先`status=open`行を同じ書き込みで追加）、または`open`→`cancelled`（対象PR/旧HEAD SHAの昇格差分・累積release-unit一覧からの除外確認の読み戻し証拠を同じ書き込みで保持））が反映されていることを検証する。状態文字列の意図した変更自体は行の欠落・重複・競合とはみなさない。SHAの欠落・重複・競合、または意図した状態遷移の未反映があればクローズや別の状態変更を行わず、最新本文を再取得して統合・再適用し、3回試行しても読み戻し検証に成功しない場合は`blocked`としてリリースを阻害する。クローズ操作の直前にもIssue本文を再取得し、未解消の`open`行がゼロであることを再確認する。競合で重複Issueが生じた場合は`created_at`が最古、同値ならIssue番号が最小のIssueを正本にする。重複Issueを閉じる前に、全`release-unit`の一覧・open/resolved/superseded/abandoned/cancelled状態・redaction済み証拠・Issue番号を正本へ移送し、正本Issueのラベルとマーカーを更新する。移送と更新がすべて成功した後にだけ重複Issueへ統合コメントを付けてクローズし、失敗時は重複Issueを閉じずリリースを阻害する。したがって重複起票の不在を保証するのではなく、直前再確認と競合後の完全な統合で最小化する。Search APIの障害・インデックス遅延・プロセス停止では、次回の同じリリースゲート実行があればIssue起票を回復できる。
- 証拠を記録する前に、種別を問わず資格情報・認証情報・署名鍵・接続文字列・署名付きURL・個人識別値をすべて `(redacted)` に置換する。代表例はアクセストークン、リフレッシュトークン、`client_secret`、Cookie、`session_id`、`EVENTSUB_REPLAY_SECRET`、PlanetScale接続文字列、Cloudflare APIトークン、Twitch EventSub署名シークレット、OAuthの`code`/`state`である。未加工のログやスクリーンショットは添付せず、redaction済みの抜粋だけを証拠として記録する。
- 通常のリリースは、レビュー判定、必須CI、preview検証、必要な実経路確認、main昇格、productionデプロイ、タグとリリース本文の確認を順に満たしてから完了とする。緊急本番修正だけは明示的な例外として、最小テストと静的検証後に復旧を優先できるが、復旧後に独立レビューと未達ゲートの充足を終えるまで成功扱いにしない。

## Transactional chat outbox

ガチャ確定とチャット通知payloadは
`execute_gacha_transaction_with_chat_outbox` が同じDB transactionでcommitします。
Twitch Chat APIにはidempotency keyがないため配送保証は **at-least-once** です。
通常の同時relayは60秒のowner-fenced leaseで抑止しますが、Twitch送信成功後かつ
DBの`sent`記録前に実行環境が停止した場合だけ、lease失効後に同じ通知が重複し得ます。
欠落を避けるため、この境界では再送を優先します。

- チャット無効時はoutbox行を作らず、DB容量とrelay負荷を増やしません。
- 429、5xx、通信障害は1分、5分、15分、60分のbackoffで最大5回試行します。
- scope/credential欠落、429以外の4xx、不正payloadは`dead`へ移し、後続を塞ぎません。
- N連は最終drawのtransactionで全`gacha_history`を順序付き再構成し、全件揃った
  完成済み`pending`だけを作ります。途中失敗で配送不能な`building`行を残しません。
- N連途中のDB一時障害は、ライブWebhookへ2xxを返す前に生通知を7日TTLのKV durable
  inboxへ保存します。Cron replayが確定済みprefixを飛ばして残りを完遂し、最終drawが
  outboxを組み立てます。KV保存にも失敗した通常時だけ503を返してTwitch再送を要求します。
- `{num}`、`{unique}`、`{all}`、`{newCards}`はガチャcommit時点の値をoutboxへ保存し、
  relay時に現在の所有数/catalogを再読込しません。backoff中に別ガチャや設定変更が
  起きても、初回に送る予定だった本文を維持します。
- `sent`は7日、`dead`は調査用に30日保持した後、Cron relayが削除します。
- DB outbox relayはmaintenance EventSubのKV一覧取得より先に実行します。KV障害中も
  チャットbacklogは1回につき最大`limit`件ずつ進みます。

保証境界は新RPCを使うアプリrevisionのdeploy時刻です。schema-first期間に旧RPCで
すでに全drawが完了した履歴は、当時チャット送信済みか判定できないためbackfillせず、
重複通知を避けます。旧revisionで一部だけ完了し、新revisionで最終drawを再開した
バッチは、最終transactionが既存履歴を再構成してoutboxを作ります。

### 障害確認

```sql
SELECT id, batch_id, status, expected_draw_count, assembled_draw_count,
       attempt_count, next_attempt_at, lease_expires_at, last_error,
       created_at, sent_at, dead_at
FROM chat_notification_outbox
WHERE status IN ('pending', 'processing', 'dead')
ORDER BY created_at;
```

`dead`を再送する前に、`last_error`、Twitch scope/token、payload、対応する
`gacha_history.event_id`を確認します。N連が部分完了してoutbox自体が無い場合は、
通知行だけを手作業で作らず、ガチャ部分完了の原因を先に調査します。再送して安全だと
確認した`dead` 1件だけを次のように戻し、管理relayを1回実行します。

```sql
UPDATE chat_notification_outbox
SET status = 'pending',
    attempt_count = 0,
    next_attempt_at = now(),
    lease_id = NULL,
    lease_expires_at = NULL,
    last_error = NULL,
    dead_at = NULL,
    updated_at = now()
WHERE id = '<confirmed-outbox-uuid>'::uuid
  AND status = 'dead';
```

```bash
EVENTSUB_REPLAY_SECRET=... npm run replay:maintenance-eventsub -- \
  --url=https://<target-preview-or-production-host> --limit=20
```

復旧後は対象行が`sent`になり、同じ`batch_id`のチャットが高々1回追加されたことを
確認します。送信成功後のack前停止を意図的に再現した試験では重複が許容結果です。

CIはPostgreSQL 17 serviceへPlanetScale baselineと全追加migrationを順次適用し、
旧/新RPC、single/N連、歯抜け復旧、NULL副作用0、権限、lease fencingを実SQLで検証します。
SQL本文の文字列検査だけをmigration構文のgateにしてはいけません。
