--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10 (Debian 17.10-1.pgdg13+1)
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg13+1)

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;
SET LOCAL idle_in_transaction_session_timeout = 0;
SET LOCAL transaction_timeout = 0;
SET LOCAL client_encoding = 'UTF8';
SET LOCAL standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', true);
SET LOCAL check_function_bodies = false;
SET LOCAL xmloption = content;
SET LOCAL client_min_messages = warning;
SET LOCAL row_security = off;

--
-- Name: activate_support_code(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.activate_support_code(p_code_hash text, p_twitch_user_id text, p_fanbox_id text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_code_record RECORD;
  v_license_id UUID;
  v_deactivated_count INTEGER;
  v_plan_priority JSONB := '{"support": 1, "patron": 2}'::JSONB;
  v_new_priority INTEGER;
BEGIN
  -- 1. コードを排他ロックで取得（レースコンディション防止）
  -- NOTE: SELECT INTO で行が見つからない場合、FOUND = false となる
  -- v_code_record IS NULL ではなく NOT FOUND を使用すること（PostgreSQL の RECORD 型仕様）
  SELECT id, plan_type, status
    INTO v_code_record
    FROM support_codes
    WHERE code_hash = p_code_hash
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'INVALID_CODE');
  END IF;

  IF v_code_record.status = 'revoked' THEN
    RETURN jsonb_build_object('error', 'CODE_REVOKED');
  END IF;

  IF v_code_record.status = 'rotating' THEN
    RETURN jsonb_build_object('error', 'CODE_ROTATING');
  END IF;

  -- 2. 同一コードの既存ライセンスをチェック（DELETE前に判定することでデータ消失を防止）
  -- このチェックにより、再アクティベーション時にDELETEが実行されることを防ぐ
  IF EXISTS (
    SELECT 1 FROM user_licenses
    WHERE twitch_user_id = p_twitch_user_id
      AND code_id = v_code_record.id
  ) THEN
    RETURN jsonb_build_object('error', 'ALREADY_ACTIVATED');
  END IF;

  -- 3. 新コードの優先度を取得
  v_new_priority := (v_plan_priority ->> v_code_record.plan_type)::INTEGER;

  -- 4. 新コードより上位のライセンスを削除（ダウングレード処理）
  -- 有効なコード(active/rotating)に紐づくライセンスのみを対象とする
  DELETE FROM user_licenses ul
    USING support_codes sc
    WHERE ul.code_id = sc.id
      AND ul.twitch_user_id = p_twitch_user_id
      AND sc.status IN ('active', 'rotating')
      AND (v_plan_priority ->> ul.plan_type)::INTEGER > v_new_priority;
  GET DIAGNOSTICS v_deactivated_count = ROW_COUNT;

  -- 5. ライセンスを挿入（UNIQUE制約で重複を検知、ステップ2で事前チェック済みだが防衛的に残す）
  INSERT INTO user_licenses (twitch_user_id, code_id, plan_type, fanbox_id)
  VALUES (p_twitch_user_id, v_code_record.id, v_code_record.plan_type, p_fanbox_id)
  ON CONFLICT (twitch_user_id, code_id) DO NOTHING
  RETURNING id INTO v_license_id;

  IF v_license_id IS NULL THEN
    -- ステップ2で事前チェックしているため、ここに到達するのは極めて稀な並行実行時のみ
    RETURN jsonb_build_object('error', 'ALREADY_ACTIVATED');
  END IF;

  -- 6. activation_count をインクリメント
  UPDATE support_codes
    SET activation_count = activation_count + 1,
        updated_at = NOW()
    WHERE id = v_code_record.id;

  RETURN jsonb_build_object(
    'success', true,
    'plan_type', v_code_record.plan_type,
    'license_id', v_license_id,
    'deactivated_count', v_deactivated_count
  );
END;
$$;


--
-- Name: FUNCTION activate_support_code(p_code_hash text, p_twitch_user_id text, p_fanbox_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.activate_support_code(p_code_hash text, p_twitch_user_id text, p_fanbox_id text) IS 'サポートコードをアクティベートし、ユーザーにライセンスを付与する。排他ロックでレースコンディションを防止';


--
-- Name: batch_update_card_drop_rates(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.batch_update_card_drop_rates(p_streamer_id uuid, p_updates jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_updated_count INT;
BEGIN
  -- JSONB配列の各要素を展開し、cardsテーブルをJOIN UPDATEで一括更新
  -- intra_rarity_weight は COALESCE で既存値をフォールバックに使い、未指定時は変更しない
  UPDATE cards
  SET
    drop_rate = (u.value->>'drop_rate')::DECIMAL(5,4),
    intra_rarity_weight = COALESCE(
      (u.value->>'intra_rarity_weight')::NUMERIC,
      cards.intra_rarity_weight
    ),
    updated_at = NOW()
  FROM jsonb_array_elements(p_updates) AS u(value)
  WHERE cards.id = (u.value->>'id')::UUID
    AND cards.streamer_id = p_streamer_id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  RETURN jsonb_build_object('updated_count', v_updated_count);
END;
$$;


--
-- Name: FUNCTION batch_update_card_drop_rates(p_streamer_id uuid, p_updates jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.batch_update_card_drop_rates(p_streamer_id uuid, p_updates jsonb) IS '複数カードのdrop_rateを1回のDB呼び出しで一括更新。Cloudflare Workersのサブリクエスト制限対策';


--
-- Name: card_stone_value_for_rarity(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_stone_value_for_rarity(p_rarity text) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  RETURN CASE p_rarity
    WHEN 'legendary' THEN 20
    WHEN 'epic' THEN 8
    WHEN 'rare' THEN 3
    ELSE 1
  END;
END;
$$;


--
-- Name: check_pack_rarity_weights_values(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_pack_rarity_weights_values(weights jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
DECLARE
  entry_key TEXT;
  entry_value JSONB;
  entry_count INTEGER;
BEGIN
  IF weights IS NULL THEN
    RETURN TRUE;
  END IF;

  IF jsonb_typeof(weights) <> 'object' THEN
    RETURN FALSE;
  END IF;

  -- 上限51件 = 事前登録パック上限50件(00062のCHECK) + __default__ 1件。
  SELECT COUNT(*) INTO entry_count FROM jsonb_object_keys(weights);
  IF entry_count > 51 THEN
    RETURN FALSE;
  END IF;

  FOR entry_key IN SELECT jsonb_object_keys(weights) LOOP
    entry_value := weights -> entry_key;

    -- check_rarity_weights_values(NULL) は TRUE を返す設計のため、ここで
    -- 明示的に object 型であることを確認しないと、JSON null や配列などの
    -- 非object値が誤って通ってしまう。
    IF jsonb_typeof(entry_value) <> 'object' THEN
      RETURN FALSE;
    END IF;

    IF NOT public.check_rarity_weights_values(entry_value) THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;


--
-- Name: check_rarity_weights_values(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_rarity_weights_values(weights jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  key TEXT;
  val NUMERIC;
BEGIN
  IF weights IS NULL THEN
    RETURN TRUE;
  END IF;

  IF jsonb_typeof(weights) <> 'object' THEN
    RETURN FALSE;
  END IF;

  FOR key IN SELECT jsonb_object_keys(weights) LOOP
    IF jsonb_typeof(weights->key) <> 'number' THEN
      RETURN FALSE;
    END IF;

    val := (weights->>key)::NUMERIC;
    IF val < 0 OR val > 100 THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;


--
-- Name: deactivate_all_licenses(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.deactivate_all_licenses(p_twitch_user_id text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  DELETE FROM user_licenses
    WHERE twitch_user_id = p_twitch_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_count', v_deleted_count
  );
END;
$$;


--
-- Name: FUNCTION deactivate_all_licenses(p_twitch_user_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.deactivate_all_licenses(p_twitch_user_id text) IS 'ユーザーの全ライセンスを削除してBasicプランに復帰させる。冪等性あり';


--
-- Name: exchange_duplicate_card_for_stones(text, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.exchange_duplicate_card_for_stones(p_twitch_user_id text, p_card_id uuid, p_request_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_user_id UUID;
  v_streamer_id UUID;
  v_rarity TEXT;
  v_duplicate_count INTEGER;
  v_user_card_id UUID;
  v_stones INTEGER;
  v_balance INTEGER;
  v_existing card_stone_transactions%ROWTYPE;
  v_inserted_id UUID;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'REQUEST_ID_REQUIRED';
  END IF;

  SELECT id INTO v_user_id
  FROM users
  WHERE twitch_user_id = p_twitch_user_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 冪等性チェック: 同じ (user_id, request_id) が既に処理済みなら、
  -- 副作用を一切起こさずに以前の結果を再現して返す。
  -- Idempotency: if this (user_id, request_id) was already processed,
  -- replay the previous result without any side effects.
  SELECT * INTO v_existing
  FROM card_stone_transactions
  WHERE user_id = v_user_id
    AND request_id = p_request_id;

  IF FOUND THEN
    SELECT balance INTO v_balance
    FROM card_stone_balances
    WHERE user_id = v_user_id
      AND streamer_id = v_existing.streamer_id;

    RETURN jsonb_build_object(
      'cardId', v_existing.card_id,
      'stonesGained', v_existing.amount,
      'balance', COALESCE(v_balance, 0),
      'remainingCount', (
        SELECT COUNT(*)
        FROM user_cards
        WHERE user_id = v_user_id
          AND card_id = v_existing.card_id
      ),
      'idempotentReplay', true
    );
  END IF;

  SELECT streamer_id, rarity INTO v_streamer_id, v_rarity
  FROM cards
  WHERE id = p_card_id;

  IF v_streamer_id IS NULL THEN
    RAISE EXCEPTION 'CARD_NOT_FOUND';
  END IF;

  PERFORM 1
  FROM user_cards
  WHERE user_id = v_user_id
    AND card_id = p_card_id
  FOR UPDATE;

  SELECT COUNT(*) INTO v_duplicate_count
  FROM user_cards
  WHERE user_id = v_user_id
    AND card_id = p_card_id;

  IF v_duplicate_count <= 1 THEN
    RAISE EXCEPTION 'NO_DUPLICATE_CARD';
  END IF;

  SELECT id INTO v_user_card_id
  FROM user_cards
  WHERE user_id = v_user_id
    AND card_id = p_card_id
  ORDER BY obtained_at DESC, id DESC
  LIMIT 1;

  v_stones := card_stone_value_for_rarity(v_rarity);

  -- 取引行を先に挿入し、(user_id, request_id) の競合（並行する再送）が
  -- あれば DO NOTHING で何も起こさない。挿入できた場合のみ実際の交換を進める。
  -- Insert the transaction row first; if a concurrent retry already inserted the
  -- same (user_id, request_id), DO NOTHING and treat it as an idempotent replay.
  INSERT INTO card_stone_transactions (
    user_id,
    streamer_id,
    card_id,
    user_card_id,
    amount,
    type,
    request_id
  )
  VALUES (
    v_user_id,
    v_streamer_id,
    p_card_id,
    v_user_card_id,
    v_stones,
    'duplicate_exchange',
    p_request_id
  )
  ON CONFLICT (user_id, request_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    -- 並行リクエストが先に処理済み。副作用を起こさず以前の結果を返す。
    -- A concurrent request won the race. Replay its result without side effects.
    SELECT * INTO v_existing
    FROM card_stone_transactions
    WHERE user_id = v_user_id
      AND request_id = p_request_id;

    SELECT balance INTO v_balance
    FROM card_stone_balances
    WHERE user_id = v_user_id
      AND streamer_id = v_existing.streamer_id;

    RETURN jsonb_build_object(
      'cardId', v_existing.card_id,
      'stonesGained', v_existing.amount,
      'balance', COALESCE(v_balance, 0),
      'remainingCount', (
        SELECT COUNT(*)
        FROM user_cards
        WHERE user_id = v_user_id
          AND card_id = v_existing.card_id
      ),
      'idempotentReplay', true
    );
  END IF;

  DELETE FROM user_cards
  WHERE id = v_user_card_id;

  INSERT INTO card_stone_balances (user_id, streamer_id, balance)
  VALUES (v_user_id, v_streamer_id, v_stones)
  ON CONFLICT (user_id, streamer_id)
  DO UPDATE SET
    balance = card_stone_balances.balance + EXCLUDED.balance,
    updated_at = NOW()
  RETURNING balance INTO v_balance;

  RETURN jsonb_build_object(
    'cardId', p_card_id,
    'stonesGained', v_stones,
    'balance', v_balance,
    'remainingCount', v_duplicate_count - 1
  );
END;
$$;


--
-- Name: execute_gacha_transaction(text, text, text, uuid, uuid, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_gacha_transaction(p_event_id text, p_user_twitch_id text, p_user_twitch_username text, p_card_id uuid, p_streamer_id uuid, p_reward_cost integer DEFAULT NULL::integer, p_reward_id text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_user_id UUID;
  v_history_id UUID;
  v_max_issuance_count INTEGER;
  v_issued_count INTEGER;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'event_id must not be null';
  END IF;

  -- Lock the selected card row so concurrent draws cannot exceed its issuance limit.
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

  INSERT INTO gacha_history (event_id, user_twitch_id, user_twitch_username, card_id, streamer_id, reward_cost, reward_id)
  VALUES (p_event_id, p_user_twitch_id, p_user_twitch_username, p_card_id, p_streamer_id, p_reward_cost, p_reward_id)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING id INTO v_history_id;

  IF v_history_id IS NULL AND p_event_id IS NOT NULL THEN
    RETURN jsonb_build_object('is_duplicate', true);
  END IF;

  INSERT INTO users (twitch_user_id, twitch_username, twitch_display_name)
  VALUES (p_user_twitch_id, p_user_twitch_username, p_user_twitch_username)
  ON CONFLICT (twitch_user_id) DO NOTHING;

  SELECT id INTO v_user_id FROM users WHERE twitch_user_id = p_user_twitch_id;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO user_cards (user_id, card_id, obtained_at)
    VALUES (v_user_id, p_card_id, NOW());
  END IF;

  RETURN jsonb_build_object('is_duplicate', false, 'limit_reached', false, 'history_id', v_history_id);
END;
$$;


--
-- Name: FUNCTION execute_gacha_transaction(p_event_id text, p_user_twitch_id text, p_user_twitch_username text, p_card_id uuid, p_streamer_id uuid, p_reward_cost integer, p_reward_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.execute_gacha_transaction(p_event_id text, p_user_twitch_id text, p_user_twitch_username text, p_card_id uuid, p_streamer_id uuid, p_reward_cost integer, p_reward_id text) IS 'ガチャのDB操作を1トランザクションで実行し、カード発行可能枚数の上限検証と報酬ID(reward_id)の記録を同時に行う(Issue #591)。p_event_idはNULL禁止(Issue #661: NULLだとgacha_history.event_idのUNIQUE制約によるON CONFLICT重複検知が無効化されるため)。';


--
-- Name: get_analysis_gacha_summary(timestamp with time zone, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_analysis_gacha_summary(p_from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_streamer_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
WITH filtered AS (
  SELECT gh.*
  FROM gacha_history gh
  WHERE (p_from_date IS NULL OR gh.redeemed_at >= p_from_date)
    AND (p_streamer_id IS NULL OR gh.streamer_id = p_streamer_id)
),
daily AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('date', day_key, 'count', draw_count)
    ORDER BY day_key
  ), '[]'::jsonb) AS rows
  FROM (
    SELECT
      to_char(date_trunc('day', redeemed_at), 'YYYY-MM-DD') AS day_key,
      COUNT(*)::INTEGER AS draw_count
    FROM filtered
    GROUP BY date_trunc('day', redeemed_at)
  ) d
),
rarities AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'name', upper(left(rarity, 1)) || substring(rarity from 2),
      'value', draw_count,
      'rarity', rarity
    )
    ORDER BY draw_count DESC, rarity
  ), '[]'::jsonb) AS rows
  FROM (
    SELECT c.rarity, COUNT(*)::INTEGER AS draw_count
    FROM filtered gh
    JOIN cards c ON c.id = gh.card_id
    GROUP BY c.rarity
    HAVING COUNT(*) > 0
  ) r
),
popular AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'card', jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'rarity', c.rarity,
        'image_url', c.image_url
      ),
      'count', ranked.draw_count
    )
    ORDER BY ranked.draw_count DESC, c.name
  ), '[]'::jsonb) AS rows
  FROM (
    SELECT card_id, COUNT(*)::INTEGER AS draw_count
    FROM filtered
    GROUP BY card_id
    ORDER BY COUNT(*) DESC
    LIMIT 10
  ) ranked
  JOIN cards c ON c.id = ranked.card_id
)
SELECT jsonb_build_object(
  'totalGacha', (SELECT COUNT(*)::INTEGER FROM filtered),
  'uniqueUsers', (SELECT COUNT(DISTINCT user_twitch_id)::INTEGER FROM filtered),
  'legendaryCount', (
    SELECT COUNT(*)::INTEGER
    FROM filtered gh
    JOIN cards c ON c.id = gh.card_id
    WHERE c.rarity = 'legendary'
  ),
  'dailyGachaData', (SELECT rows FROM daily),
  'rarityDistribution', (SELECT rows FROM rarities),
  'popularCards', (SELECT rows FROM popular)
);
$$;


--
-- Name: get_analysis_overview(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_analysis_overview() RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
WITH bounds AS (
  SELECT
    date_trunc('day', now()) AS today_start,
    now() - interval '7 days' AS week_start,
    date_trunc('month', now()) AS month_start
),
day_series AS (
  SELECT generate_series(
    date_trunc('day', now()) - interval '29 days',
    date_trunc('day', now()),
    interval '1 day'
  ) AS day_start
),
user_growth AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.day_start, 'YYYY-MM-DD'),
      'count', COALESCE(u.count, 0)
    )
    ORDER BY ds.day_start
  ) AS rows
  FROM day_series ds
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::INTEGER AS count
    FROM users u
    WHERE u.created_at >= ds.day_start
      AND u.created_at < ds.day_start + interval '1 day'
  ) u ON TRUE
),
gacha_growth AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.day_start, 'YYYY-MM-DD'),
      'count', COALESCE(g.count, 0)
    )
    ORDER BY ds.day_start
  ) AS rows
  FROM day_series ds
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::INTEGER AS count
    FROM gacha_history gh
    WHERE gh.redeemed_at >= ds.day_start
      AND gh.redeemed_at < ds.day_start + interval '1 day'
  ) g ON TRUE
),
recent_gacha AS (
  SELECT COALESCE(jsonb_agg(row_json ORDER BY redeemed_at DESC), '[]'::jsonb) AS rows
  FROM (
    SELECT
      gh.redeemed_at,
      to_jsonb(gh.*)
        || jsonb_build_object(
          'cards', to_jsonb(c.*),
          'streamers', to_jsonb(s.*)
        ) AS row_json
    FROM gacha_history gh
    LEFT JOIN cards c ON c.id = gh.card_id
    LEFT JOIN streamers s ON s.id = gh.streamer_id
    ORDER BY gh.redeemed_at DESC
    LIMIT 10
  ) recent
)
SELECT jsonb_build_object(
  'stats', jsonb_build_object(
    'totalUsers', (SELECT COUNT(*)::INTEGER FROM users),
    'totalStreamers', (SELECT COUNT(*)::INTEGER FROM streamers),
    'totalCards', (SELECT COUNT(*)::INTEGER FROM cards),
    'todayGacha', (
      SELECT COUNT(*)::INTEGER FROM gacha_history gh, bounds b
      WHERE gh.redeemed_at >= b.today_start
    ),
    'weekGacha', (
      SELECT COUNT(*)::INTEGER FROM gacha_history gh, bounds b
      WHERE gh.redeemed_at >= b.week_start
    ),
    'monthGacha', (
      SELECT COUNT(*)::INTEGER FROM gacha_history gh, bounds b
      WHERE gh.redeemed_at >= b.month_start
    )
  ),
  'recentGacha', (SELECT rows FROM recent_gacha),
  'userGrowth', (SELECT rows FROM user_growth),
  'gachaGrowth', (SELECT rows FROM gacha_growth)
);
$$;


