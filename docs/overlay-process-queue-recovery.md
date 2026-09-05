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

## 対応する回帰テスト

`tests/unit/components/overlay-page.test.tsx` では、レビュー履歴上の呼称ではなく、
次の恒久的な回復契約を確認します。

- `processQueue` 中の例外後も表示ロックを残さず、後続カードの処理を継続する
- `setTimeout` で予約した表示チェーン内の例外も `runProtected` で回収する
- 連続する例外の再開をマクロタスクへ譲り、同期再帰でスタックを消費しない

この回復経路を変更するときは、少なくとも上記3件を同じ契約として確認し、
`setTimeout(..., 0)` を単なる遅延ではなく同期再帰を切るための境界として扱います。

Refs #999, #1002, #1308
