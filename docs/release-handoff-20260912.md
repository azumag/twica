# TwiCa preview累積リリース／Issue #1549 引き継ぎ

更新基準日: 2026-09-12  
対象リポジトリ: `azumag/twica`

この文書は、preview累積リリースとIssue #1549 / PR #1552の残件を後続作業者へ渡すための記録です。このWIPは引き継ぎ文書だけを変更し、preview/main/productionへのマージやデプロイを許可するものではありません。

## GitHub APIで確認した基準状態

- `preview`: `99a0d69a79a98e3d059cb7fc0481b63d130c1b2b`
  - `test: N連チャット設定をproduction alias経由で検証 (#1562)`
  - parent `afb96220a04bb49b7541b7b6c2fd249b258ed006`
- `main`: `a69016808edcb0671cba62568a3cfd95c63ff2c8`
- PR #1552: merged
  - head `c607e8eaf23a9122c8bd8497e4957676fa34e9a3`
  - preview merge `b871c88efaf2d5290bf309eec41caa202bc91e49`
- PR #1562: merged
  - head `71c206140ee9548b1b429cf9e12b901237dc7938`
  - preview merge `99a0d69a79a98e3d059cb7fc0481b63d130c1b2b`
- openでAPI上のmergeable=true:
  - #1564（draft、base=`preview`。この文書自身を更新するWIPのため、HEAD SHAは本文へ固定せずPR APIから再取得する）
  - #1534 `34e5d9a812119938635e77641b6f8842ad6bce80`
  - #1532 `a6c9deef03a6b132df1b934ddbb380324a8177ba`
  - #1493 `2c6cb69a94d293f109e34b5ddb94a0962bbebb79`
  - #1491 `f0f8c9a708e468fdd5069392b3d941010bfe5767`
- #1493はIssue #1494のprivacy公開粒度判断が付くまでマージしない

作業開始時に必ず各値を再取得してください。過去のローカルclone、Issue本文、古いコメントのSHAを現行値として扱わないでください。特に#1564はこの文書の更新自体でHEADが変わるため、本文中の過去HEADを現行値として扱わないでください。

## 2026-09-12 再取得結果

### 現行preview / WIP

- `preview` / `main` は上記SHAから変化なし。
- PR #1564 は再取得時点で `draft=true` / `mergeable=true`、review 0件、未解決review thread 0件、PRコメント0件。
- #1564の文書更新前HEAD `4015baa24f808d816ef940a04bf39384bf9ec0a6`ではCI #3003 / Release PR template contract #393がsuccess。
- 1回目の再検証追記後HEAD `32cc499a671ca12ee496290c8e7adaf15d04f8fe`ではCI #3004 / Release PR template contract #394がsuccess。docs-onlyのためCIのruntime test / migration等はpath filterでskipし、Detect changed pathsのみsuccess。
- **この文書を含む最新#1564 HEADは自己参照を避けるため本文へ固定しない。再開時は必ずPR APIからHEADとworkflowを取得する。**
- `preview` exact HEAD `99a0d69a79a98e3d059cb7fc0481b63d130c1b2b` のpush:
  - CI #3002: success
  - Release PR template contract #392: success
  - Cloudflare Deploy Support #1060: success
  - CIの `test` jobではtypecheck、overlay realtime Worker typecheck、Supabase shutdown independence、maintenance write surface、unit、integrationがsuccess。
  - Application build without Supabase variablesもsuccess。
  - 一方、変更パス条件によりanalysis dashboard build、workflow lint、PostgreSQL 17 migration、i18n lint、通常lint、migration orderはこのpushではskip。PR #1552で過去に成功した証跡を、現行preview HEADでの再実行結果と混同しない。
  - Cloudflare Deploy Supportではpreview room Workerのbuild/deployはsuccess。legacy app deploy / auxiliary-workersはこのrunではskipのため、実previewアプリ配備やブラウザ実経路QAの完了根拠にはしない。

### 他のopen preview PR

- #1534 / #1532 / #1493 / #1491 は現在もopen / mergeable=true、未解決review thread 0件で、各exact HEADのCI / Release contractはsuccess。
- ただし各HEADは現行`preview`より古いmerge baseから分岐している。
  - #1534 / #1532: 現行previewに対して56 commits behind
  - #1493 / #1491: 現行previewに対して61 commits behind
- よって既存exact HEADの成功だけで「現行previewとの累積統合後も検証済み」とは扱わない。昇格前は累積release-unitとして再レビュー・再テストする。
- #1493は上記に加えて#1494のprivacy判断とPreview実経路1〜5が未完了。

### #1549 現行tree再確認

現行`preview`の実装を再読し、少なくとも静的契約として次を再確認した。

- `summary` / `individual` / `chunked`、chunk 2〜5・既定3、固定1.6秒。
- individual/chunkedは500文字上限内に構造情報（draw範囲・rarity・省略件数）を残す。
- summaryは既存`sendChatAnnouncement`経路を維持する。
- paced送信は保存済み`delivery_cursor`から開始し、`sent`または`duplicate`確定後だけcursorを前進する。
- cursor保存失敗・lease喪失時は次segmentへ進まない。
- cursor更新は現lease ownerだけが成功し、`greatest()`で後退しない。
- migration既定値は既存ユーザー/既存outboxとも`summary` / chunk 3 / cursor 0。
- outbox INSERT時に設定をsnapshotし、同一配信者の先行paced通知と競合した未開始通知はDBロック下でsummaryへ永続縮退する。
- 設定APIは認証、CSRF、rate limit、mode/chunk validationを持つ。
- UIはradio 3種、chunked時だけ2〜5枚select、分割時のpacing注意文、保存状態を持つ。

