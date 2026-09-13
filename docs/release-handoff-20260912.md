# TwiCa preview累積リリース／Issue #1549 引き継ぎ

更新基準日: 2026-09-13  
対象リポジトリ: `azumag/twica`

この文書は、preview累積リリースと Issue #1549 / PR #1552 の残件を後続作業者へ渡すための記録です。このWIPは引き継ぎ文書だけを変更し、preview/main/productionへのマージやデプロイを許可するものではありません。

## 現在の基準状態

2026-09-13 に GitHub API から再取得した値です。過去のローカルclone、Issue本文、古いコメントのSHAを現行値として扱わないでください。

- `preview`: `063da2cfa8a1caa4f8a4a5ae11d83586f09740b8`
  - `docs: proxy移行のbundle検証条件を固定 (#1570)`
- `main`: `a69016808edcb0671cba62568a3cfd95c63ff2c8`
- open `preview` PR は6件:
  - #1564（draft、この文書自身。最新HEADは自己参照を避けて本文へ固定せず、PR APIから毎回取得する）
  - #1565 `04ed72551313ad417bc4258daab4d5d91755cf7b`（draft、#1549のN連Preview E2E mode別QA仕様追従）
  - #1534 `34e5d9a812119938635e77641b6f8842ad6bce80`
  - #1532 `a6c9deef03a6b132df1b934ddbb380324a8177ba`
  - #1493 `2c6cb69a94d293f109e34b5ddb94a0962bbebb79`
  - #1491 `f0f8c9a708e468fdd5069392b3d941010bfe5767`
- 上記6件は再取得時点で `mergeable=true`。各latest exact HEADのformal reviewがあり、未解決review threadは0件。
- #1565 / #1534 / #1532 / #1493 / #1491 の各exact HEADでは CI / Release PR template contract が success。
- #1564 はこの文書更新でHEADが変わるため、更新後のreview / CIを別途そのlatest exact HEADで確認する。
- #1493 は Issue #1494 のprivacy公開粒度判断が付くまでマージしない。

既存exact HEADのCI成功だけで「現在のpreviewとの累積統合後も検証済み」とは扱わない。統合時点で累積release-unitとして再レビュー・再CIする。

## #1549 / #1552 の実装状態

PR #1552 は `preview` へマージ済み。

- PR #1552 exact HEAD: `c607e8eaf23a9122c8bd8497e4957676fa34e9a3`
- preview merge SHA: `b871c88efaf2d5290bf309eec41caa202bc91e49`
- 後続の設定UI回帰 PR #1562 も `preview` へマージ済み。
- Issue #1561 の残件だった設定コンポーネント回帰とDrizzle schema型整合は PR #1562 / #1566 で `preview` へ反映済み。Issue #1561 は `completed` でcloseされており、同内容を再実装しない。

現行treeで維持する契約:

- `summary`: 従来の `sendChatAnnouncement` の1投稿動作を維持する既定値
- `individual`: 1枚ずつ順番に送信
- `chunked`: 2〜5枚単位、既定3枚
- 分割間隔は約1.6秒固定
- individual/chunkedの各segmentは500文字以内にし、長いカード名を省略してもdraw範囲・rarity・省略件数を保持する
- outboxへ `delivery_mode` / `delivery_chunk_size` / `delivery_cursor` / 解決済み状態をsnapshotする
- segment成功または `msg_duplicate` 確定後だけ、現lease ownerがcursorを前進する
- cursor保存失敗・lease喪失時は次segmentを送信しない
- cursorは `greatest()` で後退させない
- 429 / 5xx / timeoutは既存backoffへ戻し、保存済みcursorから再開する
- 全segment完了後だけoutbox全体を `sent` にする
- 同一配信者で先行paced outboxが `pending` / `processing` の場合、未開始の後発分割outboxをsummaryへ永続縮退する
- INSERT時に設定をsnapshotし、retry途中の設定変更でsegment構成を変えない
- migration適用後の既存outbox・既存配信者はsummary / chunk 3 / cursor 0
- 設定APIは認証・CSRF・rate limit・mode/chunk size検証・maintenance write surfaceに対応する
- ja/en feature messagesと静的i18n key検査を維持する
- Issue #1548 のカード名一覧設定廃止は本変更へ含めない

## N連Preview E2E仕様

`docs/E2E_SCENARIO.md` のmode別追従は Draft PR #1565 に分離している。

