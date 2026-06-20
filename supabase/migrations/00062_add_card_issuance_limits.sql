-- Add optional issuance limits per card.
-- NULL means unlimited. 1 means fully unique. Any positive integer caps total issued copies.
--
-- NOTE: 番号が 00062 の理由:
-- 本番DBに 00059/00060 が適用済みのため、00056/00057 のままでは out-of-order となり Supabase に拒否される。
-- 00061 は gacha_sound_rules migration (PR #451) に使用済みのため、00062 を使用する。

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS max_issuance_count INTEGER;

ALTER TABLE cards
  DROP CONSTRAINT IF EXISTS cards_max_issuance_count_positive;

ALTER TABLE cards
  ADD CONSTRAINT cards_max_issuance_count_positive
  CHECK (max_issuance_count IS NULL OR max_issuance_count > 0);

COMMENT ON COLUMN cards.max_issuance_count IS
  'Maximum total copies this card can be issued. NULL means unlimited; 1 means unique-only.';

CREATE INDEX IF NOT EXISTS idx_user_cards_card_id_issuance_count
  ON user_cards(card_id);

DROP FUNCTION IF EXISTS execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER);

CREATE OR REPLACE FUNCTION execute_gacha_transaction(
  p_event_id TEXT,
  p_user_twitch_id TEXT,
  p_user_twitch_username TEXT,
  p_card_id UUID,
  p_streamer_id UUID,
  p_reward_cost INTEGER DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_user_id UUID;
  v_history_id UUID;
  v_max_issuance_count INTEGER;
  v_issued_count INTEGER;
BEGIN
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

  INSERT INTO gacha_history (event_id, user_twitch_id, user_twitch_username, card_id, streamer_id, reward_cost)
  VALUES (p_event_id, p_user_twitch_id, p_user_twitch_username, p_card_id, p_streamer_id, p_reward_cost)
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
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER) IS
  'ガチャのDB操作を1トランザクションで実行し、カード発行可能枚数の上限も同時に検証する';

REVOKE ALL ON FUNCTION execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER) TO service_role;
