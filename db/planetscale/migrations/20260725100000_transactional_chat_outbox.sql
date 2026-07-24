-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #708/#803: ガチャ確定とTwitchチャット通知を原子的に結ぶtransactional outbox。
--
-- 外部API送信をDB transaction内で実行するとロック時間と障害範囲が拡大するため、
-- ガチャ履歴/カード付与と同じexecute_gacha_transaction内では配送payloadだけを
-- 永続化する。配送Workerは後から短いclaim UPDATEで所有権を取得して送信する。
-- Twitch Chat APIにはidempotency keyがないため配送保証はat-least-onceであり、
-- 送信成功直後からsent記録前の停止時だけ重複し得る（欠落より再送を優先する）。
CREATE TABLE public.chat_notification_outbox (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  batch_id text NOT NULL UNIQUE,
  payload_version smallint NOT NULL DEFAULT 1 CHECK (payload_version = 1),
  payload jsonb NOT NULL,
  expected_draw_count integer NOT NULL CHECK (expected_draw_count > 0),
  assembled_draw_count integer NOT NULL CHECK (
    assembled_draw_count > 0 AND assembled_draw_count = expected_draw_count
  ),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  dead_at timestamptz,
  CHECK (
    (status = 'processing' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_id IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('pending', 'processing') AND sent_at IS NULL AND dead_at IS NULL)
    OR (status = 'sent' AND sent_at IS NOT NULL AND dead_at IS NULL)
    OR (status = 'dead' AND dead_at IS NOT NULL AND sent_at IS NULL)
  )
);

