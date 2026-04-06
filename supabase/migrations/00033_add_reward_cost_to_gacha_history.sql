-- Migration: Add reward_cost column to gacha_history
-- チャネルポイント引き換え時に消費したポイント数を記録するカラムを追加
--
-- 目的:
-- - ユーザーが何ポイント使ってガチャを引いたかを記録・分析できるようにする
-- - 既存レコードはコスト不明のためNULLを許容

ALTER TABLE gacha_history
  ADD COLUMN IF NOT EXISTS reward_cost INTEGER;

COMMENT ON COLUMN gacha_history.reward_cost IS
  'Twitchチャネルポイント引き換え時に消費したポイント数。EventSub経由以外の場合はNULL';

-- execute_gacha_transaction RPC にポイント数パラメータを追加
-- パラメータ追加はシグネチャ変更になるため、旧関数をDROPして再作成する
-- CREATE OR REPLACE では旧5引数版と新6引数版が共存してオーバーロード競合が起きる
DROP FUNCTION IF EXISTS execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID);

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
BEGIN
  -- 1. gacha_history INSERT（event_id UNIQUE制約で重複を検知）
  -- event_idがNULLの場合はUNIQUE制約が効かないため常にINSERT成功
  -- event_idが既存の場合はDO NOTHINGで何もせず、v_history_idはNULLのまま
  INSERT INTO gacha_history (event_id, user_twitch_id, user_twitch_username, card_id, streamer_id, reward_cost)
  VALUES (p_event_id, p_user_twitch_id, p_user_twitch_username, p_card_id, p_streamer_id, p_reward_cost)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING id INTO v_history_id;

  -- 重複イベントの場合は早期リターン（カード付与をスキップ）
  IF v_history_id IS NULL AND p_event_id IS NOT NULL THEN
    RETURN jsonb_build_object('is_duplicate', true);
  END IF;

  -- 2. users UPSERT（存在しなければ作成、既存なら何もしない）
  -- twitch_display_nameはNOT NULL制約があるためusernameをデフォルト値として使用
  INSERT INTO users (twitch_user_id, twitch_username, twitch_display_name)
  VALUES (p_user_twitch_id, p_user_twitch_username, p_user_twitch_username)
  ON CONFLICT (twitch_user_id) DO NOTHING;

  -- ユーザーIDを取得（upsertでRETURNINGが効かない場合があるためSELECT）
  SELECT id INTO v_user_id FROM users WHERE twitch_user_id = p_user_twitch_id;

  -- 3. user_cards INSERT（カードをユーザーに付与）
  -- 同じカードの複数枚所持を許可（00010_allow_multiple_cardsでUNIQUE制約は削除済み）
  IF v_user_id IS NOT NULL THEN
    INSERT INTO user_cards (user_id, card_id, obtained_at)
    VALUES (v_user_id, p_card_id, NOW());
  END IF;

  RETURN jsonb_build_object('is_duplicate', false, 'history_id', v_history_id);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER) IS
  'ガチャのDB操作（履歴記録・ユーザー作成・カード付与）を1トランザクションでアトミックに実行。event_id重複時はカード付与をスキップ';

-- 実行権限をservice_roleのみに限定
REVOKE ALL ON FUNCTION execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER) TO service_role;
