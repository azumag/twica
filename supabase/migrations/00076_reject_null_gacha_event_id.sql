-- Issue #661: execute_gacha_transaction RPC の唯一の重複防止機構は、
-- gacha_history.event_id の UNIQUE 制約 + `ON CONFLICT (event_id) DO NOTHING`
-- (00070_add_gacha_history_reward_id.sql 内の本関数定義を参照)である。
-- PostgreSQL の UNIQUE 制約は NULL 同士を「異なる値」として扱うため、
-- p_event_id = NULL で呼び出すと ON CONFLICT が一切発火せず、この関数の
-- 重複検知が丸ごと無効化される — 呼び出しをリトライすると
-- gacha_history / user_cards への書き込みが際限なく重複しうる。
--
-- 本番の Twitch EventSub 経路 (messageId を event_id として渡す) は常に
-- 非NULLのため現状で実害はないが、テスト・手動実行・将来追加されるかもしれない
-- 呼び出し元が NULL を渡すと、この防御が無言で無効化されたまま気づかれない
-- リスクがある。呼び出し規約として「event_id は必須」を明示的に強制するため、
-- 関数の先頭で NULL を拒否する (Issue #661 の案1)。
--
-- 実装時の追加調査: 本リポジトリには `p_event_id` を意図的に NULL のまま渡す
-- 既存の呼び出し元が実在した (src/app/api/gacha/route.ts の「実際にガチャを引く」
-- 手動ドローAPI。GachaService.executeGacha の eventId 引数を省略して呼んでいた)。
-- この関数を NULL 拒否にするだけでは当該エンドポイントが即座に例外で壊れるため、
-- 本 migration と同一PR内で当該呼び出し元も修正し、毎回一意な合成 event_id
-- (crypto.randomUUID()) を明示的に渡すように変更している (src/app/api/gacha/route.ts
-- の manualDrawEventId)。これにより「同じカードを何度でも引ける」という
-- 手動ドローの既存挙動は変えずに、NULL 拒否と両立させている。
--
-- デプロイ順序の注意 (docs/cloudflare-workers-builds.md, Issue #536 参照):
-- 本番デプロイは GitHub Actions の Supabase migration 適用と Cloudflare
-- Workers Builds のアプリデプロイが「同じ main への push」から独立に
-- トリガーされる非同期パイプラインであり、順序保証がない。したがって
-- このRPC変更はアプリ側の呼び出し規約を変更する(00070のような
-- 「引数追加」ではなく「既存引数の許容値の変更」)ため、本migrationが
-- アプリコード(上記route.ts修正)より先に本番へ適用された場合、
-- Cloudflare側のデプロイが追いつくまでの間(数分程度になりうる)
-- /api/gacha はRAISE EXCEPTIONに起因する500エラーを返しうる
-- (RAISE EXCEPTIONはPostgRESTの42883フォールバックの対象外のため、
-- gacha.ts の legacy フォールバックは吸収しない)。
-- 影響範囲: RAISE EXCEPTIONは関数の最初の文であり、FOR UPDATEロックや
-- INSERTより前に発生するため書き込みは一切発生しない。ユーザーへの影響は
-- 「ガチャを引くボタンが失敗し、再試行すれば成功する」に留まり、
-- 課金/データ不整合や二重付与は起きない。
-- ロールバック時の注意: 本migrationは他のマイグレーション同様
-- forward-only (CREATE OR REPLACE のみ、down-migration無し)。仮に
-- アプリコード側(route.ts の manualDrawEventId 変更)だけを本migration適用後に
-- ロールバックすると、/api/gacha は上記と同じ500エラーを恒久的に返し続ける
-- (自然回復しない)。オンコールは route.ts 側を再度適用するまで
-- 本migrationをロールバックしないこと(forward-onlyのため、
-- 対症療法として新しいmigrationで戻すこと自体は可能だが、
-- まずアプリコード側の復旧を優先する)。
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
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER, TEXT) IS
  'ガチャのDB操作を1トランザクションで実行し、カード発行可能枚数の上限検証と報酬ID(reward_id)の記録を同時に行う(Issue #591)。p_event_idはNULL禁止(Issue #661: NULLだとgacha_history.event_idのUNIQUE制約によるON CONFLICT重複検知が無効化されるため)。';
