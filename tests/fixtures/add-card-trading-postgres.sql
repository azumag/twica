\set ON_ERROR_STOP on

-- Issue #722 (#715 子2): migration SQLを文字列として読むだけの単体テストでは、
-- accept_trade_offer の冪等リプレイ・二重成立防止・設定ゲート・cancelled更新の
-- コミット・支払いカード選定(三値論理とトランザクション意味論)を検証できない。
-- CIのPostgreSQL 17へbaselineからmigrationを適用した後、このfixtureで
-- 実際のRPCと権限設定を検証する。

INSERT INTO public.streamers (
  id, twitch_user_id, twitch_username, twitch_display_name,
  trade_enabled, cross_channel_trade_enabled
) VALUES
  (
    '30000000-0000-4000-8000-000000000001',
    'trade-streamer-1', 'trade-streamer-1', 'Trade Streamer 1',
    true, true
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    'trade-streamer-3', 'trade-streamer-3', 'Trade Streamer 3',
    false, false
  );

INSERT INTO public.users (id, twitch_user_id, twitch_username, twitch_display_name)
VALUES
  (
    '30000000-0000-4000-8000-0000000000a1',
    'trade-offerer', 'trade-offerer', 'Trade Offerer'
  ),
  (
    '30000000-0000-4000-8000-0000000000a2',
    'trade-acceptor', 'trade-acceptor', 'Trade Acceptor'
  );

INSERT INTO public.cards (id, streamer_id, name, rarity, drop_rate, is_active)
VALUES
  (
    '30000000-0000-4000-8000-0000000000c1',
    '30000000-0000-4000-8000-000000000001',
    'Card A', 'common', 0.5, true
  ),
  (
    '30000000-0000-4000-8000-0000000000c2',
    '30000000-0000-4000-8000-000000000001',
    'Card B', 'rare', 0.3, true
  );

-- u1(出品者)がCardAを1枚、u2(応諾者)がCardBを2枚所持。CardBの2枚は
-- obtained_atを意図的にずらし、正常成立(シナリオ3)で最古の方(UC2)が
-- 選定されることを確認する材料にする。
INSERT INTO public.user_cards (id, user_id, card_id, obtained_at)
VALUES
  (
    '30000000-0000-4000-8000-0000000000d1',
    '30000000-0000-4000-8000-0000000000a1',
    '30000000-0000-4000-8000-0000000000c1',
    '2020-01-01 00:00:00+00'
  ),
  (
    '30000000-0000-4000-8000-0000000000d2',
    '30000000-0000-4000-8000-0000000000a2',
    '30000000-0000-4000-8000-0000000000c2',
    '2020-01-01 00:00:00+00'
  ),
  (
    '30000000-0000-4000-8000-0000000000d3',
    '30000000-0000-4000-8000-0000000000a2',
    '30000000-0000-4000-8000-0000000000c2',
    '2020-06-01 00:00:00+00'
  );

-- シナリオ1〜5(自己応諾拒否・設定オフ・正常成立・冪等リプレイ・二重成立防止)で
-- 使い回す、u1出品・CardA→CardB希望のオファー。
INSERT INTO public.trade_offers (
  id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '30000000-0000-4000-8000-0000000000e1',
  '30000000-0000-4000-8000-0000000000a1',
  '30000000-0000-4000-8000-0000000000d1',
  '30000000-0000-4000-8000-0000000000c1',
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-0000000000c2',
  '30000000-0000-4000-8000-000000000001',
  '{"name": "Card A", "rarity": "common", "imageUrl": null}'::jsonb,
  '{"name": "Card B", "rarity": "rare", "imageUrl": null}'::jsonb
);

DO $$
DECLARE
  v_signature text := 'public.accept_trade_offer(text,uuid,uuid)';
