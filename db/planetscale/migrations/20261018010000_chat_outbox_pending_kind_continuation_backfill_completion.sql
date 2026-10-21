-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1665 Step 4 補完: 20261017010000（chat_outbox_pending_kind_continuation_backfill）は
-- 対象を CTE + LIMIT 200 で打ち切っていたため、適用時点で対象が201行以上あった環境では
-- 残件が pending_kind='initial' のまま「適用済み」として確定している。
-- この migration は、その残件を1回の apply で残らず補正する（Step 4 の完了）。
--
-- なぜ 20261017010000 を直接直さないか:
--   db-migrate はファイル内容全体の SHA-256 を twica_meta.schema_migrations へ記録し、
--   適用済み version の checksum が変わっていると checksumMismatches として即エラー終了する
--   （scripts/lib/db-migrate-core.js の computeChecksum / scripts/db-migrate.js の
--   hasBlockingErrors）。20261017010000 は preview で適用済み
--   （PlanetScale Migrations run 38955902112, 2026-10-16T19:35:09Z に
--   [applied] 20261017010000 chat_outbox_pending_kind_continuation_backfill）であり、
--   内容を編集すると次回以降の apply / verify が必ず失敗する。
--   したがって補正は「新しい version の追加 migration」として行う。
--
-- 対象と効果は 20261017010000 と同一（predicate も同じ）:
--   - status が pending または lease 失効済み processing の行だけ。lease 有効中の
--     processing 行は旧 owner が作業中とみなし触らない。
--   - delivery_cursor > 0 かつ delivery_cursor < expected_draw_count（保存済み partial cursor）。
--   - pending_kind='initial' の行だけ（冪等。再適用しても結果が変わらない）。
--   - delivery_cursor は一切変更しない（進捗を reset しない）。
--   - attempt_count を消費せずに再開できるのは status='pending' の continuation 行だけ
--     （claimChatNotificationForBoundedDelivery の claim_attempt_increment が 0 になるのは
--     status='pending' かつ pending_kind='continuation' のときだけ）。lease 失効 processing 行は
--     分類のみを揃え、回収時の attempt_count は従来どおり 1 消費される。
--   - 打ち切り（LIMIT 等）を置かず、1回の apply で残件0まで収束させる。理由は 20261017010000 と
--     同じ runner 制約（1ファイルを1回実行し、同じ transaction で履歴登録。登録済み version は
--     次回 apply の対象外、ファイル変更は再実行ではなく checksum 不一致エラー）。
--
-- 残件が0の環境では UPDATE 0行の no-op になるため、20261017010000 が上限内で完了していた
-- 環境へ適用しても安全（PlanetScale Migrations workflow は main / preview の両方で同じ
-- migration 集合を適用する）。
--
-- トランザクション規模（見込み・実件数は未計測）: 対象は 20261017010000 適用時に200行を
-- 超えていた残件のみ。通常は小数（〜数十行）と見込み、単一 UPDATE で数秒想定。
--
-- 適用後の残件0確認（0 でなければ残っている。その場合は追加の backfill 手順を別途起票する）:
--   SELECT count(*) FROM public.chat_notification_outbox
--   WHERE (status = 'pending' OR (status = 'processing' AND lease_expires_at <= now()))
--     AND delivery_cursor > 0
--     AND delivery_cursor < expected_draw_count
--     AND pending_kind = 'initial';

UPDATE public.chat_notification_outbox
SET pending_kind = 'continuation',
    updated_at = now()
WHERE (
        status = 'pending'
        OR (status = 'processing' AND lease_expires_at <= now())
      )
  AND delivery_cursor > 0
  AND delivery_cursor < expected_draw_count
  AND pending_kind = 'initial';