- exact HEAD: `04ed72551313ad417bc4258daab4d5d91755cf7b`
- docs-only。実preview QAそのものの成功証跡には数えない。
- `summary` / `individual` / `chunked` をそれぞれ実previewで確認する。
- `chunked=3` は4枚以上の実報酬で複数segmentと端数segmentを通す。必要な実報酬を用意できない場合は低枚数テストで代替完了扱いにしない。
- overlay / Twitch chat の順序・枚数、outboxのsnapshot mode/chunk size・最終cursor・resolved状態を確認する。
- DB列確認用の限定read接続が無い場合は、そのDB証跡だけを未確認として残し、管理者接続や秘密情報で代替しない。
- 通常の実引き換えE2Eと、429/5xx/cursor/lease fencingの内部保守テストを別物として記録する。

## 記録済み検証と未確認の境界

PR #1552 の作業記録では、TypeScript、unit、integration、PostgreSQL migration/競合fixture、i18n、migration order、maintenance surface、cursor/429/duplicate/lease fencing、375px相当のローカルUI検証が成功している。これは過去の自動/ローカル検証記録であり、実previewブラウザ・実Twitch・実DB経路の証跡へ読み替えない。

`docs/QA.md` ではDB変更はPreview実経路1〜7、EventSub/gachaは1〜6、chatは1〜4を要求する。#1549/#1552はDB migration + EventSub/gacha + chatを含むため、最終的には1〜7を対象とする。

残る実経路:

- 実previewで `summary` / `individual` / `chunked` を確認
- 実チャネルポイント引き換え、履歴/注文、overlay、Twitch chat、EventSub directを確認
- WebSocket / polling gap recoveryを確認
- ja/en設定UIを実previewで確認（radio 3種、chunked時だけ枚数select、1.6秒注意文、保存、折りたたみ、375px横幅）
- 必要なOBS demo、upload/permission、Worker/error-reporterログを確認
- analysis RPCと基礎SQLの比較は、許可された限定read接続が用意できた場合だけ実施する

実環境証跡を取得できない項目は成功扱いにしない。

## 他のopen preview PR

- #1534: コード上の必須事項なし。Preview実経路1〜5待ち。
- #1532: コード上の必須事項なし。Preview実経路1〜6待ち。
- #1493: コード上の必須事項なし。Preview実経路1〜5に加え、Issue #1494 のprivacy公開粒度判断待ち。
- #1491: コード上の必須事項なし。Preview実経路1〜7待ち。
- #1565: QA手順のdocs-only Draft。実preview QA証跡ではない。

これらは外部実経路待ちだけを理由に他の安全な軽量改善を停止しない。ただし各PRを統合する時点では、現在のpreviewを含む累積release-unitとして再レビュー・再CIする。

## 後続作業チェックリスト

- [x] preview / main / open PRの最新HEAD・mergeability・review threadを再取得
- [x] #1549コード契約（summary互換、cursor再開、owner fencing、競合縮退、500文字制限）を現行treeで再確認
- [x] N連E2Eのmode別期待値追従をDraft PR #1565として分離し、CIを確認
- [ ] PR #1565をpreviewへ反映する場合、latest exact HEADを再レビュー・再CIする（実preview QA完了とは別扱い）
- [ ] open preview PRを統合する時点で、累積release-unitとして再レビュー・再CIする
- [ ] `docs/QA.md` のPreview実経路1〜7を実施し、対象HEAD・時刻・結果を記録する
- [ ] `docs/E2E_SCENARIO.md` のN連mode別手順でsummary / individual / chunkedを実preview確認する
- [ ] 実チャネルポイント引き換え、履歴/注文、overlay、Twitch chat、EventSub、WebSocket/polling gap recoveryを確認する
- [ ] 必要なOBS demo、upload/permission/logのQAを確認する
- [ ] ja/en設定UIを実previewで確認する
- [ ] analysis RPCと基礎SQLの比較は、許可された限定read接続が用意できた場合だけ実施する
- [ ] previewゲート完了後だけpreview→main promotion PRを作成する
- [ ] mainマージ、production配備、tag確認を別ゲートとして順に記録する

## 残リスク・判断待ち

- Issue #1494 のprivacy公開粒度判断が未完了。#1493は判断まで保留する。
- Preview実経路QA・analysis read-only接続は未確認扱い。
- Draft PR #1565はQA手順の追従だけで、実preview QA証跡ではない。
- Twitch送信成功直後・cursor保存前の停止では、at-least-once境界により同一segment再送の余地がある。保存済みcursorからの通常retry重複は修正済み。
- API/CI/deploymentを取得できないときは成功扱いにしない。

## 運用ルール

- Full resetを使用しない。
- preview/main/productionへ勝手にマージ・デプロイしない。
- secrets、token、接続文字列、個人情報を記録しない。
- 「APIで確認」「過去記録」「未確認」を分けて書く。