--
-- Name: get_analysis_streamer_leaderboard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_analysis_streamer_leaderboard() RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
WITH ranked AS (
  SELECT
    gh.streamer_id,
    COUNT(*)::INTEGER AS draw_count
  FROM gacha_history gh
  WHERE gh.redeemed_at >= now() - interval '30 days'
  GROUP BY gh.streamer_id
  ORDER BY COUNT(*) DESC
  LIMIT 10
)
SELECT COALESCE(jsonb_agg(
  jsonb_build_object(
    'streamerId', ranked.streamer_id,
    'displayName', COALESCE(s.twitch_display_name, 'Unknown'),
    'profileImageUrl', s.twitch_profile_image_url,
    'drawCount', ranked.draw_count
  )
  ORDER BY ranked.draw_count DESC
), '[]'::jsonb)
FROM ranked
LEFT JOIN streamers s ON s.id = ranked.streamer_id;
$$;


--
-- Name: get_analysis_streamers(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_analysis_streamers() RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
WITH card_counts AS (
  SELECT streamer_id, COUNT(*)::INTEGER AS card_count
  FROM cards
  GROUP BY streamer_id
),
vote_campaign_bonus AS (
  SELECT DISTINCT streamer_id
  FROM streamer_storage_bonus
  WHERE type = 'campaign'
    AND memo = '2026選挙応援'
),
system_bot AS (
  SELECT EXISTS (
    SELECT 1
    FROM twitch_bot_accounts
    WHERE owner_type = 'system'
      AND status = 'active'
  ) AS has_active_system_bot
)
SELECT COALESCE(jsonb_agg(
  to_jsonb(s.*)
    || jsonb_build_object(
      'card_count', COALESCE(cc.card_count, 0),
      'storage_bytes', COALESCE(su.bytes_used, 0),
      'has_chat_scope', COALESCE(u.twitch_scopes, '{}'::text[]) @> ARRAY['user:write:chat']::text[],
      'chat_sender_mode', COALESCE(css.sender_mode, 'streamer'),
      'has_active_bot_sender',
        CASE
          WHEN COALESCE(css.sender_mode, 'streamer') = 'custom_bot' THEN
            COALESCE(bot.owner_type = 'streamer'
              AND bot.streamer_id = s.id
              AND bot.status = 'active', FALSE)
          WHEN COALESCE(css.sender_mode, 'streamer') = 'official_bot' THEN
            (SELECT has_active_system_bot FROM system_bot)
          ELSE FALSE
        END,
      'chat_send_available',
        (COALESCE(u.twitch_scopes, '{}'::text[]) @> ARRAY['user:write:chat']::text[])
        OR CASE
          WHEN COALESCE(css.sender_mode, 'streamer') = 'custom_bot' THEN
            COALESCE(bot.owner_type = 'streamer'
              AND bot.streamer_id = s.id
              AND bot.status = 'active', FALSE)
          WHEN COALESCE(css.sender_mode, 'streamer') = 'official_bot' THEN
            (SELECT has_active_system_bot FROM system_bot)
          ELSE FALSE
        END,
      'has_vote_campaign_bonus', vcb.streamer_id IS NOT NULL
    )
  ORDER BY s.created_at DESC, s.id ASC
), '[]'::jsonb)
FROM streamers s
LEFT JOIN card_counts cc ON cc.streamer_id = s.id
LEFT JOIN users u ON u.twitch_user_id = s.twitch_user_id
LEFT JOIN streamer_chat_sender_settings css ON css.streamer_id = s.id
LEFT JOIN twitch_bot_accounts bot ON bot.id = css.custom_bot_account_id
-- digest() は pgcrypto 由来で、Supabase のデフォルト構成では public ではなく
-- extensions スキーマにインストールされる。本関数は SET search_path = public
-- (SECURITY DEFINER の search_path 固定によるインジェクション対策) のため、
-- search_path を広げる代わりに呼び出し側を extensions.digest(...) と明示修飾する。
LEFT JOIN storage_usage su
  ON su.user_prefix = substring(encode(extensions.digest(s.twitch_user_id, 'sha256'), 'hex') from 1 for 8)
LEFT JOIN vote_campaign_bonus vcb ON vcb.streamer_id = s.id;
$$;


--
-- Name: get_analysis_users(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_analysis_users() RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
WITH card_counts AS (
  SELECT user_id, COUNT(*)::INTEGER AS card_count
  FROM user_cards
  GROUP BY user_id
)
-- users.* を to_jsonb() で丸ごと展開すると、analysis側の Database 型に存在しない
-- twitch_access_token / twitch_refresh_token / twitch_token_expires_at 等の
-- 実カラム（migration 00004/00023で追加）まで analysis dashboard の JSON レスポンスに
-- 漏れてしまう。フロントエンドの User 型（analysis/src/types/database.ts）が実際に
-- 使う列だけを明示的に選択し、将来カラムが増えても自動で露出しないようにする。
SELECT COALESCE(jsonb_agg(
  jsonb_build_object(
    'id', u.id,
    'twitch_user_id', u.twitch_user_id,
    'twitch_username', u.twitch_username,
    'twitch_display_name', u.twitch_display_name,
    'twitch_profile_image_url', u.twitch_profile_image_url,
    'tos_accepted_at', u.tos_accepted_at,
    'twitch_scopes', u.twitch_scopes,
    'created_at', u.created_at,
    'updated_at', u.updated_at,
    'user_cards',
    jsonb_build_array(jsonb_build_object('count', COALESCE(cc.card_count, 0)))
  )
  ORDER BY u.created_at DESC
), '[]'::jsonb)
FROM users u
LEFT JOIN card_counts cc ON cc.user_id = u.id;
$$;


--
-- Name: get_card_owner_stats(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_card_owner_stats(p_streamer_id uuid, p_limit_per_card integer DEFAULT 100) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_card_stats JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'card_id', c.id,
      'card_name', c.name,
      'rarity', c.rarity,
      'image_url', c.image_url,
      'owner_count', COALESCE(oc.owner_count, 0),
      'owners', COALESCE(ow.owners, '[]'::JSONB)
    )
    ORDER BY c.rarity_order ASC, c.created_at DESC
  ), '[]'::JSONB)
  INTO v_card_stats
  FROM cards c
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS owner_count
    FROM card_owner_stats s
    WHERE s.streamer_id = p_streamer_id
      AND s.card_id = c.id
  ) oc ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'user_twitch_id', t.user_twitch_id,
        'username', t.username,
        'display_name', t.display_name,
        'owned_count', t.owned_count,
        'last_obtained_at', t.last_obtained_at
      )
      ORDER BY t.owned_count DESC, t.last_obtained_at DESC
    ) AS owners
    FROM (
      SELECT
        s.user_twitch_id,
        s.username,
        s.display_name,
        s.owned_count,
        s.last_obtained_at
      FROM card_owner_stats s
      WHERE s.streamer_id = p_streamer_id
        AND s.card_id = c.id
      ORDER BY s.owned_count DESC, s.last_obtained_at DESC
      LIMIT GREATEST(1, p_limit_per_card)
    ) t
  ) ow ON TRUE
  WHERE c.streamer_id = p_streamer_id
    AND c.is_active = TRUE;

  RETURN jsonb_build_object('card_stats', v_card_stats);
