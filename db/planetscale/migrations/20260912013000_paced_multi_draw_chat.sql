-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1549: N連チャットをsummary / individual / chunkedで配送するための設定と、
-- 分割配送の再開cursorを追加する。既存行・既存配信者はsummaryへ固定し、deployで
-- 通知内容が変わらないよう後方互換を維持する。

CREATE TABLE public.streamer_chat_multi_delivery_settings (
  streamer_id uuid PRIMARY KEY REFERENCES public.streamers(id) ON DELETE CASCADE,
  delivery_mode text NOT NULL DEFAULT 'summary'
    CHECK (delivery_mode IN ('summary', 'individual', 'chunked')),
  chunk_size integer NOT NULL DEFAULT 3
    CHECK (chunk_size BETWEEN 2 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 既存outboxは全件summary/cursor=0になる。migration適用前にcommit済みの通知を
-- 新workerが突然分割しないため、NOT NULL DEFAULTを明示する。
ALTER TABLE public.chat_notification_outbox
  ADD COLUMN delivery_mode text NOT NULL DEFAULT 'summary'
    CHECK (delivery_mode IN ('summary', 'individual', 'chunked')),
  ADD COLUMN delivery_chunk_size integer NOT NULL DEFAULT 3
    CHECK (delivery_chunk_size BETWEEN 2 AND 5),
  ADD COLUMN delivery_cursor integer NOT NULL DEFAULT 0
    CHECK (delivery_cursor >= 0),
  ADD COLUMN delivery_mode_resolved boolean NOT NULL DEFAULT false;

-- transactional outbox RPC本体を再定義せず、INSERT直前にその時点の配信者設定を
-- outbox行へ焼き込む。これによりretry途中で設定が変わってもsegment分割は不変で、
-- delivery_cursorが同じ決定的segment indexを指し続ける。
CREATE OR REPLACE FUNCTION public.snapshot_chat_outbox_delivery_settings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_streamer_id uuid;
BEGIN
  BEGIN
    v_streamer_id := nullif(NEW.payload #>> '{streamer,id}', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_streamer_id := NULL;
  END;

  SELECT settings.delivery_mode, settings.chunk_size
    INTO NEW.delivery_mode, NEW.delivery_chunk_size
    FROM public.streamer_chat_multi_delivery_settings settings
    WHERE settings.streamer_id = v_streamer_id;

  IF NOT FOUND THEN
    NEW.delivery_mode := 'summary';
    NEW.delivery_chunk_size := 3;
  END IF;
  NEW.delivery_cursor := 0;
  NEW.delivery_mode_resolved := false;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS snapshot_chat_outbox_delivery_settings
  ON public.chat_notification_outbox;
CREATE TRIGGER snapshot_chat_outbox_delivery_settings
  BEFORE INSERT ON public.chat_notification_outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.snapshot_chat_outbox_delivery_settings();

REVOKE ALL ON TABLE public.streamer_chat_multi_delivery_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_chat_multi_delivery_settings TO service_role;
REVOKE ALL ON FUNCTION public.snapshot_chat_outbox_delivery_settings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_chat_outbox_delivery_settings() TO service_role;

-- Reserve one paced sequence per channel before its first external send. created_at is
-- the INSERT transaction's start time, not commit order: an older transaction can become
-- visible after a newer row has already started. Serialize decisions, and treat an already
-- reserved row as busy regardless of age. A summary fallback is persisted too, so retry
-- cannot switch message formats when the competing row finishes.
CREATE FUNCTION public.resolve_chat_outbox_delivery_mode(p_id uuid, p_lease_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_streamer_id text;
  v_row public.chat_notification_outbox%ROWTYPE;
  v_mode text;
BEGIN
  SELECT payload #>> '{streamer,id}' INTO v_streamer_id
    FROM public.chat_notification_outbox WHERE id = p_id;
  IF v_streamer_id IS NULL THEN RETURN NULL; END IF;

  -- A transaction-scoped lock is released before Twitch I/O. Every decision for this
  -- channel uses the same key, including callers whose outboxes committed out of order.
  PERFORM pg_advisory_xact_lock(hashtextextended('chat-paced:' || v_streamer_id, 0));
  SELECT * INTO v_row FROM public.chat_notification_outbox
    WHERE id = p_id AND status = 'processing' AND lease_id = p_lease_id
    FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_row.delivery_mode_resolved OR v_row.delivery_cursor > 0 THEN
    RETURN v_row.delivery_mode;
  END IF;

  v_mode := v_row.delivery_mode;
  IF v_mode <> 'summary' AND EXISTS (
    SELECT 1 FROM public.chat_notification_outbox busy
    WHERE busy.id <> p_id
      AND busy.status IN ('pending', 'processing')
      AND busy.delivery_mode IN ('individual', 'chunked')
      AND busy.expected_draw_count > 1
      AND busy.payload #>> '{streamer,id}' = v_streamer_id
      AND (
        busy.delivery_mode_resolved OR busy.delivery_cursor > 0
        OR (busy.created_at, busy.id) < (v_row.created_at, v_row.id)
      )
  ) THEN
    v_mode := 'summary';
  END IF;

  UPDATE public.chat_notification_outbox
    SET delivery_mode = v_mode, delivery_mode_resolved = true, updated_at = now()
    WHERE id = p_id AND status = 'processing' AND lease_id = p_lease_id;
  RETURN v_mode;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_chat_outbox_delivery_mode(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_chat_outbox_delivery_mode(uuid, uuid) TO service_role;

CREATE INDEX chat_notification_outbox_paced_channel_idx
  ON public.chat_notification_outbox ((payload #>> '{streamer,id}'), created_at, id)
  WHERE status IN ('pending', 'processing') AND delivery_mode IN ('individual', 'chunked');

COMMENT ON TABLE public.streamer_chat_multi_delivery_settings IS
  'N連チャット通知の配送方式。outbox INSERT時に設定をsnapshotしretry中の変更から隔離する (Issue #1549)。';
COMMENT ON COLUMN public.chat_notification_outbox.delivery_cursor IS
  '分割N連で次に送信するsegment index。各segment確定後にowner-fencedで単調増加させる。';