PR #1562によりVitestでもproduction alias経由で設定コンポーネントを開くテストが追加され、summary初期表示、chunked選択、chunk size変更、PUT保存、pacing案内は自動テスト対象になった。ただしこれは実previewブラウザ・実viewport 375pxの証跡ではない。

Issue #1561にはDrizzle schemaと`streamer_chat_multi_delivery_settings` / outbox新配送列の型整合が任意改善として残っている。Issue本文どおりraw SQLの現行配送・設定処理に対するマージブロッカーではなく、DDL/migrationを正本として別差分で扱う。

## #1549 / #1552の実装契約

- `summary`: 既存 `sendChatAnnouncement` の本文・1投稿動作を維持する既定値
- `individual`: 1枚ずつ順番に送信
- `chunked`: 2〜5枚単位、既定3枚
- 分割間隔は約1.6秒固定
- outboxへ `delivery_mode` / `delivery_chunk_size` / `delivery_cursor` / 解決済み状態をsnapshot
- segment成功または `msg_duplicate` 確定後だけ、現lease ownerがcursorを前進
- cursor保存失敗・lease喪失時は次segmentを送信しない
- 429 / 5xx / timeoutは既存backoffへ戻し、保存済みcursorから再開
- 全segment完了後だけoutbox全体を `sent`
- 同一配信者で先行paced outboxが `pending` / `processing` の場合、未開始の後発分割outboxをsummaryへ永続縮退
- INSERT時に設定をsnapshotし、retry途中の設定変更でsegment構成を変えない
- migration適用後の既存outbox・既存配信者はsummary / cursor 0
- 設定APIは認証・CSRF・rate limit・mode/chunk size検証・maintenance write surfaceに対応
- ja/en feature messagesと静的i18n key検査を追加
- Issue #1548のカード名一覧設定廃止は含めない
- individual/chunkedのsegmentは500文字以内。長いカード名はカード名部分だけを省略し、draw範囲・rarity・省略件数を保持する

## 記録済みの検証と未確認の境界

PR #1552本文と作業記録には、TypeScript、unit、integration、PostgreSQL 17.10 migration/競合fixture、i18n、migration order、maintenance surface、cursor/429/duplicate/lease fencing、375px相当のローカルUI検証が成功したと記録されています。これは過去記録です。現行preview HEADでは上記「2026-09-12 再取得結果」に記載した範囲だけを再確認済みとして扱ってください。

`docs/QA.md`ではDB変更はPreview実経路1〜7、EventSub/gachaは1〜6、chatは1〜4を要求します。#1549/#1552はDB migration + EventSub/gacha + chatを含むため、最終的には1〜7をすべて対象にします。実引き換え、overlay、chat、EventSub direct、WebSocket/polling gap recovery、analysis対DB照合、upload/権限/Workerログの実証を省略してmain/productionへ進めないでください。

## 後続作業チェックリスト

- [x] preview / main / open PRの最新HEAD・mergeable・review threadを再取得
- [x] `preview` exact HEADのworkflow / CI jobを再取得し、successとpath-filter skipを区別して記録
- [x] #1549コード契約（summary互換、cursor再開、owner fencing、競合縮退、500文字制限）を現行treeで再確認
- [ ] open preview PRを現行previewへ統合する時点で、累積release-unitとして再レビュー・再CIする
- [ ] `docs/QA.md` のPreview実経路1〜7を実施し、対象HEAD・時刻・結果を記録
- [ ] 実チャネルポイント引き換え、履歴/注文、overlay、Twitch chat、EventSub、WebSocket/polling gap recoveryを確認
- [ ] 必要なOBS demo、upload/permission/logのQAを確認
- [ ] ja/en設定UIを実previewで確認（radio 3種、chunked時だけ枚数select、1.6秒注意文、保存、折りたたみ、375px横幅）
- [ ] analysis RPCと基礎SQLの比較は、許可された限定read接続が用意できた場合だけ実施。管理者接続や秘密情報で代替しない
- [ ] previewゲート完了後だけpreview→main promotion PRを作成
- [ ] mainマージ、production配備、tag確認を別ゲートとして順に記録

## 残リスク・判断待ち

- Issue #1494のprivacy bucket判断が未完了。#1493は判断まで保留
- preview実経路QA・analysis read-only接続は未確認扱い
- 過去の375pxブラウザ観測では設定画面の横幅超過があった。現行previewで再確認し、修正時は対象branchと差分を明記
- Twitch送信成功直後・cursor保存前の停止では、at-least-once境界により同一segment再送の余地がある。保存済みcursorからの通常retry重複は修正済み
- API/CI/deploymentを取得できないときは成功扱いにしない
- Issue #1561のDrizzle schema型整合は任意改善。#1549の実経路ゲートと混同せず、必要なら別PRで扱う

## 運用ルール

- Full resetを使用しない
- preview/main/productionへ勝手にマージ・デプロイしない
- shared checkoutを直接変更しない。分離worktreeを使う
- secrets、token、接続文字列、個人情報を記録しない
- 「APIで確認」「過去記録」「未確認」を分けて書く