END;
$$;


--
-- Name: get_channel_point_usage_stats(uuid, timestamp with time zone, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_channel_point_usage_stats(p_streamer_id uuid, p_from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 10) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_total_points BIGINT;
  v_ranking JSONB;
BEGIN
  IF p_from_date IS NULL THEN
    SELECT COALESCE(SUM(total_points), 0)::BIGINT
    INTO v_total_points
    FROM channel_point_usage_stats
    WHERE streamer_id = p_streamer_id;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_twitch_id', ranked.user_twitch_id,
        'username', ranked.username,
        'total_points', ranked.total_points,
        'redemption_count', ranked.redemption_count,
        'last_redeemed_at', ranked.last_redeemed_at
      )
      ORDER BY ranked.total_points DESC, ranked.redemption_count DESC, ranked.last_redeemed_at DESC
    ), '[]'::JSONB)
    INTO v_ranking
    FROM (
      SELECT
        user_twitch_id,
        COALESCE(username, user_twitch_id) AS username,
        total_points,
        redemption_count,
        last_redeemed_at::TEXT AS last_redeemed_at
      FROM channel_point_usage_stats
      WHERE streamer_id = p_streamer_id
      ORDER BY total_points DESC, redemption_count DESC, last_redeemed_at DESC
      LIMIT GREATEST(1, p_limit)
    ) ranked;
  ELSE
    SELECT COALESCE(SUM(reward_cost), 0)::BIGINT
    INTO v_total_points
    FROM gacha_history
    WHERE streamer_id = p_streamer_id
      AND redeemed_at >= p_from_date
      AND reward_cost IS NOT NULL
      AND reward_cost > 0;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_twitch_id', ranked.user_twitch_id,
        'username', ranked.username,
        'total_points', ranked.total_points,
        'redemption_count', ranked.redemption_count,
        'last_redeemed_at', ranked.last_redeemed_at
      )
      ORDER BY ranked.total_points DESC, ranked.redemption_count DESC, ranked.last_redeemed_at DESC
    ), '[]'::JSONB)
    INTO v_ranking
    FROM (
      SELECT
        user_twitch_id,
        COALESCE(MAX(user_twitch_username), user_twitch_id) AS username,
        SUM(reward_cost)::BIGINT AS total_points,
        COUNT(*)::INTEGER AS redemption_count,
        MAX(redeemed_at)::TEXT AS last_redeemed_at
      FROM gacha_history
      WHERE streamer_id = p_streamer_id
        AND redeemed_at >= p_from_date
        AND reward_cost IS NOT NULL
        AND reward_cost > 0
      GROUP BY user_twitch_id
      ORDER BY total_points DESC, redemption_count DESC, last_redeemed_at DESC
      LIMIT GREATEST(1, p_limit)
    ) ranked;
  END IF;

  RETURN jsonb_build_object(
    'total_points', v_total_points,
    'ranking', v_ranking
  );
END;
$$;


--
-- Name: get_gacha_drop_stats(uuid, timestamp with time zone, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_gacha_drop_stats(p_streamer_id uuid, p_from_date timestamp with time zone, p_limit_per_card integer DEFAULT 100) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_total_draws BIGINT;
  v_total_weight NUMERIC;
  v_card_stats JSONB;
  v_rarity_stats JSONB;
BEGIN
  SELECT COUNT(*)::BIGINT
  INTO v_total_draws
  FROM gacha_history
  WHERE streamer_id = p_streamer_id
    AND redeemed_at >= p_from_date
    AND event_id NOT LIKE 'manual:%';

  SELECT COALESCE(SUM(drop_rate), 0)::NUMERIC
  INTO v_total_weight
  FROM cards
  WHERE streamer_id = p_streamer_id
    AND is_active = TRUE;

  -- カードごとに gacha_history を引き直す N+1 な LATERAL を避け、
  -- 期間内の履歴を一度だけ (card_id, user_twitch_id) で集計し、
  -- ウィンドウ関数で「カード内の引いた回数ランキング」を付与する。
  -- これにより gacha_history へのアクセスはカード数に依らず一定回数。
  WITH draw_counts AS (
    SELECT card_id, COUNT(*)::BIGINT AS draw_count
    FROM gacha_history
    WHERE streamer_id = p_streamer_id
      AND redeemed_at >= p_from_date
      AND event_id NOT LIKE 'manual:%'
    GROUP BY card_id
  ),
  drawer_agg AS (
    SELECT
      gh.card_id,
      gh.user_twitch_id,
      COALESCE(MAX(gh.user_twitch_username), gh.user_twitch_id) AS username,
      COUNT(*)::BIGINT AS draw_count,
      MAX(gh.redeemed_at) AS last_drawn_at
    FROM gacha_history gh
    WHERE gh.streamer_id = p_streamer_id
      AND gh.redeemed_at >= p_from_date
      AND gh.event_id NOT LIKE 'manual:%'
    GROUP BY gh.card_id, gh.user_twitch_id
  ),
  drawer_ranked AS (
    SELECT
      da.*,
      ROW_NUMBER() OVER (
        PARTITION BY da.card_id
        ORDER BY da.draw_count DESC, da.last_drawn_at DESC
      ) AS rn
    FROM drawer_agg da
  ),
  -- drawer_count はカード内の全ユニークユーザー数（打ち切り前）、
  -- drawers は rn <= p_limit_per_card のみを JSONB 化（上位N件）。
  drawer_by_card AS (
    SELECT
      dr.card_id,
      COUNT(*)::BIGINT AS drawer_count,
      jsonb_agg(
        jsonb_build_object(
          'user_twitch_id', dr.user_twitch_id,
          'username', dr.username,
          'draw_count', dr.draw_count,
          'last_drawn_at', dr.last_drawn_at
        )
        ORDER BY dr.draw_count DESC, dr.last_drawn_at DESC
      ) FILTER (WHERE dr.rn <= GREATEST(1, p_limit_per_card)) AS drawers
    FROM drawer_ranked dr
    GROUP BY dr.card_id
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'card_id', c.id,
      'card_name', c.name,
      'rarity', c.rarity,
      'image_url', c.image_url,
      'configured_rate', CASE
        WHEN v_total_weight > 0 THEN (c.drop_rate / v_total_weight) * 100
        ELSE 0
      END,
      'actual_count', COALESCE(dc.draw_count, 0),
      'actual_rate', CASE
        WHEN v_total_draws > 0 THEN (COALESCE(dc.draw_count, 0)::NUMERIC / v_total_draws) * 100
        ELSE 0
      END,
      'drawer_count', COALESCE(dbc.drawer_count, 0),
      'drawers', COALESCE(dbc.drawers, '[]'::JSONB)
    )
    ORDER BY c.rarity_order ASC, c.created_at DESC
  ), '[]'::JSONB)
  INTO v_card_stats
  FROM cards c
  LEFT JOIN draw_counts dc ON dc.card_id = c.id
  LEFT JOIN drawer_by_card dbc ON dbc.card_id = c.id
  WHERE c.streamer_id = p_streamer_id
    AND c.is_active = TRUE;

  WITH rarity_counts AS (
    SELECT c.rarity, COUNT(*)::BIGINT AS draw_count
    FROM gacha_history gh
    JOIN cards c ON c.id = gh.card_id
    WHERE gh.streamer_id = p_streamer_id
      AND gh.redeemed_at >= p_from_date
      AND gh.event_id NOT LIKE 'manual:%'
    GROUP BY c.rarity
  ),
  default_order AS (
    SELECT *
    FROM (VALUES
      ('legendary'::TEXT, 1),
      ('epic'::TEXT, 2),
      ('rare'::TEXT, 3),
      ('common'::TEXT, 4)
    ) AS r(rarity, sort_order)
  ),
  -- デフォルト4種（排出0でも常に表示）＋ 実際に排出されたカスタムレアリティ。
  -- カスタムは sort_order=5 でデフォルトの後ろ、名前順で安定整列する。
  rarity_universe AS (
    SELECT rarity, sort_order FROM default_order
    UNION
    SELECT rc.rarity, 5
    FROM rarity_counts rc
    WHERE rc.rarity NOT IN (SELECT rarity FROM default_order)
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'rarity', ru.rarity,
      'count', COALESCE(rc.draw_count, 0),
      'rate', CASE
        WHEN v_total_draws > 0 THEN (COALESCE(rc.draw_count, 0)::NUMERIC / v_total_draws) * 100
        ELSE 0
      END
    )
    ORDER BY ru.sort_order, ru.rarity
  )
  INTO v_rarity_stats
  FROM rarity_universe ru
  LEFT JOIN rarity_counts rc ON rc.rarity = ru.rarity;

  RETURN jsonb_build_object(
    'total_draws', v_total_draws,
    'card_stats', v_card_stats,
    'rarity_stats', v_rarity_stats
  );
END;
$$;


--
-- Name: get_gacha_users_for_streamer(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_gacha_users_for_streamer(p_streamer_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_result JSONB;
  v_total INTEGER;
BEGIN
  SELECT COUNT(DISTINCT user_twitch_id) INTO v_total
  FROM gacha_history
  WHERE streamer_id = p_streamer_id;

  IF v_total = 0 THEN
    RETURN jsonb_build_object('users', '[]'::JSONB, 'total', 0);
  END IF;

  SELECT jsonb_build_object(
    'users', COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_twitch_id', ud.user_twitch_id,
        'username', ud.username,
        'draw_count', ud.draw_count,
        'last_draw_at', ud.last_draw_at,
        'unique_card_ids', COALESCE(uc_agg.card_ids, '[]'::JSONB)
      )
      ORDER BY ud.draw_count DESC
    ), '[]'::JSONB),
    'total', v_total
  )
  INTO v_result
  FROM (
    SELECT
      gh.user_twitch_id,
      MAX(gh.user_twitch_username) AS username,
      COUNT(*)::INTEGER AS draw_count,
      MAX(gh.redeemed_at)::TEXT AS last_draw_at
    FROM gacha_history gh
    WHERE gh.streamer_id = p_streamer_id
    GROUP BY gh.user_twitch_id
    ORDER BY draw_count DESC
    LIMIT p_limit OFFSET p_offset
  ) ud
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(card_id ORDER BY card_id), '[]'::JSONB) AS card_ids
    FROM (
      SELECT DISTINCT uc.card_id::TEXT AS card_id
      FROM user_cards uc
      JOIN users u ON u.id = uc.user_id
      JOIN cards c ON c.id = uc.card_id
      WHERE u.twitch_user_id = ud.user_twitch_id
        AND c.streamer_id = p_streamer_id
        AND c.is_active = true
    ) unique_cards
  ) uc_agg ON true;

  RETURN v_result;