CREATE INDEX chat_notification_outbox_due_idx
  ON public.chat_notification_outbox (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE INDEX chat_notification_outbox_expired_lease_idx
  ON public.chat_notification_outbox (lease_expires_at)
  WHERE status = 'processing';

-- relayは送信済みを7日、調査用DLQを30日だけ保持して削除する。partial indexにより
-- payload本体を全走査せず期限行を探せ、outboxが無制限にDB容量を消費しない。
CREATE INDEX chat_notification_outbox_sent_cleanup_idx
  ON public.chat_notification_outbox (sent_at)
  WHERE status = 'sent';

CREATE INDEX chat_notification_outbox_dead_cleanup_idx
  ON public.chat_notification_outbox (dead_at)
  WHERE status = 'dead';

-- PostgreSQLでは「旧7引数」と「追加引数にDEFAULTを持つ11引数」を同名overloadに
-- すると旧呼出しがambiguousになる。schema-first期間の旧アプリを壊さないよう、
-- 新アプリ専用のversioned別名・全引数必須RPCとして追加し、旧RPCは変更しない。
CREATE FUNCTION public.execute_gacha_transaction_with_chat_outbox(
  p_event_id text,
  p_user_twitch_id text,
  p_user_twitch_username text,
  p_card_id uuid,
  p_streamer_id uuid,
  p_reward_cost integer,
  p_reward_id text,
  p_chat_batch_id text,
  p_draw_index integer,
  p_draw_count integer,
  p_collection_name text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id uuid;
  v_history_id uuid;
  v_max_issuance_count integer;
  v_issued_count integer;
  v_cards_payload jsonb;
  v_outbox_count integer;
  v_card_count integer;
  v_unique_count integer;
  v_all_count integer;
  v_new_card_names jsonb;
  v_is_duplicate boolean := false;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'event_id must not be null';
  END IF;
  -- PostgreSQLの比較演算はNULLをfalseではなくunknownにするため、範囲比較だけでは
  -- NULLを拒否できない。履歴だけ作ってoutboxを組み立てない半端な成功を防ぐ。
  IF p_draw_index IS NULL OR p_draw_count IS NULL
     OR p_draw_index < 1 OR p_draw_count < 1 OR p_draw_count > 15
     OR p_draw_index > p_draw_count THEN
    RAISE EXCEPTION 'invalid draw position: %/%', p_draw_index, p_draw_count;
  END IF;
  IF p_chat_batch_id IS NOT NULL
     AND p_event_id <> (CASE
       WHEN p_draw_index = 1 THEN p_chat_batch_id
       ELSE p_chat_batch_id || ':' || p_draw_index::text
     END) THEN
    RAISE EXCEPTION 'event_id does not match chat batch draw position';
  END IF;

  -- Twitch再送・live/Cron replayが同じeventを別transactionで同時実行し得る。
  -- card行だけをlockすると、別cardを抽選した再送は直列化されず、同じcardでも
  -- 先行COMMIT後の発行上限をduplicate判定より先に見て誤返金し得る。event_idの
  -- 64bit hashをtransaction advisory lockにし、同一eventのduplicate確認から
  -- outbox再構成までを直列化する。hash衝突は無関係な2件を一時直列化するだけで、
  -- correctnessや権限境界を壊さない。
  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id, 803));

  -- duplicate final drawでも下の全履歴再構成を実行する。歯抜けbatchで不足drawを
  -- 埋めた後、既存の最終eventへ到達した場合にoutboxを作り損ねないため。
  SELECT id INTO v_history_id
  FROM gacha_history
  WHERE event_id = p_event_id;
  v_is_duplicate := FOUND;

  IF NOT v_is_duplicate THEN
    SELECT max_issuance_count
      INTO v_max_issuance_count
      FROM cards
      WHERE id = p_card_id
        AND streamer_id = p_streamer_id
        AND is_active = true
      FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('is_duplicate', false, 'limit_reached', true);
    END IF;

    IF v_max_issuance_count IS NOT NULL THEN
      SELECT COUNT(*) INTO v_issued_count
        FROM user_cards
        WHERE card_id = p_card_id;

      IF v_issued_count >= v_max_issuance_count THEN
        RETURN jsonb_build_object('is_duplicate', false, 'limit_reached', true);
      END IF;
    END IF;

    INSERT INTO gacha_history (
      event_id, user_twitch_id, user_twitch_username, card_id, streamer_id,
      reward_cost, reward_id
    )
    VALUES (
      p_event_id, p_user_twitch_id, p_user_twitch_username, p_card_id,
      p_streamer_id, p_reward_cost, p_reward_id
    )
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id INTO v_history_id;

    IF v_history_id IS NULL THEN
      -- pre-check後に同じeventを別transactionがcommitした競合。カード付与はせず、
      -- duplicate finalなら下のoutbox再構成だけを安全に試みる。
      v_is_duplicate := true;
    ELSE
      INSERT INTO users (twitch_user_id, twitch_username, twitch_display_name)
      VALUES (p_user_twitch_id, p_user_twitch_username, p_user_twitch_username)
      ON CONFLICT (twitch_user_id) DO NOTHING;

      SELECT id INTO v_user_id FROM users WHERE twitch_user_id = p_user_twitch_id;

      IF v_user_id IS NOT NULL THEN
        INSERT INTO user_cards (user_id, card_id, obtained_at)
        VALUES (v_user_id, p_card_id, now());
      END IF;
    END IF;
  END IF;

  IF p_chat_batch_id IS NOT NULL AND p_draw_index = p_draw_count THEN
    -- N連途中にbuilding行を残すと、webhookが2xxを返した後の部分失敗で永久孤児に
    -- なる。最終drawのtransaction内で、確定済みgacha_historyをevent_id順に
    -- 再構成し、全件揃った場合だけ完成済みpendingを1件作る。
    WITH expected_events AS (
      SELECT
        draw_index,
        CASE
          WHEN draw_index = 1 THEN p_chat_batch_id
          ELSE p_chat_batch_id || ':' || draw_index::text
        END AS event_id
      FROM generate_series(1, p_draw_count) AS draw(draw_index)
    ),
    ordered_cards AS (
      SELECT
        expected_events.draw_index,
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'description', c.description,
          'image_url', c.image_url,
          'rarity', c.rarity,
          'drop_rate', c.drop_rate,
          'max_issuance_count', c.max_issuance_count
        ) AS card_payload
      FROM expected_events
      JOIN gacha_history gh ON gh.event_id = expected_events.event_id
      JOIN cards c ON c.id = gh.card_id
      WHERE gh.streamer_id = p_streamer_id
        AND gh.user_twitch_id = p_user_twitch_id
    )
    SELECT jsonb_agg(card_payload ORDER BY draw_index), count(*)::integer
      INTO v_cards_payload, v_outbox_count
      FROM ordered_cards;

    IF v_outbox_count <> p_draw_count THEN
      RAISE EXCEPTION 'chat outbox history incomplete for batch %: expected %, found %',
        p_chat_batch_id, p_draw_count, v_outbox_count;
    END IF;

    -- chat無効時は所有数集約もoutbox INSERTも実行しない。enabled streamerの1行
    -- 存在確認だけに絞り、通知を使わない配信者のガチャコストを増やさない。
    IF EXISTS (
      SELECT 1
      FROM streamers
      WHERE id = p_streamer_id
        AND chat_announcement_enabled = true
    ) THEN
      -- 所有数系placeholderをrelay時に再問合せすると、retry待ちの別ガチャやカード
      -- 設定変更で元の通知本文が変わる。ユーザー所持を1回だけ集約し、{num}、
      -- {unique}、{all}、{newCards}をこのtransactionの同一statement snapshotで
      -- 固定する。relayはこのversioned値だけを使い、外部送信リトライを決定的にする。
      WITH user_card_counts AS (
      SELECT
        uc.card_id,
        count(*)::integer AS final_count,
        bool_or(c.is_active = true) AS is_active
      FROM users u
      JOIN user_cards uc ON uc.user_id = u.id
      JOIN cards c
        ON c.id = uc.card_id
       AND c.streamer_id = p_streamer_id
      WHERE u.twitch_user_id = p_user_twitch_id
      GROUP BY uc.card_id
    ),
    expected_events AS (
      SELECT
        draw_index,
        CASE
          WHEN draw_index = 1 THEN p_chat_batch_id
          ELSE p_chat_batch_id || ':' || draw_index::text
        END AS event_id
      FROM generate_series(1, p_draw_count) AS draw(draw_index)
    ),
    drawn_card_counts AS (
      SELECT
        gh.card_id,
        min(expected_events.draw_index) AS first_draw_index,
        count(*)::integer AS drawn_count,
        min(c.name) AS card_name
      FROM expected_events
      JOIN gacha_history gh ON gh.event_id = expected_events.event_id
      JOIN cards c ON c.id = gh.card_id
      GROUP BY gh.card_id
    )
    SELECT
      coalesce((
        SELECT final_count
        FROM user_card_counts
        WHERE card_id = (v_cards_payload -> 0 ->> 'id')::uuid
      ), 0),
      (SELECT count(*)::integer FROM user_card_counts WHERE is_active),
      (
        SELECT count(*)::integer
        FROM cards
        WHERE streamer_id = p_streamer_id
          AND is_active = true
      ),
      coalesce((
        SELECT jsonb_agg(drawn.card_name ORDER BY drawn.first_draw_index)
        FROM drawn_card_counts drawn
        JOIN user_card_counts owned ON owned.card_id = drawn.card_id
        WHERE owned.final_count > 0
          AND owned.final_count - drawn.drawn_count <= 0
      ), '[]'::jsonb)
      INTO v_card_count, v_unique_count, v_all_count, v_new_card_names;

      -- chat無効時はoutbox自体を作らず、DB容量・relay負荷をゼロにする。設定値と
      -- payloadはこのtransaction時点のsnapshotなので、後続relayで設定が変わっても
      -- 当該引き換えの通知内容を再現できる。
      INSERT INTO public.chat_notification_outbox (
      batch_id, payload_version, payload, expected_draw_count,
      assembled_draw_count, status
    )
    SELECT
      p_chat_batch_id,
      1,
      jsonb_build_object(
        'batchId', p_chat_batch_id,
        'broadcasterTwitchUserId', s.twitch_user_id,
        'userId', p_user_twitch_id,
        'streamer', jsonb_build_object(
          'id', s.id,
          'chat_announcement_enabled', s.chat_announcement_enabled,
          'chat_announcement_template', s.chat_announcement_template,
          'chat_announcement_multi_template', s.chat_announcement_multi_template,
          'chat_announcement_multi_show_cards', s.chat_announcement_multi_show_cards,
          'default_card_pack_name', s.default_card_pack_name
        ),
        'gachaResult', jsonb_build_object(
          'type', 'gacha',
          'card', v_cards_payload -> 0,
          'cards', v_cards_payload,
          'userTwitchUsername', p_user_twitch_username,
          'rewardId', p_reward_id,
          'collectionName', p_collection_name
        ),
        'chatSnapshot', jsonb_build_object(
          'cardCount', v_card_count,
          'uniqueCount', v_unique_count,
          'allCount', v_all_count,
          'newCardNames', v_new_card_names
        )
      ),
      p_draw_count,
      p_draw_count,
      'pending'
    FROM streamers s
    WHERE s.id = p_streamer_id
      AND s.chat_announcement_enabled = true
      ON CONFLICT (batch_id) DO NOTHING;
    END IF;
  END IF;

  IF v_is_duplicate THEN
    RETURN jsonb_build_object(
      'is_duplicate', true,
      -- final duplicateは歯抜け/応答消失回復で再構成した完全なカード列を返す。
      -- アプリは残drawだけの配列をoverlay batchとして誤採番せずに済む。
      'cards', CASE
        WHEN p_chat_batch_id IS NOT NULL AND p_draw_index = p_draw_count
          THEN v_cards_payload
        ELSE NULL
      END
    );
  END IF;

  RETURN jsonb_build_object(
    'is_duplicate', false,
    'limit_reached', false,
    'history_id', v_history_id,
    'cards', CASE
      WHEN p_chat_batch_id IS NOT NULL AND p_draw_index = p_draw_count
        THEN v_cards_payload
      ELSE NULL
    END
  );
END;
$$;

COMMENT ON TABLE public.chat_notification_outbox IS
  'Twitch chat transactional outbox. At-least-once delivery; sent後のack前停止時は重複し得る。';

COMMENT ON FUNCTION public.execute_gacha_transaction_with_chat_outbox(
  text, text, text, uuid, uuid, integer, text, text, integer, integer, text
) IS
  'ガチャ確定とchat outbox組立を同一transactionで実行するversioned RPC。旧7引数RPCはschema-first互換のため別名で残す。';

REVOKE ALL ON FUNCTION public.execute_gacha_transaction_with_chat_outbox(
  text, text, text, uuid, uuid, integer, text, text, integer, integer, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.chat_notification_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_notification_outbox TO service_role;
GRANT EXECUTE ON FUNCTION public.execute_gacha_transaction_with_chat_outbox(
  text, text, text, uuid, uuid, integer, text, text, integer, integer, text
) TO service_role;
