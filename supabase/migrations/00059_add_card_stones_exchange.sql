-- Add duplicate-card exchange into card stones.
-- ダブりカードをカードストーンへ変換するための残高・取引テーブルとRPCを追加する。

CREATE TABLE IF NOT EXISTS card_stone_balances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, streamer_id)
);

CREATE TABLE IF NOT EXISTS card_stone_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  card_id UUID REFERENCES cards(id) ON DELETE SET NULL,
  user_card_id UUID,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('duplicate_exchange')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_card_stone_balances_user_streamer
ON card_stone_balances(user_id, streamer_id);

CREATE INDEX IF NOT EXISTS idx_card_stone_transactions_user_streamer
ON card_stone_transactions(user_id, streamer_id, created_at DESC);

ALTER TABLE card_stone_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_stone_transactions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.card_stone_balances TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.card_stone_transactions TO service_role;

CREATE POLICY "Service can manage card stone balances"
ON card_stone_balances
FOR ALL TO service_role
USING (true) WITH CHECK (true);

CREATE POLICY "Service can manage card stone transactions"
ON card_stone_transactions
FOR ALL TO service_role
USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION card_stone_value_for_rarity(p_rarity TEXT)
RETURNS INTEGER AS $$
BEGIN
  RETURN CASE p_rarity
    WHEN 'legendary' THEN 20
    WHEN 'epic' THEN 8
    WHEN 'rare' THEN 3
    ELSE 1
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION exchange_duplicate_card_for_stones(
  p_twitch_user_id TEXT,
  p_card_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID;
  v_streamer_id UUID;
  v_rarity TEXT;
  v_duplicate_count INTEGER;
  v_user_card_id UUID;
  v_stones INTEGER;
  v_balance INTEGER;
BEGIN
  SELECT id INTO v_user_id
  FROM users
  WHERE twitch_user_id = p_twitch_user_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
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

  DELETE FROM user_cards
  WHERE id = v_user_card_id;

  v_stones := card_stone_value_for_rarity(v_rarity);

  INSERT INTO card_stone_balances (user_id, streamer_id, balance)
  VALUES (v_user_id, v_streamer_id, v_stones)
  ON CONFLICT (user_id, streamer_id)
  DO UPDATE SET
    balance = card_stone_balances.balance + EXCLUDED.balance,
    updated_at = NOW()
  RETURNING balance INTO v_balance;

  INSERT INTO card_stone_transactions (
    user_id,
    streamer_id,
    card_id,
    user_card_id,
    amount,
    type
  )
  VALUES (
    v_user_id,
    v_streamer_id,
    p_card_id,
    v_user_card_id,
    v_stones,
    'duplicate_exchange'
  );

  RETURN jsonb_build_object(
    'cardId', p_card_id,
    'stonesGained', v_stones,
    'balance', v_balance,
    'remainingCount', v_duplicate_count - 1
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