END;
$$;


--
-- Name: get_issued_card_counts(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_issued_card_counts(p_card_ids uuid[]) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(
    jsonb_object_agg(counts.card_id, counts.issued_count),
    '{}'::JSONB
  )
  FROM (
    SELECT card_id, COUNT(*)::BIGINT AS issued_count
    FROM user_cards
    WHERE card_id = ANY(p_card_ids)
    GROUP BY card_id
  ) counts;
$$;


--
-- Name: FUNCTION get_issued_card_counts(p_card_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_issued_card_counts(p_card_ids uuid[]) IS '指定した card_id 集合について、user_cards の発行済み枚数を { "<card_id>": <count> } のJSONBオブジェクトとしてDB側でGROUP BY集計して返す(Issue #548)。';


--
-- Name: get_user_card_counts(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_card_counts(p_twitch_user_id text, p_streamer_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id UUID;
  v_result JSONB;
BEGIN
  SELECT id INTO v_user_id
  FROM users
  WHERE twitch_user_id = p_twitch_user_id;

  IF v_user_id IS NULL THEN
    RETURN '[]'::JSONB;
  END IF;

  -- サブクエリでcard_idごとにCOUNTし、card/streamer詳細をJOIN
  -- 10000枚所持でも、ユニークカード数（数百程度）のみ返却される
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'count', sub.cnt,
      'card', to_jsonb(c.*),
      'streamer', to_jsonb(s.*)
    )
  ), '[]'::JSONB)
  INTO v_result
  FROM (
    SELECT card_id, COUNT(*)::INTEGER AS cnt
    FROM user_cards
    WHERE user_id = v_user_id
    GROUP BY card_id
  ) sub
  JOIN cards c ON c.id = sub.card_id
  JOIN streamers s ON s.id = c.streamer_id
  WHERE (p_streamer_id IS NULL OR c.streamer_id = p_streamer_id);

  RETURN v_result;
END;
$$;


--
-- Name: refresh_card_owner_stat(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_card_owner_stat(p_card_id uuid, p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_streamer_id UUID;
  v_twitch_user_id TEXT;
  v_username TEXT;
  v_display_name TEXT;
  v_owned_count INTEGER;
  v_last_obtained_at TIMESTAMPTZ;
BEGIN
  IF p_card_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT streamer_id INTO v_streamer_id
  FROM cards
  WHERE id = p_card_id;

  SELECT twitch_user_id, twitch_username, twitch_display_name
  INTO v_twitch_user_id, v_username, v_display_name
  FROM users
  WHERE id = p_user_id;

  -- カード or ユーザーが解決できない場合は集計不能なのでスキップ。
  IF v_streamer_id IS NULL OR v_twitch_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::INTEGER, MAX(obtained_at)
  INTO v_owned_count, v_last_obtained_at
  FROM user_cards
  WHERE card_id = p_card_id
    AND user_id = p_user_id;

  IF v_owned_count = 0 THEN
    DELETE FROM card_owner_stats
    WHERE streamer_id = v_streamer_id
      AND card_id = p_card_id
      AND user_twitch_id = v_twitch_user_id;
    RETURN;
  END IF;

  INSERT INTO card_owner_stats (
    streamer_id,
    card_id,
    user_twitch_id,
    username,
    display_name,
    owned_count,
    last_obtained_at
  )
  VALUES (
    v_streamer_id,
    p_card_id,
    v_twitch_user_id,
    v_username,
    v_display_name,
    v_owned_count,
    v_last_obtained_at
  )
  ON CONFLICT (streamer_id, card_id, user_twitch_id) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    owned_count = EXCLUDED.owned_count,
    last_obtained_at = EXCLUDED.last_obtained_at,
    updated_at = NOW();
END;
$$;


--
-- Name: refresh_channel_point_usage_stat(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_channel_point_usage_stat(p_streamer_id uuid, p_user_twitch_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_username TEXT;
  v_total_points BIGINT;
  v_redemption_count INTEGER;
  v_last_redeemed_at TIMESTAMPTZ;
BEGIN
  IF p_streamer_id IS NULL OR p_user_twitch_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(MAX(user_twitch_username), p_user_twitch_id),
    COALESCE(SUM(reward_cost), 0)::BIGINT,
    COUNT(*)::INTEGER,
    MAX(redeemed_at)
  INTO
    v_username,
    v_total_points,
    v_redemption_count,
    v_last_redeemed_at
  FROM gacha_history
  WHERE streamer_id = p_streamer_id
    AND user_twitch_id = p_user_twitch_id
    AND reward_cost IS NOT NULL
    AND reward_cost > 0;

  IF v_redemption_count = 0 THEN
    DELETE FROM channel_point_usage_stats
    WHERE streamer_id = p_streamer_id
      AND user_twitch_id = p_user_twitch_id;
    RETURN;
  END IF;

  INSERT INTO channel_point_usage_stats (
    streamer_id,
    user_twitch_id,
    username,
    total_points,
    redemption_count,
    last_redeemed_at
  )
  VALUES (
    p_streamer_id,
    p_user_twitch_id,
    v_username,
    v_total_points,
    v_redemption_count,
    v_last_redeemed_at
  )
  ON CONFLICT (streamer_id, user_twitch_id) DO UPDATE SET
    username = EXCLUDED.username,
    total_points = EXCLUDED.total_points,
    redemption_count = EXCLUDED.redemption_count,
    last_redeemed_at = EXCLUDED.last_redeemed_at,
    updated_at = NOW();
END;
$$;


--
-- Name: rename_card_pack(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rename_card_pack(p_streamer_id uuid, p_old_name text, p_new_name text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_catalog JSONB;
  v_old_index INTEGER;
  v_new_name TEXT;
BEGIN
  -- Lock the streamer row for the duration of this transaction so a
  -- concurrent rename/catalog edit for the same streamer can't interleave
  -- with the read-modify-write below (classic lost-update race).
  SELECT card_pack_names INTO v_catalog
  FROM public.streamers
  WHERE id = p_streamer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'STREAMER_NOT_FOUND';
  END IF;

  -- Defense-in-depth re-validation of the new name (the API route already
  -- validates this with the same rules before calling in, but the function
  -- must not trust its caller for anything that affects data integrity).
  v_new_name := btrim(p_new_name);
  IF v_new_name IS NULL OR char_length(v_new_name) < 1 OR char_length(v_new_name) > 80 THEN
    RAISE EXCEPTION 'INVALID_NEW_NAME';
  END IF;

  IF v_new_name LIKE '\_\_%' ESCAPE '\' THEN
    RAISE EXCEPTION 'RESERVED_NEW_NAME';
  END IF;

  IF p_old_name = v_new_name THEN
    RAISE EXCEPTION 'OLD_NEW_NAME_IDENTICAL';
  END IF;

  -- old must be a currently-registered catalog entry (find its array index
  -- so we can replace it in place with jsonb_set, preserving ordering).
  SELECT ordinality - 1 INTO v_old_index
  FROM jsonb_array_elements_text(v_catalog) WITH ORDINALITY AS t(name, ordinality)
  WHERE t.name = p_old_name
  LIMIT 1;

  IF v_old_index IS NULL THEN
    RAISE EXCEPTION 'OLD_NAME_NOT_FOUND';
  END IF;

  -- new must NOT already be a catalog entry (renaming onto an existing pack
  -- would silently merge two distinct packs' cards together).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_catalog) AS name WHERE name = v_new_name
  ) THEN
    RAISE EXCEPTION 'NEW_NAME_ALREADY_EXISTS';
  END IF;

  -- Replace the catalog entry in place (preserves display order) and cascade
  -- the rename to every table that stores a collection_name assignment
  -- scoped to this streamer. All statements run inside this function's
  -- implicit transaction, so a mid-way failure rolls back everything.
  UPDATE public.streamers
  SET card_pack_names = jsonb_set(v_catalog, ARRAY[v_old_index::text], to_jsonb(v_new_name))
  WHERE id = p_streamer_id;

  UPDATE public.cards
  SET collection_name = v_new_name
  WHERE streamer_id = p_streamer_id AND collection_name = p_old_name;

  UPDATE public.streamers
  SET channel_point_collection_name = v_new_name
  WHERE id = p_streamer_id AND channel_point_collection_name = p_old_name;

  UPDATE public.streamer_additional_gacha_rewards
  SET collection_name = v_new_name
  WHERE streamer_id = p_streamer_id AND collection_name = p_old_name;

  -- Issue #557: carry per-pack completion achievements over to the new name
  -- (the follow-up 00063 explicitly deferred with its "#557 で対応予定" note).
  --
  -- ORDER MATTERS — DELETE must run BEFORE the UPDATE below. The partial
  -- unique index idx_collection_completions_pack_unique forbids two rows
  -- with the same (twitch_user_id, streamer_id, collection_name,
  -- total_cards). If some user already holds a completion recorded under
  -- v_new_name with the same total_cards (e.g. the new name was used by a
  -- previously-deleted pack, or an earlier rename cycled names), UPDATE-ing
  -- their old-name row to v_new_name would raise a unique violation and roll
  -- back the ENTIRE rename (catalog + cards + reward cascades above) because
  -- of an unrelated historical coincidence. So first DELETE exactly those
  -- old-name rows whose destination slot is already occupied — the surviving
  -- pre-existing new-name row already records the same achievement, so no
  -- information is lost — then UPDATE the remaining, collision-free rows.
  DELETE FROM public.collection_completions old_cc
  WHERE old_cc.streamer_id = p_streamer_id
    AND old_cc.collection_name = p_old_name
    AND EXISTS (
      SELECT 1
      FROM public.collection_completions new_cc
      WHERE new_cc.streamer_id = p_streamer_id
        AND new_cc.collection_name = v_new_name
        AND new_cc.twitch_user_id = old_cc.twitch_user_id
        AND new_cc.total_cards = old_cc.total_cards
    );

  UPDATE public.collection_completions
  SET collection_name = v_new_name
  WHERE streamer_id = p_streamer_id AND collection_name = p_old_name;

  -- Issue #576/#578: carry forward a per-pack rarity-weight override stored
  -- under the old name, if any. Move (not copy) the JSON entry atomically —
  -- `- p_old_name` drops the old key and `|| jsonb_build_object(...)` adds
  -- the new one in the same expression, so a mid-crash can never leave both
  -- keys present (which would be ambiguous) or neither (which would silently
  -- drop the override). The `pack_rarity_weights ? p_old_name` guard makes
  -- this a no-op when the streamer never customized this pack's weights
  -- (avoids writing a bogus `{}`-turned-object when the column is NULL).
  UPDATE public.streamers
  SET pack_rarity_weights = (pack_rarity_weights - p_old_name) || jsonb_build_object(v_new_name, pack_rarity_weights -> p_old_name)
  WHERE id = p_streamer_id AND pack_rarity_weights ? p_old_name;

END;
$$;


--
-- Name: revoke_support_code(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_support_code(p_code_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  -- 1. コードステータスを revoked に更新
  UPDATE support_codes
    SET status = 'revoked',
        updated_at = NOW()
    WHERE id = p_code_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'CODE_NOT_FOUND');
  END IF;

  -- 2. 関連ライセンスを削除（CASCADE設定済みだが明示的に削除してカウントを取得）
  DELETE FROM user_licenses WHERE code_id = p_code_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_licenses', v_deleted_count
  );
END;
$$;


--
-- Name: FUNCTION revoke_support_code(p_code_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.revoke_support_code(p_code_id uuid) IS 'サポートコードを無効化し、関連する全ライセンスを削除する';


--
-- Name: sync_card_owner_stat(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_card_owner_stat() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM refresh_card_owner_stat(OLD.card_id, OLD.user_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM refresh_card_owner_stat(NEW.card_id, NEW.user_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: sync_channel_point_usage_stat(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_channel_point_usage_stat() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM refresh_channel_point_usage_stat(OLD.streamer_id, OLD.user_twitch_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM refresh_channel_point_usage_stat(NEW.streamer_id, NEW.user_twitch_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: update_battle_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_battle_stats() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Update or insert battle stats for the user
    INSERT INTO battle_stats (
        user_id, 
        total_battles, 
        wins, 
        losses, 
        draws, 
        win_rate,
        updated_at
    ) VALUES (
        NEW.user_id,
        1,
        CASE WHEN NEW.result = 'win' THEN 1 ELSE 0 END,
        CASE WHEN NEW.result = 'lose' THEN 1 ELSE 0 END,
        CASE WHEN NEW.result = 'draw' THEN 1 ELSE 0 END,
        CASE WHEN NEW.result = 'win' THEN 100.0 ELSE 0.0 END,
        NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
        total_battles = battle_stats.total_battles + 1,
        wins = battle_stats.wins + CASE WHEN NEW.result = 'win' THEN 1 ELSE 0 END,
        losses = battle_stats.losses + CASE WHEN NEW.result = 'lose' THEN 1 ELSE 0 END,
        draws = battle_stats.draws + CASE WHEN NEW.result = 'draw' THEN 1 ELSE 0 END,
        win_rate = ROUND(
            (battle_stats.wins + CASE WHEN NEW.result = 'win' THEN 1 ELSE 0 END) * 100.0 / 
            (battle_stats.total_battles + 1)::DECIMAL, 2
        ),
        updated_at = NOW();
    
    RETURN NEW;
END;
$$;


--
-- Name: update_storage_usage(character varying, bigint, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_storage_usage(p_user_prefix character varying, p_size_delta bigint, p_count_delta integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- ユーザーの使用量を更新（存在しなければ挿入）
  INSERT INTO storage_usage (user_prefix, bytes_used, blob_count, updated_at)
  VALUES (p_user_prefix, GREATEST(0, p_size_delta), GREATEST(0, p_count_delta), NOW())
  ON CONFLICT (user_prefix) DO UPDATE SET
    bytes_used = GREATEST(0, storage_usage.bytes_used + p_size_delta),
    blob_count = GREATEST(0, storage_usage.blob_count + p_count_delta),
    updated_at = NOW();

  -- グローバル使用量を更新
  UPDATE storage_usage SET
    bytes_used = GREATEST(0, bytes_used + p_size_delta),
    blob_count = GREATEST(0, blob_count + p_count_delta),
    updated_at = NOW()
  WHERE user_prefix = '_global_';
END;
$$;


--
-- Name: FUNCTION update_storage_usage(p_user_prefix character varying, p_size_delta bigint, p_count_delta integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.update_storage_usage(p_user_prefix character varying, p_size_delta bigint, p_count_delta integer) IS 'ストレージ使用量を更新（ユーザーとグローバル両方）';


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: announcement_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcement_reads (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    announcement_id uuid NOT NULL,
    twitch_user_id text NOT NULL,
    read_at timestamp with time zone DEFAULT now()
);


--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcements (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    is_published boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT announcements_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])))
);


--
-- Name: battle_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battle_stats (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    total_battles integer DEFAULT 0,
    wins integer DEFAULT 0,
    losses integer DEFAULT 0,
    draws integer DEFAULT 0,
    win_rate numeric(5,2) DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: battles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.battles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    user_card_id uuid NOT NULL,
    opponent_card_id uuid,
    result text NOT NULL,
    turn_count integer DEFAULT 0,
    battle_log jsonb,
    created_at timestamp with time zone DEFAULT now(),
    opponent_card_data jsonb,
    CONSTRAINT battles_result_check CHECK ((result = ANY (ARRAY['win'::text, 'lose'::text, 'draw'::text])))
);


--
-- Name: COLUMN battles.opponent_card_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battles.opponent_card_id IS 'Card ID for player vs player battles. NULL for CPU battles. References cards(id).';


--
-- Name: COLUMN battles.opponent_card_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.battles.opponent_card_data IS 'CPU opponent card data for CPU battles. Contains card details: id, name, hp, atk, def, spd, skill_type, skill_name, image_url, rarity.';


--
-- Name: blob_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blob_files (
    url text NOT NULL,
    user_prefix character varying(8) NOT NULL,
    file_size bigint NOT NULL,
    storage_type character varying(10) DEFAULT 'r2'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT valid_storage_type CHECK (((storage_type)::text = ANY ((ARRAY['r2'::character varying, 'vercel'::character varying])::text[])))
);


--
-- Name: TABLE blob_files; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.blob_files IS '個別ファイル情報（削除時にサイズを取得するため）';


--
-- Name: COLUMN blob_files.url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blob_files.url IS 'ファイルの公開URL（主キー）';


--
-- Name: COLUMN blob_files.user_prefix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blob_files.user_prefix IS 'ファイル所有者のユーザープレフィックス';


--
-- Name: COLUMN blob_files.file_size; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blob_files.file_size IS 'ファイルサイズ（バイト）';


--
-- Name: COLUMN blob_files.storage_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blob_files.storage_type IS 'ストレージの種類: r2 または vercel';


--
-- Name: COLUMN blob_files.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blob_files.created_at IS 'ファイル作成日時';


--
-- Name: card_owner_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_owner_stats (
    streamer_id uuid NOT NULL,
    card_id uuid NOT NULL,
    user_twitch_id text NOT NULL,
    username text,
    display_name text,
    owned_count integer DEFAULT 0 NOT NULL,
    last_obtained_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT card_owner_stats_owned_count_check CHECK ((owned_count >= 0))
);


--
-- Name: card_stone_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_stone_balances (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    streamer_id uuid NOT NULL,
    balance integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT card_stone_balances_balance_check CHECK ((balance >= 0))
);


--
-- Name: card_stone_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_stone_transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    streamer_id uuid NOT NULL,
    card_id uuid,
    user_card_id uuid,
    amount integer NOT NULL,
    type text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    request_id uuid,
    CONSTRAINT card_stone_transactions_type_check CHECK ((type = 'duplicate_exchange'::text))
);


--
-- Name: cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cards (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    streamer_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    image_url text,
    rarity text DEFAULT 'common'::text NOT NULL,
    drop_rate numeric(5,4) DEFAULT 0.25 NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    hp integer DEFAULT 100,
    atk integer DEFAULT 30,
    def integer DEFAULT 15,
    spd integer DEFAULT 5,
    skill_type text DEFAULT 'attack'::text,
    skill_name text DEFAULT '通常攻撃'::text,
    skill_power integer DEFAULT 10,
    rarity_order smallint GENERATED ALWAYS AS (
CASE rarity
    WHEN 'legendary'::text THEN 1
    WHEN 'epic'::text THEN 2
    WHEN 'rare'::text THEN 3
    WHEN 'common'::text THEN 4
    ELSE 5
END) STORED,
    intra_rarity_weight numeric DEFAULT 1.0 NOT NULL,
    card_number integer,
    collection_name text,
    max_issuance_count integer,
    CONSTRAINT cards_card_number_positive CHECK (((card_number IS NULL) OR (card_number > 0))),
    CONSTRAINT cards_collection_name_length CHECK (((collection_name IS NULL) OR ((char_length(btrim(collection_name)) >= 1) AND (char_length(btrim(collection_name)) <= 80)))),
    CONSTRAINT cards_collection_name_not_reserved CHECK (((collection_name IS NULL) OR (collection_name !~~ like_escape('\_\_%'::text, '\'::text)))),
    CONSTRAINT cards_drop_rate_check CHECK (((drop_rate >= (0)::numeric) AND (drop_rate <= (1)::numeric))),
    CONSTRAINT cards_max_issuance_count_positive CHECK (((max_issuance_count IS NULL) OR (max_issuance_count > 0))),
    CONSTRAINT cards_rarity_not_blank CHECK ((((length(btrim(rarity)) >= 1) AND (length(btrim(rarity)) <= 40)) AND (rarity !~ '[[:cntrl:]]'::text))),
    CONSTRAINT cards_skill_type_check CHECK ((skill_type = ANY (ARRAY['attack'::text, 'defense'::text, 'heal'::text, 'special'::text]))),
    CONSTRAINT intra_rarity_weight_positive CHECK ((intra_rarity_weight > (0)::numeric))
);


--
-- Name: COLUMN cards.max_issuance_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cards.max_issuance_count IS 'Maximum total copies this card can be issued. NULL means unlimited; 1 means unique-only.';


--
-- Name: channel_point_usage_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_point_usage_stats (
    streamer_id uuid NOT NULL,
    user_twitch_id text NOT NULL,
    username text,
    total_points bigint DEFAULT 0 NOT NULL,
    redemption_count integer DEFAULT 0 NOT NULL,
    last_redeemed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_point_usage_stats_redemption_count_check CHECK ((redemption_count >= 0)),
    CONSTRAINT channel_point_usage_stats_total_points_check CHECK ((total_points >= 0))
);


--
-- Name: collection_completions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_completions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    twitch_user_id text NOT NULL,
    streamer_id uuid NOT NULL,
    total_cards integer NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    collection_name text,
    CONSTRAINT collection_completions_collection_name_length CHECK (((collection_name IS NULL) OR ((char_length(btrim(collection_name)) >= 1) AND (char_length(btrim(collection_name)) <= 80)))),
    CONSTRAINT collection_completions_total_cards_check CHECK ((total_cards > 0))
);


--
-- Name: errors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.errors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    error_type character varying(50) NOT NULL,
    message text NOT NULL,
    stack_trace text,
    context jsonb DEFAULT '{}'::jsonb,
    environment character varying(20) DEFAULT 'production'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    github_issue_created boolean DEFAULT false,
    github_issue_number integer,
    github_issue_url text
);


--
-- Name: TABLE errors; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.errors IS 'エラーログ（GitHub Issue自動作成用）- Issue #239';


--
-- Name: COLUMN errors.error_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.errors.error_type IS 'エラー種別: [Error], [API Error], [Auth Error] 等';


--
-- Name: COLUMN errors.context; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.errors.context IS 'エラーコンテキスト（JSON形式、機密情報を含めないこと）';


--
-- Name: gacha_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gacha_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    event_id text,
    user_twitch_id text NOT NULL,
    user_twitch_username text,
    card_id uuid NOT NULL,
    streamer_id uuid NOT NULL,
    redeemed_at timestamp with time zone DEFAULT now(),
    reward_cost integer,
    reward_id text
);


--
-- Name: COLUMN gacha_history.reward_cost; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.gacha_history.reward_cost IS 'Twitchチャネルポイント引き換え時に消費したポイント数。EventSub経由以外の場合はNULL';


--
-- Name: COLUMN gacha_history.reward_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.gacha_history.reward_id IS 'ガチャ実行の起点になったTwitchチャネルポイント報酬ID (streamer_additional_gacha_rewards.reward_id / GachaResult.rewardId と同じ形)。cards.id とは別物。EventSub経由以外(レイドガチャ等)や既存レコードはNULL。Issue #591: ポーリング経路(/api/overlay/[streamerId]/events)の報酬別効果音ルール判定に使う。';


--
-- Name: storage_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_usage (
    user_prefix character varying(8) NOT NULL,
    bytes_used bigint DEFAULT 0 NOT NULL,
    blob_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE storage_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storage_usage IS 'ユーザーごとおよびグローバルのストレージ使用量を管理';


--
-- Name: COLUMN storage_usage.user_prefix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.storage_usage.user_prefix IS 'ユーザー識別用プレフィックス（8文字ハッシュ）。_global_ はグローバル合計';


--
-- Name: COLUMN storage_usage.bytes_used; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.storage_usage.bytes_used IS '使用バイト数';


--
-- Name: COLUMN storage_usage.blob_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.storage_usage.blob_count IS 'ファイル数';


--
-- Name: COLUMN storage_usage.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.storage_usage.updated_at IS '最終更新日時';


--
-- Name: streamer_additional_gacha_rewards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.streamer_additional_gacha_rewards (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    streamer_id uuid NOT NULL,
    reward_id text NOT NULL,
    reward_name text,
    created_at timestamp with time zone DEFAULT now(),
    draw_count integer DEFAULT 1 NOT NULL,
    is_raid_limited boolean DEFAULT false NOT NULL,
    collection_name text,
    CONSTRAINT streamer_additional_gacha_rewards_draw_count_check CHECK (((draw_count >= 1) AND (draw_count <= 15))),
    CONSTRAINT streamer_additional_rewards_collection_name_length CHECK (((collection_name IS NULL) OR ((char_length(btrim(collection_name)) >= 1) AND (char_length(btrim(collection_name)) <= 80))))
);


--
-- Name: COLUMN streamer_additional_gacha_rewards.draw_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamer_additional_gacha_rewards.draw_count IS 'Number of cards granted by this additional channel point reward. 1 = normal gacha, 15 max.';


--
-- Name: COLUMN streamer_additional_gacha_rewards.is_raid_limited; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamer_additional_gacha_rewards.is_raid_limited IS 'Marks this additional reward as a raid-limited gacha trigger for streamer-facing management.';


--
-- Name: streamer_chat_sender_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.streamer_chat_sender_settings (
    streamer_id uuid NOT NULL,
    sender_mode text DEFAULT 'streamer'::text NOT NULL,
    custom_bot_account_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT streamer_chat_sender_custom_bot_required CHECK ((((sender_mode = 'custom_bot'::text) AND (custom_bot_account_id IS NOT NULL)) OR ((sender_mode <> 'custom_bot'::text) AND (custom_bot_account_id IS NULL)))),
    CONSTRAINT streamer_chat_sender_settings_sender_mode_check CHECK ((sender_mode = ANY (ARRAY['streamer'::text, 'custom_bot'::text, 'official_bot'::text])))
);


--
-- Name: TABLE streamer_chat_sender_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.streamer_chat_sender_settings IS 'Per-streamer chat announcement sender selection.';


--
-- Name: COLUMN streamer_chat_sender_settings.sender_mode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamer_chat_sender_settings.sender_mode IS 'streamer, custom_bot, or future official_bot sender mode.';


--
-- Name: streamer_storage_bonus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.streamer_storage_bonus (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    streamer_id uuid NOT NULL,
    amount_mb integer NOT NULL,
    type text NOT NULL,
    memo text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT streamer_storage_bonus_amount_mb_check CHECK ((amount_mb > 0))
);


--
-- Name: streamers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.streamers (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    twitch_user_id text NOT NULL,
    twitch_username text NOT NULL,
    twitch_display_name text NOT NULL,
    twitch_profile_image_url text,
    channel_point_reward_id text,
    channel_point_reward_name text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    gacha_sound_url text,
    gacha_sound_enabled boolean DEFAULT false NOT NULL,
    chat_announcement_enabled boolean DEFAULT false NOT NULL,
    chat_announcement_template text,
    rarity_weights jsonb,
    show_unowned_cards boolean DEFAULT false NOT NULL,
    show_unowned_card_details boolean DEFAULT false NOT NULL,
    raid_gacha_active_until timestamp with time zone,
    raid_gacha_draw_count integer DEFAULT 0 NOT NULL,
    chat_announcement_multi_template text,
    chat_announcement_multi_show_cards boolean DEFAULT true NOT NULL,
    custom_rarities jsonb DEFAULT '[]'::jsonb NOT NULL,
    channel_point_collection_name text,
    card_pack_names jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_card_pack_name text,
    rarity_weights_scope text DEFAULT 'global'::text NOT NULL,
    pack_rarity_weights jsonb,
    gacha_sound_rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT rarity_weights_valid CHECK (public.check_rarity_weights_values(rarity_weights)),
    CONSTRAINT streamers_card_pack_names_valid CHECK (((jsonb_typeof(card_pack_names) = 'array'::text) AND (jsonb_array_length(card_pack_names) <= 50))),
    CONSTRAINT streamers_channel_point_collection_name_length CHECK (((channel_point_collection_name IS NULL) OR ((char_length(btrim(channel_point_collection_name)) >= 1) AND (char_length(btrim(channel_point_collection_name)) <= 80)))),
    CONSTRAINT streamers_custom_rarities_valid CHECK (((jsonb_typeof(custom_rarities) = 'array'::text) AND (jsonb_array_length(custom_rarities) <= 50))),
    CONSTRAINT streamers_default_card_pack_name_valid CHECK (((default_card_pack_name IS NULL) OR ((char_length(btrim(default_card_pack_name)) >= 1) AND (char_length(btrim(default_card_pack_name)) <= 80)))),
    CONSTRAINT streamers_pack_rarity_weights_valid CHECK (public.check_pack_rarity_weights_values(pack_rarity_weights)),
    CONSTRAINT streamers_raid_gacha_draw_count_check CHECK (((raid_gacha_draw_count >= 0) AND (raid_gacha_draw_count <= 15))),
    CONSTRAINT streamers_rarity_weights_scope_valid CHECK ((rarity_weights_scope = ANY (ARRAY['global'::text, 'per_pack'::text])))
);


--
-- Name: COLUMN streamers.gacha_sound_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.gacha_sound_url IS 'URL of the gacha sound effect file stored in R2 (max 1MB, MP3/WAV/WebM/OGG)';


--
-- Name: COLUMN streamers.gacha_sound_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.gacha_sound_enabled IS 'Whether to play sound effect on gacha (default: false)';


--
-- Name: COLUMN streamers.chat_announcement_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.chat_announcement_enabled IS 'Whether to post gacha results to Twitch chat (default: false, opt-in)';


--
-- Name: COLUMN streamers.chat_announcement_template; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.chat_announcement_template IS 'Custom message template for chat announcements. Placeholders: {user}, {card}, {rarity}, {url}, {detail}, {num}';


--
-- Name: COLUMN streamers.show_unowned_cards; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.show_unowned_cards IS 'Whether unowned cards are visible on the viewer collection page (default: false, opt-in)';


--
-- Name: COLUMN streamers.show_unowned_card_details; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.show_unowned_card_details IS 'When show_unowned_cards is true, whether to reveal card image/description (false = placeholder only)';


--
-- Name: COLUMN streamers.raid_gacha_active_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.raid_gacha_active_until IS 'Manual raid-gacha activation window. Raid-limited additional rewards are blocked when this is null, invalid, or in the past.';


--
-- Name: COLUMN streamers.raid_gacha_draw_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.raid_gacha_draw_count IS 'Number of gacha draws granted to the raider when an incoming raid is received. 0 disables raid gifts.';


--
-- Name: COLUMN streamers.chat_announcement_multi_template; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.chat_announcement_multi_template IS 'Custom message template for multi-draw chat announcements. Null uses the built-in multi-draw default.';


--
-- Name: COLUMN streamers.chat_announcement_multi_show_cards; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.chat_announcement_multi_show_cards IS 'Whether multi-draw chat announcements include the individual card-name list in {cards}.';


--
-- Name: COLUMN streamers.gacha_sound_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.streamers.gacha_sound_rules IS 'Ordered gacha sound rules. Each rule contains url, enabled, targetType(all/rarity/reward), optional rarity, and optional rewardId.';


--
-- Name: support_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code_hash text NOT NULL,
    plan_type text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    memo text DEFAULT ''::text,
    activation_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_codes_plan_type_check CHECK ((plan_type = ANY (ARRAY['support'::text, 'patron'::text]))),
    CONSTRAINT support_codes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'rotating'::text, 'revoked'::text])))
);


--
-- Name: TABLE support_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.support_codes IS '支援プランの共有コードマスタ。コードはSHA-256ハッシュで保存';


--
-- Name: COLUMN support_codes.code_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_codes.code_hash IS 'SHA-256ハッシュ化されたコード';


--
-- Name: COLUMN support_codes.plan_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_codes.plan_type IS 'プランタイプ: support(500MB) or patron(1GB)';


--
-- Name: COLUMN support_codes.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_codes.status IS 'active=利用可, rotating=新規不可, revoked=無効化';


--
-- Name: support_inquiries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_inquiries (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    twitch_user_id text NOT NULL,
    twitch_display_name text NOT NULL,
    category text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    github_issue_created boolean DEFAULT false NOT NULL,
    github_issue_number integer,
    github_issue_url text,
    CONSTRAINT support_inquiries_body_check CHECK ((char_length(body) <= 2000)),
    CONSTRAINT support_inquiries_category_check CHECK ((category = ANY (ARRAY['bug'::text, 'feature'::text, 'other'::text]))),
    CONSTRAINT support_inquiries_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text, 'closed'::text]))),
    CONSTRAINT support_inquiries_subject_check CHECK ((char_length(subject) <= 200))
);


--
-- Name: COLUMN support_inquiries.github_issue_created; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_inquiries.github_issue_created IS 'GitHub Issue 発行済みフラグ（Cron Worker が更新）- Issue #633';


--
-- Name: COLUMN support_inquiries.github_issue_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_inquiries.github_issue_number IS '発行された GitHub Issue 番号';


--
-- Name: COLUMN support_inquiries.github_issue_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_inquiries.github_issue_url IS '発行された GitHub Issue の URL';


--
-- Name: support_inquiry_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_inquiry_messages (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    inquiry_id uuid NOT NULL,
    sender_type text NOT NULL,
    sender_id text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT support_inquiry_messages_body_check CHECK ((char_length(body) <= 2000)),
    CONSTRAINT support_inquiry_messages_sender_type_check CHECK ((sender_type = ANY (ARRAY['user'::text, 'admin'::text])))
);


--
-- Name: twitch_bot_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.twitch_bot_accounts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    owner_type text NOT NULL,
    streamer_id uuid,
    twitch_user_id text NOT NULL,
    twitch_username text,
    twitch_display_name text,
    twitch_access_token text NOT NULL,
    twitch_refresh_token text NOT NULL,
    twitch_token_expires_at timestamp with time zone NOT NULL,
    scopes text[] DEFAULT '{}'::text[],
    status text DEFAULT 'active'::text NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT twitch_bot_accounts_owner_shape CHECK ((((owner_type = 'streamer'::text) AND (streamer_id IS NOT NULL)) OR ((owner_type = 'system'::text) AND (streamer_id IS NULL)))),
    CONSTRAINT twitch_bot_accounts_owner_type_check CHECK ((owner_type = ANY (ARRAY['streamer'::text, 'system'::text]))),
    CONSTRAINT twitch_bot_accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'error'::text])))
);


--
-- Name: TABLE twitch_bot_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.twitch_bot_accounts IS 'Twitch BOT OAuth accounts used as chat announcement senders.';


--
-- Name: COLUMN twitch_bot_accounts.owner_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.twitch_bot_accounts.owner_type IS 'streamer = streamer-owned custom BOT, system = TwiCa official BOT.';


--
-- Name: user_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_cards (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    card_id uuid NOT NULL,
    obtained_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_licenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_licenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    twitch_user_id text NOT NULL,
    code_id uuid NOT NULL,
    plan_type text NOT NULL,
    fanbox_id text,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_licenses_plan_type_check CHECK ((plan_type = ANY (ARRAY['support'::text, 'patron'::text])))
);


--
-- Name: TABLE user_licenses; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_licenses IS 'ユーザーの支援プランライセンス。コードが有効な限りライセンスも有効';


--
-- Name: COLUMN user_licenses.fanbox_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_licenses.fanbox_id IS 'FANBOX IDの参考情報（不正検知用）';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    twitch_user_id text NOT NULL,
    twitch_username text NOT NULL,
    twitch_display_name text NOT NULL,
    twitch_profile_image_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    twitch_access_token text,
    twitch_refresh_token text,
    twitch_token_expires_at timestamp with time zone,
    tos_accepted_at timestamp with time zone,
    twitch_scopes text[] DEFAULT '{}'::text[],
    twitch_sub_verified_at timestamp with time zone,
    twitch_has_sub boolean DEFAULT false
);


