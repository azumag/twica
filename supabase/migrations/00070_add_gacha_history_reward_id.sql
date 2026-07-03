-- Issue #591: gacha_history に reward_id 列を追加し、ポーリング経路
-- (/api/overlay/[streamerId]/events) でも報酬別効果音ルールが発火するようにする。
--
-- 背景:
-- 報酬別サウンドルール({targetType: 'reward'} in gacha-sound-rules.ts, #451/#586)
-- の判定に使う rewardId は、これまで Supabase Realtime のブロードキャスト payload
-- 経由でのみ配信オーバーレイに届いていた(GachaResult.rewardId — executeGachaForEventSub
-- が event.reward.id を結果へ付加。src/lib/services/gacha.ts)。WebSocket が切断され
-- ポーリングフォールバックへ縮退すると、/api/overlay/[streamerId]/events は
-- gacha_history テーブルを読むが、この列が存在しなかったため rewardId は常に
-- null になり、報酬別ルールが一切発火せず rarity/all ルールへ静かにフォールバック
-- していた。
--
-- 対応: gacha_history.reward_id (Twitchチャネルポイント報酬ID文字列。
-- streamer_additional_gacha_rewards.reward_id / GachaResult.rewardId と同じ形の値。
-- cards.id とは無関係) を追加し、execute_gacha_transaction RPC の書き込み経路で
-- 一緒に永続化する。events API 側の読み出し変更は
-- src/app/api/overlay/[streamerId]/events/route.ts (本Issueの別ファイル) で行う。

ALTER TABLE gacha_history
  ADD COLUMN IF NOT EXISTS reward_id TEXT;

COMMENT ON COLUMN gacha_history.reward_id IS
  'ガチャ実行の起点になったTwitchチャネルポイント報酬ID (streamer_additional_gacha_rewards.reward_id / GachaResult.rewardId と同じ形)。cards.id とは別物。EventSub経由以外(レイドガチャ等)や既存レコードはNULL。Issue #591: ポーリング経路(/api/overlay/[streamerId]/events)の報酬別効果音ルール判定に使う。';

-- execute_gacha_transaction RPC に reward_id パラメータを追加する。
-- パラメータ追加はシグネチャ変更になるため、旧6引数版をDROPしてから7引数版を
-- 再作成する(00033_add_reward_cost_to_gacha_history.sql が reward_cost を追加した
-- 際と全く同じ理由: CREATE OR REPLACE だけでは「引数の型リストが異なる関数」は
-- 別オーバーロードとして新規作成されてしまい、旧6引数版と新7引数版が共存して
-- 呼び出し側の解決先が不定になる)。
--
-- デプロイ窓の互換性 (Issue #591 レビューで検証済み):
-- (a) 旧アプリコード(p_reward_id を送らない6引数呼び出し) + 新DB(本migration適用済み):
--     p_reward_id は DEFAULT NULL のため、6引数呼び出しはそのまま新関数(7引数版)に
--     解決される。標準的な「末尾に DEFAULT 付きパラメータを追加」の後方互換パターンで
--     安全。
-- (b) 新アプリコード(p_reward_id を含む7引数呼び出し) + 旧DB(本migration未適用、
--     旧6引数版のまま): Supabase-js の .rpc() は PostgREST 経由で名前付き引数として
--     RPCを呼ぶため、旧関数に存在しないパラメータ名 p_reward_id を送ると
--     42883 (undefined_function) になる。これは 00033 で p_reward_cost を追加した
--     際と全く同じ性質のデプロイ窓リスクであり、GachaService.executeGacha に既に
--     存在する 42883 → executeGachaLegacy フォールバック(src/lib/services/gacha.ts)が
--     そのまま吸収する。列とRPCは本ファイル内でアトミックに追加されるため、この
--     42883 が起きている間は gacha_history.reward_id 列も未デプロイであり、
--     executeGachaLegacy は意図的に reward_id を書き込まない(書けば列不在で
--     PGRST204 になり、legacy パス自体が壊れるため。詳細は gacha.ts 内コメント参照)。
--     → 追加のフォールバックコードは不要と判断。
DROP FUNCTION IF EXISTS execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER);

CREATE OR REPLACE FUNCTION execute_gacha_transaction(
  p_event_id TEXT,
  p_user_twitch_id TEXT,
  p_user_twitch_username TEXT,
  p_card_id UUID,
  p_streamer_id UUID,
  p_reward_cost INTEGER DEFAULT NULL,
  p_reward_id TEXT DEFAULT NULL
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
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER, TEXT) IS
  'ガチャのDB操作を1トランザクションで実行し、カード発行可能枚数の上限検証と報酬ID(reward_id)の記録を同時に行う(Issue #591)';

REVOKE ALL ON FUNCTION execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER, TEXT) TO service_role;
