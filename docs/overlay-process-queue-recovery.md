# Overlay processQueue recovery reference

`src/app/overlay/[streamerId]/page.tsx` の `processQueue` / `runProtected` /
`handleQueueError` に関する保守用の参照メモです。

## 回復経路の契約

`setTimeout` で遅延実行される表示チェーンは、それを予約した外側の `try/catch` の
動的スコープ外です。そのため遅延コールバックは `runProtected` で保護します。

`handleQueueError` からの再開を `setTimeout(() => processQueueRef.current(), 0)` にするのは、
連続する失敗を同期再帰で処理してコールスタックを消費し続けないためです。
表示ロックが解放・再開されない場合、後続のガチャイベントを受信しても表示キューが
進まなくなるため、この yield は耐障害性の一部です。

## ソースコメントの保守方針

`processQueue` 周辺のソースコメントは、レビュー時の呼称や指摘番号そのものではなく、
将来の変更でも成立する実行時の不変条件を説明します。特に次の理由を残します。

- タイマー callback は、それを登録した外側の `try/catch` では捕捉できない
- エラー後の再開を次のマクロタスクへ送ることで、連続失敗時の同期再帰を避ける
- cleanup 後の古いタイマー callback は generation guard で新しい購読へ影響させない

Issue / PR 番号は追跡用の補助情報として扱い、実装の理由そのものは上記の恒久的な
契約で説明します。経緯の詳細はこの文書と関連 Issue に集約します。

## 対応する回帰テスト

`tests/unit/components/overlay-page.test.tsx` では、実装時の経緯に依存する呼称ではなく、
次の恒久的な回復契約を確認します。

- `processQueue` 中の例外後も表示ロックを残さず、後続カードの処理を継続する
- `setTimeout` で予約した表示チェーン内の例外も `runProtected` で回収する
- 連続する例外の再開をマクロタスクへ譲り、同期再帰でスタックを消費しない

この回復経路を変更するときは、少なくとも上記3件を同じ契約として確認し、
`setTimeout(..., 0)` を単なる遅延ではなく同期再帰を切るための境界として扱います。

Refs #999, #1002, #1308
