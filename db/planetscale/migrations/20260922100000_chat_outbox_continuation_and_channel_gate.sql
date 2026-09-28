-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1665: N連ガチャのチャット通知が、EventSub HTTPレスポンスに紐づく1回の
-- waitUntil()完走に依存しているため、時間超過で途中停止すると欠落する。
-- この加法的migrationは、その修正で使う2つの独立した状態を追加する:
--
-- 1. pending_kind / wake_reserved_until（chat_notification_outbox）:
--    予算内に完走できず正常に途中終了した「continuation」を、一時障害からの
--    「retry」と区別する。continuationはCHAT_OUTBOX_MAX_ATTEMPTSの試行回数を
--    消費しない（正常な分割を失敗として扱わないため）。wake_reserved_untilは
--    回収sweeperが同じ未処理行へQueue wake-upを無制限に再投入しないための
--    短い予約期限。
-- 2. chat_channel_send_gate: 配信者チャンネル単位で外部送信の間隔
--    （既定1.6秒）を守るための単調増加するnext_send_at。summary/individual/
--    chunkedのどの経路から送っても、また別outbox行・別Worker実行にまたがっても
--    同じgateを共有する。
--
-- 両方とも既存の同期処理（chat-notification-outbox.ts の
-- claimChatNotificationBatch/claimDueChatNotifications、
-- eventsub-redemption-delivery.ts）は一切変更しない。新しい列・新しいテーブルを
-- 参照するのは、このmigration以降に追加される新しいbounded配送経路
-- （chat-notification-delivery.ts等）だけであり、それらは初期状態で無効化されて
-- いるため、アプリが本migration適用前に先行deployされても既存の同期処理は
-- 何も壊れない（Workers Builds はコードdeployとmigrationが独立して進みうる。
-- 20260912013000_paced_multi_draw_chat.sql の「RETURNING * deliberately avoids
-- naming additive delivery columns」と同じ設計判断）。

ALTER TABLE public.chat_notification_outbox
  ADD COLUMN pending_kind text NOT NULL DEFAULT 'initial'
    CHECK (pending_kind IN ('initial', 'retry', 'continuation')),
  ADD COLUMN wake_reserved_until timestamptz;

COMMENT ON COLUMN public.chat_notification_outbox.pending_kind IS
  '次回claim時にattempt_countを消費する理由。initial/retry=消費する。continuation
  （予算内に完走できず正常に途中終了した続き）は消費しない (Issue #1665)。';
COMMENT ON COLUMN public.chat_notification_outbox.wake_reserved_until IS
  '回収sweeperがこの行へQueue wake-upを起票済みとみなす予約期限。到達済み
  （またはNULL）の行だけがsweep対象になり、無制限な再enqueueを防ぐ
  (Issue #1665)。';

-- 回収sweeperが「まだwake-up未予約 かつ 期限到来済み」のpending行だけを安く
-- 絞り込むための部分index。processing/sent/dead行はこのindexに載らない。
CREATE INDEX chat_notification_outbox_wake_due_idx
  ON public.chat_notification_outbox (next_attempt_at, created_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- チャネル単位の送信間隔gate
-- ---------------------------------------------------------------------------
-- HTTP通信（Twitchへの実送信）をまたいでDB行lockを保持しないよう、gateは
-- 「短い原子的UPDATEで次のスロットを予約するだけ」の設計にする。予約成功後の
-- 実際のTwitch送信は、この関数呼び出しの外（別のDBラウンドトリップ）で行う。
CREATE TABLE public.chat_channel_send_gate (
  broadcaster_twitch_user_id text PRIMARY KEY,
  next_send_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE public.chat_channel_send_gate FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.chat_channel_send_gate TO service_role;

COMMENT ON TABLE public.chat_channel_send_gate IS
  '配信者チャンネル単位の外部送信間隔gate。summary/individual/chunkedの区別なく、
  同じbroadcaster_twitch_user_idへの全送信経路が共有する単調増加する
  next_send_at (Issue #1665)。';

-- 原子的に次の送信スロットを予約する。
-- 戻り値:
--   reserved=true  : 呼び出し元は直ちに送信してよい。next_send_atは
--                     p_interval_ms先へ前進済み（次の呼び出し元はそこまで待つ）。
--   reserved=false : まだ早い。wait_untilまで待ってから再度呼び出すこと。
-- 行のFOR UPDATEロックは、この関数呼び出し1回（1トランザクション）の間だけ
-- 保持される。Twitchへの実際のfetch()はこの関数の外で行うため、外部I/O待ち中に
-- 行ロックを保持することはない。
CREATE FUNCTION public.reserve_chat_channel_send_slot(
  p_broadcaster_twitch_user_id text,
  p_interval_ms integer
) RETURNS TABLE(reserved boolean, wait_until timestamptz)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_next timestamptz;
BEGIN
  INSERT INTO public.chat_channel_send_gate (broadcaster_twitch_user_id, next_send_at)
    VALUES (p_broadcaster_twitch_user_id, now())
    ON CONFLICT (broadcaster_twitch_user_id) DO NOTHING;

  SELECT gate.next_send_at INTO v_next
    FROM public.chat_channel_send_gate gate
    WHERE gate.broadcaster_twitch_user_id = p_broadcaster_twitch_user_id
    FOR UPDATE;

  IF v_next <= now() THEN
    UPDATE public.chat_channel_send_gate
      SET next_send_at = now() + (p_interval_ms::integer * interval '1 millisecond'),
          updated_at = now()
      WHERE broadcaster_twitch_user_id = p_broadcaster_twitch_user_id;
    RETURN QUERY SELECT true, now();
    RETURN;
  END IF;

  RETURN QUERY SELECT false, v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_chat_channel_send_slot(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_chat_channel_send_slot(text, integer) TO service_role;