--
-- Name: COLUMN users.tos_accepted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.tos_accepted_at IS 'Timestamp when user accepted Terms of Service. NULL means not yet accepted.';


--
-- Name: COLUMN users.twitch_scopes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.twitch_scopes IS 'Array of Twitch OAuth scopes granted to this user. Empty for existing users until re-authentication.';


--
-- Name: announcement_reads announcement_reads_announcement_id_twitch_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_reads
    ADD CONSTRAINT announcement_reads_announcement_id_twitch_user_id_key UNIQUE (announcement_id, twitch_user_id);


--
-- Name: announcement_reads announcement_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_reads
    ADD CONSTRAINT announcement_reads_pkey PRIMARY KEY (id);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: battle_stats battle_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_stats
    ADD CONSTRAINT battle_stats_pkey PRIMARY KEY (id);


--
-- Name: battle_stats battle_stats_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_stats
    ADD CONSTRAINT battle_stats_user_id_key UNIQUE (user_id);


--
-- Name: battles battles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battles
    ADD CONSTRAINT battles_pkey PRIMARY KEY (id);


--
-- Name: blob_files blob_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blob_files
    ADD CONSTRAINT blob_files_pkey PRIMARY KEY (url);


--
-- Name: card_owner_stats card_owner_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_owner_stats
    ADD CONSTRAINT card_owner_stats_pkey PRIMARY KEY (streamer_id, card_id, user_twitch_id);


