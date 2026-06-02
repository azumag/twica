-- Card stone exchange idempotency + RPC hardening.
-- ダブり交換の冪等性キーを追加し、RPC のセキュリティを強化する。
--
-- 背景 / Background:
--   00059_add_card_stones_exchange.sql で導入した exchange_duplicate_card_for_stones は
--   二重送信や再試行で同じダブりを複数回交換できてしまう。クライアント生成の
--   request_id を冪等性キーとして受け取り、UNIQUE(user_id, request_id) と
--   INSERT ... ON CONFLICT DO NOTHING で多重交換を防止する。
--   あわせて SECURITY DEFINER 関数に search_path を固定し、検索パス汚染攻撃を防ぐ。

-- 1. 冪等性キー列を追加 / Add the idempotency key column.
ALTER TABLE card_stone_transactions
  ADD COLUMN IF NOT EXISTS request_id UUID;

-- ユーザー単位で request_id を一意にし、同一リクエストの再送を1回に収束させる。
-- Make request_id unique per user so a resent request collapses to a single exchange.
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_stone_transactions_user_request
  ON card_stone_transactions(user_id, request_id)
  WHERE request_id IS NOT NULL;

-- 2. RPC を再定義 / Redefine the RPC.
--    - p_request_id 引数を追加し、冪等性キーとして利用
--    - 取引行を先に ON CONFLICT DO NOTHING で挿入し、競合（再送）時は
--      残高変動・カード削除を行わず、保存済みの結果を再返却する
--    - SECURITY DEFINER 関数の search_path を固定（search_path 汚染対策）
CREATE OR REPLACE FUNCTION exchange_duplicate_card_for_stones(
  p_twitch_user_id TEXT,
  p_card_id UUID,
  p_request_id UUID
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 旧シグネチャ（p_request_id なし）の関数は曖昧呼び出し・冪等性回避を招くため削除する。
-- Drop the old 2-argument signature so callers cannot bypass the idempotency key.
DROP FUNCTION IF EXISTS exchange_duplicate_card_for_stones(TEXT, UUID);
