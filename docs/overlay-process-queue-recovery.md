# Overlay processQueue recovery reference

`src/app/overlay/[streamerId]/page.tsx` の `processQueue` / `runProtected` /
`handleQueueError` に関する保守用の参照メモです。

## 障害とフォローアップの関係

- Issue #999 は、実イベント受信後に `processQueue` 内の例外で表示ロックが残り、
  以後のガチャカード表示まで止まり得る障害の起点です。
- Issue #1002 は #999 修正後の例外処理・テスト・コメント整理を追跡する
  フォローアップです。
- PR #1239 は #1002 のうちコメントだけを簡潔化する変更で、実行挙動は変更しません。
- Issue #1240 は #1239 の任意改善を分離して追跡します。

## 回復経路の契約

`setTimeout` で遅延実行される表示チェーンは、それを予約した外側の `try/catch` の
動的スコープ外です。そのため遅延コールバックは `runProtected` で保護します。

`handleQueueError` からの再開を `setTimeout(() => processQueueRef.current(), 0)` にするのは、
連続する失敗を同期再帰で処理してコールスタックを消費し続けないためです。
表示ロックが解放・再開されない場合、後続のガチャイベントを受信しても表示キューが
進まなくなるため、この yield は耐障害性の一部です。

## 対応する回帰テスト

`tests/unit/components/overlay-page.test.tsx` の以下を対応する契約テストとして扱います。

- `processQueue中に例外が発生してもロックが残らず、後続カードの表示を継続する(Issue #999回帰)`
- `setTimeoutでスケジュールされる表示チェーン内の例外でもロックが残らない(Issue #999レビュー指摘#1回帰)`
- `連続する例外がマクロタスク経由で処理され、同期再帰でスタックを消費しない(Issue #999レビュー指摘#2回帰)`

この回復経路を変更するときは、少なくとも上記3件を同じ契約として確認し、
`setTimeout(..., 0)` を単なる遅延ではなく同期再帰を切るための境界として扱います。

Refs #999, #1002, #1240