--
-- Name: card_stone_balances card_stone_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_stone_balances
    ADD CONSTRAINT card_stone_balances_pkey PRIMARY KEY (id);


--
-- Name: card_stone_balances card_stone_balances_user_id_streamer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_stone_balances
    ADD CONSTRAINT card_stone_balances_user_id_streamer_id_key UNIQUE (user_id, streamer_id);


--
-- Name: card_stone_transactions card_stone_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_stone_transactions
    ADD CONSTRAINT card_stone_transactions_pkey PRIMARY KEY (id);


--
-- Name: cards cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cards
    ADD CONSTRAINT cards_pkey PRIMARY KEY (id);


--
-- Name: channel_point_usage_stats channel_point_usage_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_point_usage_stats
    ADD CONSTRAINT channel_point_usage_stats_pkey PRIMARY KEY (streamer_id, user_twitch_id);


--
-- Name: collection_completions collection_completions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_completions
    ADD CONSTRAINT collection_completions_pkey PRIMARY KEY (id);


--
-- Name: errors errors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errors
    ADD CONSTRAINT errors_pkey PRIMARY KEY (id);


--
-- Name: gacha_history gacha_history_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gacha_history
    ADD CONSTRAINT gacha_history_event_id_key UNIQUE (event_id);


--
-- Name: gacha_history gacha_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gacha_history
    ADD CONSTRAINT gacha_history_pkey PRIMARY KEY (id);


