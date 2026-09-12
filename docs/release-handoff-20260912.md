# TwiCa preview累積リリース／Issue #1549 引き継ぎ

更新基準日: 2026-09-12  
対象リポジトリ: `azumag/twica`

この文書は、preview累積リリースとIssue #1549 / PR #1552の残件を後続作業者へ渡すための記録です。文書追加だけのWIPであり、preview/main/productionへのマージやデプロイを許可するものではありません。

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
- openでAPI上のmergeable=true: #1534 / #1532 / #1493 / #1491
- #1493はIssue #1494のprivacy公開粒度判断が付くまでマージしない

作業開始時に必ず各値を再取得してください。過去のローカルclone、Issue本文、古いコメントのSHAを現行値として扱わないでください。

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

PR #1552本文と作業記録には、TypeScript、unit、integration、PostgreSQL 17.10 migration/競合fixture、i18n、migration order、maintenance surface、cursor/429/duplicate/lease fencing、375px相当のローカルUI検証が成功したと記録されています。これは過去記録であり、現在のpreview HEADに対する再実行結果ではありません。

PR #1552はpreviewへマージ済みですが、次の実経路・現行HEAD確認を省略してmain/productionへ進めないでください。

## 後続作業チェックリスト

- [ ] preview / main / open PRの最新HEAD・mergeable・review thread・全CI jobを再取得
- [ ] #1549コード契約（summary互換、cursor再開、owner fencing、競合縮退、500文字制限）を現行treeで再確認
- [ ] `docs/QA.md` の該当Preview実経路を実施し、対象HEAD・時刻・結果を記録
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

## 運用ルール

- Full resetを使用しない
- preview/main/productionへ勝手にマージ・デプロイしない
- shared checkoutを直接変更しない。分離worktreeを使う
- secrets、token、接続文字列、個人情報を記録しない
- 「APIで確認」「過去記録」「未確認」を分けて書く
