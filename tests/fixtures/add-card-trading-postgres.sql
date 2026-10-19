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
    -- trade_enabled=true だが cross_channel_trade_enabled=false。
    -- 「両配信者ともtrade_enabled=trueだがcross_channel_trade_enabled側だけが
    -- falseで拒否される」ケースをstreamer1との組で検証するために使う
    -- (シナリオ11)。
    '30000000-0000-4000-8000-000000000003',
    'trade-streamer-3', 'trade-streamer-3', 'Trade Streamer 3',
    true, false
  ),
  (
    -- 両フラグtrue。streamer1との組でクロスチャンネルの正常系(is_cross_channel
    -- 生成列の評価)を検証するために使う(シナリオ10)。
    '30000000-0000-4000-8000-000000000002',
    'trade-streamer-2', 'trade-streamer-2', 'Trade Streamer 2',
    true, true
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
  ),
  (
    '30000000-0000-4000-8000-0000000000c3',
    '30000000-0000-4000-8000-000000000002',
    'Card X', 'common', 0.5, true
  ),
  (
    '30000000-0000-4000-8000-0000000000c4',
    '30000000-0000-4000-8000-000000000003',
    'Card Y', 'common', 0.5, true
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

-- 10. is_cross_channel生成列: 異なる配信者間のオファーはtrue、同一配信者間は
-- false。RPCを呼ばず生成列の評価だけを直接検証する
-- (Claude Auto Reviewレビュー指摘: streamer3を作成したのに一度も使っていな
-- かった点、is_cross_channelとクロスチャンネルゲートが未検証だった点への対応)。
INSERT INTO public.trade_offers (
  id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '30000000-0000-4000-8000-0000000000e4',
  '30000000-0000-4000-8000-0000000000a1',
  '30000000-0000-4000-8000-0000000000d5',
  '30000000-0000-4000-8000-0000000000c1',
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-0000000000c3',
  '30000000-0000-4000-8000-000000000002',
  '{"name": "Card A", "rarity": "common", "imageUrl": null}'::jsonb,
  '{"name": "Card X", "rarity": "common", "imageUrl": null}'::jsonb
);

DO $$
DECLARE
  v_is_cross boolean;
BEGIN
  -- streamer1(offered) → streamer2(wanted): 異なる配信者間なのでtrue。
  SELECT is_cross_channel INTO v_is_cross FROM public.trade_offers
    WHERE id = '30000000-0000-4000-8000-0000000000e4';
  IF v_is_cross IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'cross-streamer offer was not flagged is_cross_channel: %', v_is_cross;
  END IF;

  -- streamer1(offered) → streamer1(wanted)(シナリオ1〜5で使ったオファーO1):
  -- 同一配信者間なのでfalse。
  SELECT is_cross_channel INTO v_is_cross FROM public.trade_offers
    WHERE id = '30000000-0000-4000-8000-0000000000e1';
  IF v_is_cross IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'same-streamer offer was flagged is_cross_channel: %', v_is_cross;
  END IF;
END
$$;

-- 11. クロスチャンネルゲート: 両配信者ともtrade_enabled=trueだが、片方の
-- cross_channel_trade_enabledがfalseならTRADE_DISABLEDで拒否される
-- (streamer3はtrade_enabled=true/cross_channel_trade_enabled=false)。
-- ゲート判定は出品カード実在チェック・支払いカード選定より前に行われるため、
-- 応諾者がwanted_card_idを実際に所持している必要はない。
INSERT INTO public.trade_offers (
  id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '30000000-0000-4000-8000-0000000000e5',
  '30000000-0000-4000-8000-0000000000a1',
  '30000000-0000-4000-8000-0000000000d6',
  '30000000-0000-4000-8000-0000000000c1',
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-0000000000c4',
  '30000000-0000-4000-8000-000000000003',
  '{"name": "Card A", "rarity": "common", "imageUrl": null}'::jsonb,
  '{"name": "Card Y", "rarity": "common", "imageUrl": null}'::jsonb
);

DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.accept_trade_offer(
    'trade-acceptor',
    '30000000-0000-4000-8000-0000000000e5'::uuid,
    '30000000-0000-4000-8000-0000000000f7'::uuid
  );
  IF v_result <> '{"success": false, "error": "TRADE_DISABLED"}'::jsonb THEN
    RAISE EXCEPTION 'cross-channel offer with cross_channel_trade_enabled=false was not rejected as TRADE_DISABLED: %', v_result;
  END IF;
END
$$;

-- 12. (#1789) 欲しいカード枚数指定 ×2 の正常成立: 応諾者の最古の2枚が一括移転し、
-- 3枚目以降は動かない。事前に u1 へ CardB のコピーを3枚(obtained_atをずらす)、
-- u2 へ CardA のコピーを1枚用意する。u1 は scenario 3 で CardB(d2, obtained_at
-- は成立時のnow())を持つが、d7/d8(2020-03/04)より新しいため選定されない。
INSERT INTO public.user_cards (id, user_id, card_id, obtained_at)
VALUES
  (
    '30000000-0000-4000-8000-0000000000d7',
    '30000000-0000-4000-8000-0000000000a1',
    '30000000-0000-4000-8000-0000000000c2',
    '2020-03-01 00:00:00+00'
  ),
  (
    '30000000-0000-4000-8000-0000000000d8',
    '30000000-0000-4000-8000-0000000000a1',
    '30000000-0000-4000-8000-0000000000c2',
    '2020-04-01 00:00:00+00'
  ),
  (
    '30000000-0000-4000-8000-0000000000d9',
    '30000000-0000-4000-8000-0000000000a1',
    '30000000-0000-4000-8000-0000000000c2',
    '2020-05-01 00:00:00+00'
  ),
  (
    '30000000-0000-4000-8000-0000000000da',
    '30000000-0000-4000-8000-0000000000a2',
    '30000000-0000-4000-8000-0000000000c1',
    '2019-12-01 00:00:00+00'
  );

INSERT INTO public.trade_offers (
  id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, wanted_quantity,
  offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '30000000-0000-4000-8000-0000000000e6',
  '30000000-0000-4000-8000-0000000000a2',
  '30000000-0000-4000-8000-0000000000da',
  '30000000-0000-4000-8000-0000000000c1',
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-0000000000c2',
  '30000000-0000-4000-8000-000000000001',
  2,
  '{"name": "Card A", "rarity": "common", "imageUrl": null}'::jsonb,
  '{"name": "Card B", "rarity": "rare", "imageUrl": null, "quantity": 2}'::jsonb
);

DO $$
DECLARE
  v_result jsonb;
  v_owner uuid;
  v_offer public.trade_offers%ROWTYPE;
BEGIN
  v_result := public.accept_trade_offer(
    'trade-offerer', -- u1 = acceptor(u2の出品に対する応諾)
    '30000000-0000-4000-8000-0000000000e6'::uuid,
    '30000000-0000-4000-8000-0000000000f8'::uuid
  );
  IF (v_result ->> 'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION '×2 accept did not succeed: %', v_result;
  END IF;
  IF v_result -> 'givenUserCardIds' <> '["30000000-0000-4000-8000-0000000000d7","30000000-0000-4000-8000-0000000000d8"]'::jsonb THEN
    RAISE EXCEPTION '×2 accept did not pay the two oldest copies: %', v_result;
  END IF;
  IF v_result ->> 'givenUserCardId' <> '30000000-0000-4000-8000-0000000000d7' THEN
    RAISE EXCEPTION 'scalar givenUserCardId must stay the oldest copy: %', v_result;
  END IF;
  IF (v_result ->> 'wantedQuantity')::int IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION '×2 accept did not report wantedQuantity: %', v_result;
  END IF;

  -- 選定された2枚はu2へ移転し、3枚目(d9)とd2(scenario 3由来・より新しい)は残る。
  SELECT user_id INTO v_owner FROM user_cards WHERE id = '30000000-0000-4000-8000-0000000000d7';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a2' THEN
    RAISE EXCEPTION 'first paid CardB copy did not move: %', v_owner;
  END IF;
  SELECT user_id INTO v_owner FROM user_cards WHERE id = '30000000-0000-4000-8000-0000000000d8';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a2' THEN
    RAISE EXCEPTION 'second paid CardB copy did not move: %', v_owner;
  END IF;
  SELECT user_id INTO v_owner FROM user_cards WHERE id = '30000000-0000-4000-8000-0000000000d9';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'newer CardB copy unexpectedly moved: %', v_owner;
  END IF;

  SELECT * INTO v_offer FROM public.trade_offers
    WHERE id = '30000000-0000-4000-8000-0000000000e6';
  IF v_offer.status <> 'completed'
     OR v_offer.accepted_user_card_id <> '30000000-0000-4000-8000-0000000000d7'
     OR v_offer.accepted_user_card_ids <> '{30000000-0000-4000-8000-0000000000d7,30000000-0000-4000-8000-0000000000d8}'::uuid[]
     OR v_offer.wanted_quantity <> 2 THEN
    RAISE EXCEPTION '×2 trade_offers row was not finalized correctly: %', row_to_json(v_offer);
  END IF;

  -- 冪等リプレイ: 同一request_idの再呼び出しでも配列つきの成功応答が返る。
  v_result := public.accept_trade_offer(
    'trade-offerer',
    '30000000-0000-4000-8000-0000000000e6'::uuid,
    '30000000-0000-4000-8000-0000000000f8'::uuid
  );
  IF (v_result -> 'givenUserCardIds') IS DISTINCT FROM
     '["30000000-0000-4000-8000-0000000000d7","30000000-0000-4000-8000-0000000000d8"]'::jsonb THEN
    RAISE EXCEPTION '×2 replay did not report the given copies: %', v_result;
  END IF;
END
$$;

-- 13. (#1789) 不足時失敗: ×3のオファーに対し応諾者の支払い用コピーが2枚しか
-- 無ければ CARD_NOT_OWNED で拒否され、部分的な移転(2枚だけ渡る)は決して起きない。
-- オファーはopenのまま残る(成立もcancelledもしない)。
INSERT INTO public.user_cards (id, user_id, card_id, obtained_at)
VALUES
  (
    '30000000-0000-4000-8000-0000000000db',
    '30000000-0000-4000-8000-0000000000a2',
    '30000000-0000-4000-8000-0000000000c1',
    '2019-11-01 00:00:00+00'
  );

INSERT INTO public.trade_offers (
  id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, wanted_quantity,
  offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '30000000-0000-4000-8000-0000000000e7',
  '30000000-0000-4000-8000-0000000000a2',
  '30000000-0000-4000-8000-0000000000db',
  '30000000-0000-4000-8000-0000000000c1',
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-0000000000c2',
  '30000000-0000-4000-8000-000000000001',
  3,
  '{"name": "Card A", "rarity": "common", "imageUrl": null}'::jsonb,
  '{"name": "Card B", "rarity": "rare", "imageUrl": null, "quantity": 3}'::jsonb
);

DO $$
DECLARE
  v_result jsonb;
  v_status text;
  v_owner uuid;
BEGIN
  v_result := public.accept_trade_offer(
    'trade-offerer',
    '30000000-0000-4000-8000-0000000000e7'::uuid,
    '30000000-0000-4000-8000-0000000000f9'::uuid
  );
  IF v_result <> '{"success": false, "error": "CARD_NOT_OWNED"}'::jsonb THEN
    RAISE EXCEPTION '×3 accept with only 2 copies must fail as CARD_NOT_OWNED: %', v_result;
  END IF;

  SELECT status INTO v_status FROM public.trade_offers
    WHERE id = '30000000-0000-4000-8000-0000000000e7';
  IF v_status <> 'open' THEN
    RAISE EXCEPTION '×3 offer must stay open after the shortage failure: %', v_status;
  END IF;

  -- 部分成立していないこと: 応諾者(u1)の未成立なCardBコピーは手放していない。
  SELECT user_id INTO v_owner FROM user_cards WHERE id = '30000000-0000-4000-8000-0000000000d2';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'shortage accept unexpectedly moved the offered copy: %', v_owner;
  END IF;
  SELECT user_id INTO v_owner FROM user_cards WHERE id = '30000000-0000-4000-8000-0000000000d9';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'shortage accept unexpectedly moved a payment copy: %', v_owner;
  END IF;

  -- CHECK制約: 枚数は1..10(11枚はINSERT自体がCHECK違反で弾かれる)。
  BEGIN
    INSERT INTO public.trade_offers (
      offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
      wanted_card_id, wanted_streamer_id, wanted_quantity,
      offered_card_snapshot, wanted_card_snapshot
    ) VALUES (
      '30000000-0000-4000-8000-0000000000a2',
      '30000000-0000-4000-8000-0000000000db',
      '30000000-0000-4000-8000-0000000000c1',
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-0000000000c2',
      '30000000-0000-4000-8000-000000000001',
      11,
      '{"name": "Card A", "rarity": "common", "imageUrl": null}'::jsonb,
      '{"name": "Card B", "rarity": "rare", "imageUrl": null}'::jsonb
    );
    RAISE EXCEPTION 'trade_offers.wanted_quantity=11 was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL; -- 期待どおり trade_offers_wanted_quantity_range に弾かれた。
  END;
END
$$;

-- 14. (#1789 レビュー) pre-migration 完了行のリプレイ後方互換:
-- migration 20261019120000 適用前に成立した行は accepted_user_card_id(スカラー)だけを持ち、
-- accepted_user_card_ids は追加列の既定値 '{}' のままである。rewritten RPC のリプレイ分支は
-- この行を「スカラーから1要素配列へ再構成」して返す。検証器(isValidTradeAcceptRpcResult)は
-- 空配列を拒否する(fail-closed)ため、この分岐が壊れると #1789 より前に成立した全トレードの
-- 冪等リプレイが恒久的に「invalid response」で失敗する。この分岐は新規成立では通らないため、
-- 現行経路で1:1オファー(wanted_quantity は INSERT 省略= DB 既定1)を成立させた後、
-- 配列列だけを pre-migration 相当へ巻き戻して再送し、リプレイ契約を検証する。
INSERT INTO public.trade_offers (
  id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id,
  offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '30000000-0000-4000-8000-0000000000e8',
  '30000000-0000-4000-8000-0000000000a2',
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
  v_result jsonb;
  v_owner uuid;
  v_offer public.trade_offers%ROWTYPE;
BEGIN
  -- 現行経路で1:1成立。u1 の CardB は d2(scenario 3 由来・成立時の now())と
  -- d9(2020-05)の2枚で、最古の d9 が選定される。d1 は scenario 3 で u2 が
  -- 受け取った CardA コピーで、e7(scenario 13 の出品 db)とは重複しない。
  v_result := public.accept_trade_offer(
    'trade-offerer',
    '30000000-0000-4000-8000-0000000000e8'::uuid,
    '30000000-0000-4000-8000-0000000000fa'::uuid
  );
  IF (v_result ->> 'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION '×1 accept did not succeed: %', v_result;
  END IF;
  IF (v_result ->> 'wantedQuantity')::int <> 1 THEN
    RAISE EXCEPTION '×1 accept did not report wantedQuantity=1: %', v_result;
  END IF;
  IF v_result ->> 'givenUserCardId' <> '30000000-0000-4000-8000-0000000000d9' THEN
    RAISE EXCEPTION '×1 accept did not select the oldest CardB copy: %', v_result;
  END IF;
  IF v_result -> 'givenUserCardIds' <> to_jsonb(ARRAY['30000000-0000-4000-8000-0000000000d9']::uuid[]) THEN
    RAISE EXCEPTION '×1 accept did not record the paid copy in givenUserCardIds: %', v_result;
  END IF;

  -- N=1 の成立でも配列側に全支払いコピー(=1枚)が記録されること。
  SELECT * INTO v_offer FROM public.trade_offers
    WHERE id = '30000000-0000-4000-8000-0000000000e8';
  IF v_offer.status <> 'completed'
     OR v_offer.wanted_quantity <> 1
     OR v_offer.accepted_user_card_ids <> ARRAY['30000000-0000-4000-8000-0000000000d9']::uuid[] THEN
    RAISE EXCEPTION '×1 completion did not persist wanted_quantity/accepted_user_card_ids: %', row_to_json(v_offer);
  END IF;

  -- 配列列だけを pre-migration 相当へ巻き戻す(migration 適用済みDB上の
  -- 旧完了行の状態と同一: スカラーは書かれ、配列は既定 '{}')。
  UPDATE public.trade_offers
    SET accepted_user_card_ids = '{}'::uuid[]
    WHERE id = '30000000-0000-4000-8000-0000000000e8';

  -- 同一(u1, request_id)での再送はリプレイとして成功し、スカラーから
  -- 1要素配列を再構成して返すこと。
  v_result := public.accept_trade_offer(
    'trade-offerer',
    '30000000-0000-4000-8000-0000000000e8'::uuid,
    '30000000-0000-4000-8000-0000000000fa'::uuid
  );
  IF (v_result ->> 'success')::boolean IS DISTINCT FROM true
     OR (v_result ->> 'idempotentReplay')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'replay of a pre-migration completed row did not succeed: %', v_result;
  END IF;
  IF (v_result ->> 'wantedQuantity')::int <> 1 THEN
    RAISE EXCEPTION 'pre-migration replay did not report wantedQuantity=1: %', v_result;
  END IF;
  IF v_result ->> 'givenUserCardId' <> '30000000-0000-4000-8000-0000000000d9' THEN
    RAISE EXCEPTION 'pre-migration replay lost the legacy scalar: %', v_result;
  END IF;
  IF v_result -> 'givenUserCardIds' <> to_jsonb(ARRAY['30000000-0000-4000-8000-0000000000d9']::uuid[]) THEN
    RAISE EXCEPTION 'pre-migration replay did not rebuild the 1-element array from the scalar: %', v_result;
  END IF;
  IF v_result ->> 'receivedUserCardId' <> '30000000-0000-4000-8000-0000000000d1' THEN
    RAISE EXCEPTION 'pre-migration replay lost the offered copy id: %', v_result;
  END IF;

  -- リプレイは所有権を再度変えないこと。
  SELECT user_id INTO v_owner FROM user_cards
    WHERE id = '30000000-0000-4000-8000-0000000000d9';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a2' THEN
    RAISE EXCEPTION 'pre-migration replay mutated the paid copy ownership: %', v_owner;
  END IF;
  SELECT user_id INTO v_owner FROM user_cards
    WHERE id = '30000000-0000-4000-8000-0000000000d1';
  IF v_owner <> '30000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'pre-migration replay mutated the offered copy ownership: %', v_owner;
  END IF;
END
$$;

RESET ROLE;