--
-- Name: storage_usage storage_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_usage
    ADD CONSTRAINT storage_usage_pkey PRIMARY KEY (user_prefix);


--
-- Name: streamer_additional_gacha_rewards streamer_additional_gacha_rewards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamer_additional_gacha_rewards
    ADD CONSTRAINT streamer_additional_gacha_rewards_pkey PRIMARY KEY (id);


--
-- Name: streamer_additional_gacha_rewards streamer_additional_gacha_rewards_streamer_id_reward_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamer_additional_gacha_rewards
    ADD CONSTRAINT streamer_additional_gacha_rewards_streamer_id_reward_id_key UNIQUE (streamer_id, reward_id);


--
-- Name: streamer_chat_sender_settings streamer_chat_sender_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamer_chat_sender_settings
    ADD CONSTRAINT streamer_chat_sender_settings_pkey PRIMARY KEY (streamer_id);


--
-- Name: streamer_storage_bonus streamer_storage_bonus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamer_storage_bonus
    ADD CONSTRAINT streamer_storage_bonus_pkey PRIMARY KEY (id);


--
-- Name: streamer_storage_bonus streamer_storage_bonus_streamer_id_type_memo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamer_storage_bonus
    ADD CONSTRAINT streamer_storage_bonus_streamer_id_type_memo_key UNIQUE (streamer_id, type, memo);


--
-- Name: streamers streamers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamers
    ADD CONSTRAINT streamers_pkey PRIMARY KEY (id);


--
-- Name: streamers streamers_twitch_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamers
    ADD CONSTRAINT streamers_twitch_user_id_key UNIQUE (twitch_user_id);


--
-- Name: support_codes support_codes_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_codes
    ADD CONSTRAINT support_codes_code_hash_key UNIQUE (code_hash);


--
-- Name: support_codes support_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_codes
    ADD CONSTRAINT support_codes_pkey PRIMARY KEY (id);


--
-- Name: support_inquiries support_inquiries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_inquiries
    ADD CONSTRAINT support_inquiries_pkey PRIMARY KEY (id);


--
-- Name: support_inquiry_messages support_inquiry_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_inquiry_messages
    ADD CONSTRAINT support_inquiry_messages_pkey PRIMARY KEY (id);


--
-- Name: twitch_bot_accounts twitch_bot_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twitch_bot_accounts
    ADD CONSTRAINT twitch_bot_accounts_pkey PRIMARY KEY (id);


--
-- Name: user_cards user_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cards
    ADD CONSTRAINT user_cards_pkey PRIMARY KEY (id);


--
-- Name: user_licenses user_licenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_licenses
    ADD CONSTRAINT user_licenses_pkey PRIMARY KEY (id);


