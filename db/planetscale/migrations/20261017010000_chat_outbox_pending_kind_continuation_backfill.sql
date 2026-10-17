-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1665 Step 4: 保存済みpartial cursor（delivery_cursor > 0 かつ delivery_cursor < expected_draw_count）
-- を持つ既存 pending / lease失効 processing 行の pending_kind を 'continuation' へ修正する backfill migration。
--
-- 背景:
--   Step 1 migration (20260922100000) で pending_kind 列を追加したが、DEFAULT は 'initial' である。
--   既存行のうち、その時点でN連チャットが途中まで配信済み（delivery_cursor が progress 済み）で
--   pending / processing 状態に留まっていたものは、bounded 配送経路の claim 時に
--   pending_kind='initial' として扱われ、試行回数 (attempt_count) を消費してしまう。
--   この migration で pending_kind='continuation' に補正することで、 bounded delivery の
--   claimChatNotificationForBoundedDelivery がそれらを「予算切れ continuaation」として
--   扱い、attempt_count を消費せずに再開できる。
--
-- 重要:
--   - delivery_cursor 自体は一切変更しない。進捗が残ったまま continuity へ移行する（reset しない）。
--   - pending_kind='initial' の行だけを対象とし、continuation/retry に既に分類された行は触らない
--     （冒頭以降の再実行でも結果が変わらない冪等 migration）。
--   - status が pending または lease 失効済み processing の行だけが対象。lease 有効中の processing 行は
--     旧 owner がまだ作業中とみなし触らない。
--   - 1回の実行あたり最大 200 行に制限する（上限付き）。残りは再実行で収束する。

WITH to_update AS (
  SELECT id
  FROM public.chat_notification_outbox
  WHERE (
          status = 'pending'
          OR (status = 'processing' AND lease_expires_at <= now())
        )
    AND delivery_cursor > 0
    AND delivery_cursor < expected_draw_count
    AND pending_kind = 'initial'
  ORDER BY created_at ASC, id ASC
  LIMIT 200
)
UPDATE public.chat_notification_outbox AS target
SET pending_kind = 'continuation',
    updated_at = now()
FROM to_update
WHERE target.id = to_update.id;

COMMENT ON COLUMN public.chat_notification_outbox.pending_kind IS
  '次回claim時にattempt_countを消費する理由。initial/retry=消費する。continuation\n  （予算内に完走できず正常に途中終了した続き）は消費しない (Issue #1665)。\n  20261017010000: 保存済みpartial cursor行の backfill により correction 済み。';