BEGIN
  -- 新RPCはruntimeロールだけに公開し、browser相当ロールへ露出させない。
  IF has_function_privilege('anon', v_signature, 'EXECUTE')
     OR has_function_privilege('authenticated', v_signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'browser role can execute accept_trade_offer';
  END IF;
  IF has_function_privilege('service_role', v_signature, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'service_role cannot execute accept_trade_offer';
  END IF;

  IF has_table_privilege('anon', 'public.trade_offers', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read trade_offers';
  END IF;
  -- has_table_privilegeへカンマ区切りを渡すと「いずれか」を満たすだけでtrueに
  -- なり得るため、runtime relayが必要とする4権限を個別に全件検証する。
  IF has_table_privilege('service_role', 'public.trade_offers', 'SELECT') IS NOT TRUE
     OR has_table_privilege('service_role', 'public.trade_offers', 'INSERT') IS NOT TRUE
     OR has_table_privilege('service_role', 'public.trade_offers', 'UPDATE') IS NOT TRUE
     OR has_table_privilege('service_role', 'public.trade_offers', 'DELETE') IS NOT TRUE THEN
    RAISE EXCEPTION 'service_role lacks trade_offers DML privileges';
  END IF;
END
$$;

-- ジョブ内の他ステップ(transactional-chat-outbox-postgres.sql等)と
-- postgresサービスコンテナを共有するため、twica_ciが既に作成済みの
-- 可能性がある。CREATE ROLEはIF NOT EXISTSを持たない(bootstrap.sqlと
-- 同じ理由)ため、pg_rolesを確認してから作成する冪等な形にする。
-- GRANT ROLEは既に付与済みのメンバーシップへ再実行してもエラーにならない。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'twica_ci') THEN
    CREATE ROLE twica_ci INHERIT BYPASSRLS;
  END IF;
END
$$;
GRANT service_role TO twica_ci;

SET ROLE twica_ci;

DO $$
DECLARE
  v_result jsonb;
  v_offer public.trade_offers%ROWTYPE;
  v_owner uuid;
BEGIN
  -- 1. 自己応諾拒否: 出品者自身がacceptすると成立させない。
  v_result := public.accept_trade_offer(
    'trade-offerer',
    '30000000-0000-4000-8000-0000000000e1'::uuid,
    '30000000-0000-4000-8000-0000000000f1'::uuid
  );
  IF v_result <> '{"success": false, "error": "SELF_ACCEPT_FORBIDDEN"}'::jsonb THEN
    RAISE EXCEPTION 'self-accept was not rejected: %', v_result;
  END IF;

  -- 2. 設定オフ時拒否: offered_streamer_id側のtrade_enabledを一時的にfalseへ。
  UPDATE public.streamers SET trade_enabled = false
    WHERE id = '30000000-0000-4000-8000-000000000001';
  v_result := public.accept_trade_offer(
    'trade-acceptor',
    '30000000-0000-4000-8000-0000000000e1'::uuid,
    '30000000-0000-4000-8000-0000000000f2'::uuid
  );
  IF v_result <> '{"success": false, "error": "TRADE_DISABLED"}'::jsonb THEN
    RAISE EXCEPTION 'trade-disabled offer was not rejected: %', v_result;
  END IF;
  UPDATE public.streamers SET trade_enabled = true
    WHERE id = '30000000-0000-4000-8000-000000000001';

  -- 3. 正常成立: u2がaccept。最古のCardBコピー(UC2)が選定されること、
  -- user_cardsの所有者が入れ替わること、trade_offersがcompletedになることを検証。
  v_result := public.accept_trade_offer(
    'trade-acceptor',
    '30000000-0000-4000-8000-0000000000e1'::uuid,
    '30000000-0000-4000-8000-0000000000f3'::uuid
  );
  IF (v_result ->> 'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'normal accept did not succeed: %', v_result;
  END IF;
  IF v_result ->> 'givenUserCardId' <> '30000000-0000-4000-8000-0000000000d2' THEN
    RAISE EXCEPTION 'accept did not select the older CardB copy: %', v_result;
  END IF;
  IF v_result ->> 'receivedUserCardId' <> '30000000-0000-4000-8000-0000000000d1' THEN
    RAISE EXCEPTION 'accept did not report the offered CardA copy: %', v_result;
  END IF;
  IF (v_result ->> 'idempotentReplay')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'first accept was reported as idempotent replay: %', v_result;
  END IF;

  SELECT user_id INTO v_owner FROM user_cards
    WHERE id = '30000000-0000-4000-8000-0000000000d1';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a2' THEN
    RAISE EXCEPTION 'offered CardA copy did not move to the acceptor: %', v_owner;
  END IF;
  SELECT user_id INTO v_owner FROM user_cards
    WHERE id = '30000000-0000-4000-8000-0000000000d2';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'paid CardB copy did not move to the offerer: %', v_owner;
  END IF;
  -- 応諾者が持っていた新しい方のCardBコピー(UC3)は今回の交換対象外なので
  -- 所有者が変化しないこと。
  SELECT user_id INTO v_owner FROM user_cards
    WHERE id = '30000000-0000-4000-8000-0000000000d3';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a2' THEN
    RAISE EXCEPTION 'untouched newer CardB copy unexpectedly moved: %', v_owner;
  END IF;

  SELECT * INTO v_offer FROM public.trade_offers
    WHERE id = '30000000-0000-4000-8000-0000000000e1';
  IF v_offer.status <> 'completed'
     OR v_offer.accepted_by_user_id <> '30000000-0000-4000-8000-0000000000a2'
     OR v_offer.accepted_user_card_id <> '30000000-0000-4000-8000-0000000000d2'
     OR v_offer.accepted_request_id <> '30000000-0000-4000-8000-0000000000f3' THEN
    RAISE EXCEPTION 'trade_offers row was not finalized correctly: %', row_to_json(v_offer);
  END IF;

  -- 4. 冪等リプレイ: 同じ(u2, 同一request_id)で再度accept。
  -- 副作用(user_cardsの所有者)が変化しないこと。
  v_result := public.accept_trade_offer(
    'trade-acceptor',
    '30000000-0000-4000-8000-0000000000e1'::uuid,
    '30000000-0000-4000-8000-0000000000f3'::uuid
  );
  IF (v_result ->> 'success')::boolean IS DISTINCT FROM true
     OR (v_result ->> 'idempotentReplay')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'replay with the same request_id was not idempotent: %', v_result;
  END IF;
  SELECT user_id INTO v_owner FROM user_cards
    WHERE id = '30000000-0000-4000-8000-0000000000d1';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a2' THEN
    RAISE EXCEPTION 'idempotent replay mutated CardA ownership again: %', v_owner;
  END IF;
  SELECT user_id INTO v_owner FROM user_cards
    WHERE id = '30000000-0000-4000-8000-0000000000d2';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'idempotent replay mutated CardB ownership again: %', v_owner;
  END IF;

  -- 5. 二重成立防止: 同じオファーを別のrequest_idでaccept。
  v_result := public.accept_trade_offer(
    'trade-acceptor',
    '30000000-0000-4000-8000-0000000000e1'::uuid,
    '30000000-0000-4000-8000-0000000000f4'::uuid
  );
  IF v_result <> '{"success": false, "error": "OFFER_NOT_OPEN"}'::jsonb THEN
    RAISE EXCEPTION 'second acceptor request was not rejected as OFFER_NOT_OPEN: %', v_result;
  END IF;
END
$$;

-- 6/7. 出品カード喪失→OFFER_INVALID + オファーがcancelledへ更新されること。
-- u1に新しいCardAコピー(UC4)を渡し、それを出品する新規オファーO2を作成した後、
-- そのuser_cards行を削除して「出品カード喪失」を再現する
-- (exchange_duplicate_card_for_stones等、取引相手の後日の行動で起こりうる)。
INSERT INTO public.user_cards (id, user_id, card_id, obtained_at)
VALUES (
  '30000000-0000-4000-8000-0000000000d4',
  '30000000-0000-4000-8000-0000000000a1',
  '30000000-0000-4000-8000-0000000000c1',
  now()
);
INSERT INTO public.trade_offers (
  id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '30000000-0000-4000-8000-0000000000e2',
  '30000000-0000-4000-8000-0000000000a1',
  '30000000-0000-4000-8000-0000000000d4',
  '30000000-0000-4000-8000-0000000000c1',
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-0000000000c2',
  '30000000-0000-4000-8000-000000000001',
  '{"name": "Card A", "rarity": "common", "imageUrl": null}'::jsonb,
  '{"name": "Card B", "rarity": "rare", "imageUrl": null}'::jsonb
);
DELETE FROM public.user_cards WHERE id = '30000000-0000-4000-8000-0000000000d4';

DO $$
DECLARE
  v_result jsonb;
  v_status text;
BEGIN
  v_result := public.accept_trade_offer(
    'trade-acceptor',
    '30000000-0000-4000-8000-0000000000e2'::uuid,
    '30000000-0000-4000-8000-0000000000f5'::uuid
  );
  IF v_result <> '{"success": false, "error": "OFFER_INVALID"}'::jsonb THEN
    RAISE EXCEPTION 'lost offered card was not rejected as OFFER_INVALID: %', v_result;
  END IF;
  SELECT status INTO v_status FROM public.trade_offers
    WHERE id = '30000000-0000-4000-8000-0000000000e2';
  IF v_status <> 'cancelled' THEN
    RAISE EXCEPTION 'offer with a lost offered card was not moved to cancelled: %', v_status;
  END IF;
END
$$;

-- 8. 支払いカード未所持→CARD_NOT_OWNED。シナリオ3で u1 の CardA(UC1) は既に
-- u2 へ移転済みのため u1 は CardA を0枚しか持たない。この状態を使い、
-- 出品者/応諾者を入れ替えたオファーO3(u2がCardB(UC3)を出品しCardAを希望)を
-- u1(acceptor)がacceptすると、支払いに使うCardAを1枚も持っていない。
-- 新しいカード定義を追加せず、既存の2種のカードだけで再現する。
INSERT INTO public.trade_offers (
  id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '30000000-0000-4000-8000-0000000000e3',
  '30000000-0000-4000-8000-0000000000a2',
  '30000000-0000-4000-8000-0000000000d3',
  '30000000-0000-4000-8000-0000000000c2',
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-0000000000c1',
  '30000000-0000-4000-8000-000000000001',
  '{"name": "Card B", "rarity": "rare", "imageUrl": null}'::jsonb,
  '{"name": "Card A", "rarity": "common", "imageUrl": null}'::jsonb
);

DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.accept_trade_offer(
    'trade-offerer',
    '30000000-0000-4000-8000-0000000000e3'::uuid,
    '30000000-0000-4000-8000-0000000000f6'::uuid
  );
  IF v_result <> '{"success": false, "error": "CARD_NOT_OWNED"}'::jsonb THEN
    RAISE EXCEPTION 'acceptor without the wanted card type was not rejected as CARD_NOT_OWNED: %', v_result;
  END IF;

  -- 9. 二重出品防止(部分UNIQUE制約): O3はまだopenのため、同じuser_cards行
  -- (UC3)を別のオファーとして再度INSERTしようとするとunique_violationになる。
  BEGIN
    INSERT INTO public.trade_offers (
      offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
      wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
    ) VALUES (
      '30000000-0000-4000-8000-0000000000a2',
      '30000000-0000-4000-8000-0000000000d3',
      '30000000-0000-4000-8000-0000000000c2',
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-0000000000c1',
      '30000000-0000-4000-8000-000000000001',
      '{"name": "Card B", "rarity": "rare", "imageUrl": null}'::jsonb,
      '{"name": "Card A", "rarity": "common", "imageUrl": null}'::jsonb
    );
    RAISE EXCEPTION 'duplicate open listing of the same user_cards row was accepted';
  EXCEPTION WHEN unique_violation THEN
    -- 期待どおり idx_trade_offers_open_user_card に弾かれた。
    NULL;
  END;
END
$$;

RESET ROLE;