--
-- Name: user_licenses user_licenses_twitch_user_id_code_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_licenses
    ADD CONSTRAINT user_licenses_twitch_user_id_code_id_key UNIQUE (twitch_user_id, code_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_twitch_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_twitch_user_id_key UNIQUE (twitch_user_id);


--
-- Name: cards_streamer_card_number_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cards_streamer_card_number_unique ON public.cards USING btree (streamer_id, card_number) WHERE (card_number IS NOT NULL);


--
-- Name: idx_additional_gacha_rewards_reward_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_additional_gacha_rewards_reward_id ON public.streamer_additional_gacha_rewards USING btree (reward_id);


--
-- Name: idx_additional_gacha_rewards_streamer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_additional_gacha_rewards_streamer_id ON public.streamer_additional_gacha_rewards USING btree (streamer_id);


--
-- Name: idx_announcement_reads_announcement_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_announcement_reads_announcement_id ON public.announcement_reads USING btree (announcement_id);


--
-- Name: idx_announcement_reads_twitch_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_announcement_reads_twitch_user_id ON public.announcement_reads USING btree (twitch_user_id);


--
-- Name: idx_battle_stats_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_battle_stats_user_id ON public.battle_stats USING btree (user_id);


--
-- Name: idx_battles_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_battles_created_at ON public.battles USING btree (created_at DESC);


--
-- Name: idx_battles_opponent_card_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_battles_opponent_card_id ON public.battles USING btree (opponent_card_id);


--
-- Name: idx_battles_result; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_battles_result ON public.battles USING btree (result);


--
-- Name: idx_battles_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_battles_user_id ON public.battles USING btree (user_id);


--
-- Name: idx_blob_files_user_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blob_files_user_prefix ON public.blob_files USING btree (user_prefix);


--
-- Name: idx_card_owner_stats_card_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_owner_stats_card_id ON public.card_owner_stats USING btree (card_id);


--
-- Name: idx_card_owner_stats_card_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_owner_stats_card_rank ON public.card_owner_stats USING btree (streamer_id, card_id, owned_count DESC, last_obtained_at DESC);


--
-- Name: idx_card_stone_balances_user_streamer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_stone_balances_user_streamer ON public.card_stone_balances USING btree (user_id, streamer_id);


--
-- Name: idx_card_stone_transactions_card_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_stone_transactions_card_id ON public.card_stone_transactions USING btree (card_id);


--
-- Name: idx_card_stone_transactions_user_streamer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_stone_transactions_user_streamer ON public.card_stone_transactions USING btree (user_id, streamer_id, created_at DESC);


--
-- Name: idx_cards_rarity_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cards_rarity_order ON public.cards USING btree (rarity_order);


--
-- Name: idx_cards_streamer_collection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cards_streamer_collection ON public.cards USING btree (streamer_id, collection_name) WHERE (collection_name IS NOT NULL);


--
-- Name: idx_cards_streamer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cards_streamer_id ON public.cards USING btree (streamer_id);


--
-- Name: idx_channel_point_usage_stats_streamer_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channel_point_usage_stats_streamer_rank ON public.channel_point_usage_stats USING btree (streamer_id, total_points DESC, redemption_count DESC, last_redeemed_at DESC);


--
-- Name: idx_collection_completions_overall_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_collection_completions_overall_unique ON public.collection_completions USING btree (twitch_user_id, streamer_id, total_cards) WHERE (collection_name IS NULL);


--
-- Name: idx_collection_completions_pack_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_collection_completions_pack_unique ON public.collection_completions USING btree (twitch_user_id, streamer_id, collection_name, total_cards) WHERE (collection_name IS NOT NULL);


--
-- Name: idx_collection_completions_user_streamer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collection_completions_user_streamer ON public.collection_completions USING btree (twitch_user_id, streamer_id);


--
-- Name: idx_errors_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_errors_created_at ON public.errors USING btree (created_at);


--
-- Name: idx_errors_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_errors_pending ON public.errors USING btree (github_issue_created, created_at DESC) WHERE (github_issue_created = false);


--
-- Name: idx_gacha_history_card_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gacha_history_card_id ON public.gacha_history USING btree (card_id);


--
-- Name: idx_gacha_history_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gacha_history_event_id ON public.gacha_history USING btree (event_id);


--
-- Name: idx_gacha_history_streamer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gacha_history_streamer_id ON public.gacha_history USING btree (streamer_id);


--
-- Name: idx_gacha_history_streamer_redeemed_card; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gacha_history_streamer_redeemed_card ON public.gacha_history USING btree (streamer_id, redeemed_at DESC, card_id);


--
-- Name: idx_gacha_history_streamer_redeemed_card_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gacha_history_streamer_redeemed_card_user ON public.gacha_history USING btree (streamer_id, redeemed_at, card_id, user_twitch_id) INCLUDE (user_twitch_username, event_id);


--
-- Name: idx_gacha_history_streamer_redeemed_reward; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gacha_history_streamer_redeemed_reward ON public.gacha_history USING btree (streamer_id, redeemed_at DESC) WHERE ((reward_cost IS NOT NULL) AND (reward_cost > 0));


--
-- Name: idx_gacha_history_streamer_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gacha_history_streamer_user ON public.gacha_history USING btree (streamer_id, user_twitch_id);


--
-- Name: idx_gacha_history_streamer_user_reward; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gacha_history_streamer_user_reward ON public.gacha_history USING btree (streamer_id, user_twitch_id) WHERE ((reward_cost IS NOT NULL) AND (reward_cost > 0));


--
-- Name: idx_gacha_history_user_twitch_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gacha_history_user_twitch_id ON public.gacha_history USING btree (user_twitch_id);


--
-- Name: idx_streamer_chat_sender_custom_bot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_streamer_chat_sender_custom_bot ON public.streamer_chat_sender_settings USING btree (custom_bot_account_id);


--
-- Name: idx_streamer_storage_bonus_streamer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_streamer_storage_bonus_streamer_id ON public.streamer_storage_bonus USING btree (streamer_id);


--
-- Name: idx_support_codes_code_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_codes_code_hash ON public.support_codes USING btree (code_hash);


--
-- Name: idx_support_codes_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_codes_status ON public.support_codes USING btree (status);


--
-- Name: idx_support_inquiries_created_at_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_inquiries_created_at_desc ON public.support_inquiries USING btree (created_at DESC);


--
-- Name: idx_support_inquiries_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_inquiries_pending ON public.support_inquiries USING btree (created_at) WHERE (github_issue_created = false);


--
-- Name: idx_support_inquiries_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_inquiries_status ON public.support_inquiries USING btree (status);


--
-- Name: idx_support_inquiries_twitch_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_inquiries_twitch_user_id ON public.support_inquiries USING btree (twitch_user_id);


--
-- Name: idx_support_inquiry_messages_inquiry_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_inquiry_messages_inquiry_created ON public.support_inquiry_messages USING btree (inquiry_id, created_at);


--
-- Name: idx_twitch_bot_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_twitch_bot_accounts_status ON public.twitch_bot_accounts USING btree (owner_type, status);


--
-- Name: idx_twitch_bot_accounts_streamer_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_twitch_bot_accounts_streamer_owner ON public.twitch_bot_accounts USING btree (streamer_id, owner_type) WHERE (owner_type = 'streamer'::text);


--
-- Name: idx_twitch_bot_accounts_system_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_twitch_bot_accounts_system_user ON public.twitch_bot_accounts USING btree (twitch_user_id) WHERE (owner_type = 'system'::text);


--
-- Name: idx_user_cards_card_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_cards_card_id ON public.user_cards USING btree (card_id);


--
-- Name: idx_user_cards_user_card; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_cards_user_card ON public.user_cards USING btree (user_id, card_id, obtained_at DESC);


--
-- Name: idx_user_cards_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_cards_user_id ON public.user_cards USING btree (user_id);


--
-- Name: idx_user_licenses_code_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_licenses_code_id ON public.user_licenses USING btree (code_id);


--
-- Name: idx_user_licenses_twitch_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_licenses_twitch_user_id ON public.user_licenses USING btree (twitch_user_id);


--
-- Name: idx_users_tos_accepted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_tos_accepted_at ON public.users USING btree (tos_accepted_at);


--
-- Name: uq_card_stone_transactions_user_request; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_card_stone_transactions_user_request ON public.card_stone_transactions USING btree (user_id, request_id) WHERE (request_id IS NOT NULL);


--
-- Name: user_cards trg_sync_card_owner_stat; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_card_owner_stat AFTER INSERT OR DELETE OR UPDATE ON public.user_cards FOR EACH ROW EXECUTE FUNCTION public.sync_card_owner_stat();


--
-- Name: gacha_history trg_sync_channel_point_usage_stat; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_channel_point_usage_stat AFTER INSERT OR DELETE OR UPDATE ON public.gacha_history FOR EACH ROW EXECUTE FUNCTION public.sync_channel_point_usage_stat();


--
-- Name: announcements update_announcements_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_announcements_updated_at BEFORE UPDATE ON public.announcements FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: battles update_battle_stats_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_battle_stats_trigger AFTER INSERT ON public.battles FOR EACH ROW EXECUTE FUNCTION public.update_battle_stats();


--
-- Name: battle_stats update_battle_stats_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_battle_stats_updated_at BEFORE UPDATE ON public.battle_stats FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: cards update_cards_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_cards_updated_at BEFORE UPDATE ON public.cards FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: streamer_chat_sender_settings update_streamer_chat_sender_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_streamer_chat_sender_settings_updated_at BEFORE UPDATE ON public.streamer_chat_sender_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: streamers update_streamers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_streamers_updated_at BEFORE UPDATE ON public.streamers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: support_inquiries update_support_inquiries_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_support_inquiries_updated_at BEFORE UPDATE ON public.support_inquiries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: twitch_bot_accounts update_twitch_bot_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_twitch_bot_accounts_updated_at BEFORE UPDATE ON public.twitch_bot_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: users update_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: announcement_reads announcement_reads_announcement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_reads
    ADD CONSTRAINT announcement_reads_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES public.announcements(id) ON DELETE CASCADE;


--
-- Name: battle_stats battle_stats_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battle_stats
    ADD CONSTRAINT battle_stats_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: battles battles_opponent_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battles
    ADD CONSTRAINT battles_opponent_card_id_fkey FOREIGN KEY (opponent_card_id) REFERENCES public.cards(id) ON DELETE CASCADE;


--
-- Name: battles battles_user_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battles
    ADD CONSTRAINT battles_user_card_id_fkey FOREIGN KEY (user_card_id) REFERENCES public.user_cards(id) ON DELETE CASCADE;


--
-- Name: battles battles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.battles
    ADD CONSTRAINT battles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: card_owner_stats card_owner_stats_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_owner_stats
    ADD CONSTRAINT card_owner_stats_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.cards(id) ON DELETE CASCADE;


--
-- Name: card_owner_stats card_owner_stats_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_owner_stats
    ADD CONSTRAINT card_owner_stats_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: card_stone_balances card_stone_balances_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_stone_balances
    ADD CONSTRAINT card_stone_balances_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: card_stone_balances card_stone_balances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_stone_balances
    ADD CONSTRAINT card_stone_balances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: card_stone_transactions card_stone_transactions_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_stone_transactions
    ADD CONSTRAINT card_stone_transactions_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.cards(id) ON DELETE SET NULL;


--
-- Name: card_stone_transactions card_stone_transactions_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_stone_transactions
    ADD CONSTRAINT card_stone_transactions_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: card_stone_transactions card_stone_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_stone_transactions
    ADD CONSTRAINT card_stone_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cards cards_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cards
    ADD CONSTRAINT cards_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: channel_point_usage_stats channel_point_usage_stats_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_point_usage_stats
    ADD CONSTRAINT channel_point_usage_stats_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: collection_completions collection_completions_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_completions
    ADD CONSTRAINT collection_completions_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: gacha_history gacha_history_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gacha_history
    ADD CONSTRAINT gacha_history_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.cards(id) ON DELETE CASCADE;


--
-- Name: gacha_history gacha_history_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gacha_history
    ADD CONSTRAINT gacha_history_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: streamer_additional_gacha_rewards streamer_additional_gacha_rewards_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamer_additional_gacha_rewards
    ADD CONSTRAINT streamer_additional_gacha_rewards_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: streamer_chat_sender_settings streamer_chat_sender_settings_custom_bot_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamer_chat_sender_settings
    ADD CONSTRAINT streamer_chat_sender_settings_custom_bot_account_id_fkey FOREIGN KEY (custom_bot_account_id) REFERENCES public.twitch_bot_accounts(id);


--
-- Name: streamer_chat_sender_settings streamer_chat_sender_settings_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamer_chat_sender_settings
    ADD CONSTRAINT streamer_chat_sender_settings_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: streamer_storage_bonus streamer_storage_bonus_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.streamer_storage_bonus
    ADD CONSTRAINT streamer_storage_bonus_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: support_inquiry_messages support_inquiry_messages_inquiry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_inquiry_messages
    ADD CONSTRAINT support_inquiry_messages_inquiry_id_fkey FOREIGN KEY (inquiry_id) REFERENCES public.support_inquiries(id) ON DELETE CASCADE;


--
-- Name: twitch_bot_accounts twitch_bot_accounts_streamer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twitch_bot_accounts
    ADD CONSTRAINT twitch_bot_accounts_streamer_id_fkey FOREIGN KEY (streamer_id) REFERENCES public.streamers(id) ON DELETE CASCADE;


--
-- Name: user_cards user_cards_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cards
    ADD CONSTRAINT user_cards_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.cards(id) ON DELETE CASCADE;


--
-- Name: user_cards user_cards_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cards
    ADD CONSTRAINT user_cards_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_licenses user_licenses_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_licenses
    ADD CONSTRAINT user_licenses_code_id_fkey FOREIGN KEY (code_id) REFERENCES public.support_codes(id) ON DELETE CASCADE;


--
-- Name: streamers Active streamers are viewable by everyone; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Active streamers are viewable by everyone" ON public.streamers FOR SELECT USING ((is_active = true));


--
-- Name: cards Cards are viewable by everyone; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Cards are viewable by everyone" ON public.cards FOR SELECT USING ((is_active = true));


--
-- Name: gacha_history Service can insert gacha history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service can insert gacha history" ON public.gacha_history FOR INSERT TO service_role WITH CHECK (true);


--
-- Name: battle_stats Service can manage battle_stats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service can manage battle_stats" ON public.battle_stats TO service_role USING (true) WITH CHECK (true);


--
-- Name: battles Service can manage battles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service can manage battles" ON public.battles TO service_role USING (true) WITH CHECK (true);


--
-- Name: card_stone_balances Service can manage card stone balances; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service can manage card stone balances" ON public.card_stone_balances TO service_role USING (true) WITH CHECK (true);


--
-- Name: card_stone_transactions Service can manage card stone transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service can manage card stone transactions" ON public.card_stone_transactions TO service_role USING (true) WITH CHECK (true);


--
-- Name: cards Service can manage cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service can manage cards" ON public.cards TO service_role USING (true) WITH CHECK (true);


--
-- Name: streamers Service can manage streamers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service can manage streamers" ON public.streamers TO service_role USING (true) WITH CHECK (true);


--
-- Name: user_cards Service can manage user_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service can manage user_cards" ON public.user_cards TO service_role USING (true) WITH CHECK (true);


--
-- Name: users Service can manage users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service can manage users" ON public.users TO service_role USING (true) WITH CHECK (true);


--
-- Name: gacha_history Service can view gacha history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service can view gacha history" ON public.gacha_history FOR SELECT TO service_role USING (true);


--
-- Name: twitch_bot_accounts Service role can manage Twitch BOT accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage Twitch BOT accounts" ON public.twitch_bot_accounts TO service_role USING (true) WITH CHECK (true);


--
-- Name: streamer_additional_gacha_rewards Service role can manage additional rewards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage additional rewards" ON public.streamer_additional_gacha_rewards TO service_role USING (true) WITH CHECK (true);


--
-- Name: announcement_reads Service role can manage announcement reads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage announcement reads" ON public.announcement_reads TO service_role USING (true) WITH CHECK (true);


--
-- Name: announcements Service role can manage announcements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage announcements" ON public.announcements TO service_role USING (true) WITH CHECK (true);


--
-- Name: card_owner_stats Service role can manage card owner stats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage card owner stats" ON public.card_owner_stats TO service_role USING (true) WITH CHECK (true);


--
-- Name: channel_point_usage_stats Service role can manage channel point usage stats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage channel point usage stats" ON public.channel_point_usage_stats TO service_role USING (true) WITH CHECK (true);


--
-- Name: streamer_chat_sender_settings Service role can manage chat sender settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage chat sender settings" ON public.streamer_chat_sender_settings TO service_role USING (true) WITH CHECK (true);


--
-- Name: collection_completions Service role can manage collection completions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage collection completions" ON public.collection_completions TO service_role USING (true) WITH CHECK (true);


--
-- Name: streamer_storage_bonus Service role can manage storage bonus; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage storage bonus" ON public.streamer_storage_bonus TO service_role USING (true) WITH CHECK (true);


--
-- Name: support_inquiries Service role can manage support inquiries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage support inquiries" ON public.support_inquiries TO service_role USING (true) WITH CHECK (true);


--
-- Name: support_inquiry_messages Service role can manage support inquiry messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage support inquiry messages" ON public.support_inquiry_messages TO service_role USING (true) WITH CHECK (true);


--
-- Name: streamer_additional_gacha_rewards Users can read own additional rewards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own additional rewards" ON public.streamer_additional_gacha_rewards FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.streamers
  WHERE ((streamers.id = streamer_additional_gacha_rewards.streamer_id) AND (streamers.twitch_user_id = (auth.uid())::text)))));


--
-- Name: announcement_reads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;

--
-- Name: announcements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

--
-- Name: battle_stats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.battle_stats ENABLE ROW LEVEL SECURITY;

--
-- Name: battles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.battles ENABLE ROW LEVEL SECURITY;

--
-- Name: blob_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blob_files ENABLE ROW LEVEL SECURITY;

--
-- Name: card_owner_stats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.card_owner_stats ENABLE ROW LEVEL SECURITY;

--
-- Name: card_stone_balances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.card_stone_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: card_stone_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.card_stone_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;

--
-- Name: channel_point_usage_stats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channel_point_usage_stats ENABLE ROW LEVEL SECURITY;

--
-- Name: collection_completions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collection_completions ENABLE ROW LEVEL SECURITY;

--
-- Name: errors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.errors ENABLE ROW LEVEL SECURITY;

--
-- Name: gacha_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gacha_history ENABLE ROW LEVEL SECURITY;

--
-- Name: blob_files service_role_blob_files; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_blob_files ON public.blob_files USING (((auth.jwt() ->> 'role'::text) = 'service_role'::text)) WITH CHECK (((auth.jwt() ->> 'role'::text) = 'service_role'::text));


--
-- Name: errors service_role_errors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_errors ON public.errors USING (((auth.jwt() ->> 'role'::text) = 'service_role'::text)) WITH CHECK (((auth.jwt() ->> 'role'::text) = 'service_role'::text));


--
-- Name: storage_usage service_role_storage_usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_storage_usage ON public.storage_usage USING (((auth.jwt() ->> 'role'::text) = 'service_role'::text)) WITH CHECK (((auth.jwt() ->> 'role'::text) = 'service_role'::text));


--
-- Name: support_codes service_role_support_codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_support_codes ON public.support_codes USING ((auth.role() = 'service_role'::text));


--
-- Name: user_licenses service_role_user_licenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_user_licenses ON public.user_licenses USING ((auth.role() = 'service_role'::text));


--
-- Name: storage_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storage_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: streamer_additional_gacha_rewards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.streamer_additional_gacha_rewards ENABLE ROW LEVEL SECURITY;

--
-- Name: streamer_chat_sender_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.streamer_chat_sender_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: streamer_storage_bonus; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.streamer_storage_bonus ENABLE ROW LEVEL SECURITY;

--
-- Name: streamers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.streamers ENABLE ROW LEVEL SECURITY;

--
-- Name: support_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: support_inquiries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_inquiries ENABLE ROW LEVEL SECURITY;

--
-- Name: support_inquiry_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_inquiry_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: twitch_bot_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.twitch_bot_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: user_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: user_licenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_licenses ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


