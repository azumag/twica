\set ON_ERROR_STOP on

-- Issue #803: migration SQLを文字列として読むだけの単体テストでは、PL/pgSQLの
-- 構文・三値論理・権限・行ロックを検証できない。CIのPostgreSQL 17へbaselineから
-- migrationを適用した後、このfixtureで実際のRPCとowner-fenced leaseを検証する。

INSERT INTO public.streamers (
  id, twitch_user_id, twitch_username, twitch_display_name,
  chat_announcement_enabled
) VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'broadcaster', 'broadcaster', 'Broadcaster', true
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'disabled', 'disabled', 'Disabled', false
  );

INSERT INTO public.cards (
  id, streamer_id, name, rarity, drop_rate, is_active
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'One', 'common', 0.3, true
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Two', 'rare', 0.3, true
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Three', 'epic', 0.4, true
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Disabled Card', 'common', 1, true
  );

-- `obtained_at` と今回のhistoryの `redeemed_at` の照合を実証するため、通常の
-- 既所有と歯抜け復旧の両方に、transaction開始時刻と異なる明示的な過去時刻を使う。
-- gap-viewerはOneを複数枚持つため、最終所持数だけの照合では不足を見逃す。
INSERT INTO public.users (twitch_user_id, twitch_username, twitch_display_name)
VALUES
  ('known-zero-viewer', 'Known Zero Viewer', 'Known Zero Viewer'),
  ('gap-viewer', 'Gap Viewer', 'Gap Viewer');

INSERT INTO public.user_cards (user_id, card_id, obtained_at)
SELECT users.id, seeded.card_id, '2020-01-01 00:00:00+00'::timestamptz
FROM public.users
JOIN (
  VALUES
    ('known-zero-viewer', '11111111-1111-4111-8111-111111111111'::uuid),
    ('known-zero-viewer', '22222222-2222-4222-8222-222222222222'::uuid),
    ('known-zero-viewer', '33333333-3333-4333-8333-333333333333'::uuid),
    ('gap-viewer', '11111111-1111-4111-8111-111111111111'::uuid),
    ('gap-viewer', '11111111-1111-4111-8111-111111111111'::uuid),
    ('gap-viewer', '33333333-3333-4333-8333-333333333333'::uuid)
) AS seeded(twitch_user_id, card_id) ON seeded.twitch_user_id = users.twitch_user_id;

CREATE ROLE twica_ci INHERIT BYPASSRLS;
GRANT service_role TO twica_ci;

DO $$
DECLARE
  v_signature text :=
    'public.execute_gacha_transaction_with_chat_outbox('
    || 'text,text,text,uuid,uuid,integer,text,text,integer,integer,text)';
BEGIN
  -- 新RPCとoutboxはruntimeロールだけに公開し、browser相当ロールへ露出させない。
  IF has_function_privilege('anon', v_signature, 'EXECUTE')
     OR has_function_privilege('authenticated', v_signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'browser role can execute transactional gacha RPC';
  END IF;
  IF has_function_privilege('service_role', v_signature, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'service_role cannot execute transactional gacha RPC';
  END IF;
  IF has_table_privilege('anon', 'public.chat_notification_outbox', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read chat outbox payload';
  END IF;
  -- has_table_privilegeへカンマ区切りを渡すと「いずれか」を満たすだけでtrueに
  -- なり得るため、runtime relayが必要とする4権限を個別に全件検証する。
  IF has_table_privilege('service_role', 'public.chat_notification_outbox', 'SELECT') IS NOT TRUE
     OR has_table_privilege('service_role', 'public.chat_notification_outbox', 'INSERT') IS NOT TRUE
     OR has_table_privilege('service_role', 'public.chat_notification_outbox', 'UPDATE') IS NOT TRUE
     OR has_table_privilege('service_role', 'public.chat_notification_outbox', 'DELETE') IS NOT TRUE THEN
    RAISE EXCEPTION 'service_role lacks chat outbox DML privileges';
  END IF;
END
$$;

SET ROLE twica_ci;

DO $$
DECLARE
  v_result jsonb;
  v_count integer;
  v_row_count integer;
  v_lease_a uuid := 'aaaaaaaa-1111-4111-8111-111111111111';
  v_lease_b uuid := 'bbbbbbbb-2222-4222-8222-222222222222';
BEGIN
  -- expand migration期間も旧7引数RPCが曖昧化・破損していないことを実呼出しする。
  v_result := public.execute_gacha_transaction(
    'legacy-event',
    'legacy-viewer',
    'Legacy Viewer',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    100,
    'legacy-reward'
  );
  IF (v_result ->> 'is_duplicate')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'legacy RPC did not succeed: %', v_result;
  END IF;

  v_result := public.execute_gacha_transaction_with_chat_outbox(
    'single-event',
    'single-viewer',
    'Single Viewer',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    100,
    'single-reward',
    'single-event',
    1,
    1,
    NULL
  );
  IF (v_result ->> 'is_duplicate')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'single draw did not succeed: %', v_result;
  END IF;
  -- 通常の初入手は、同一transactionでhistoryとuser_cardsが確定しているため、
  -- 名前配列と解決状態の両方をsnapshotできる。
  IF NOT EXISTS (
    SELECT 1
    FROM public.chat_notification_outbox
    WHERE batch_id = 'single-event'
      AND payload #> '{chatSnapshot,newCardNames}' = '["One"]'::jsonb
      AND payload #>> '{chatSnapshot,newCardNamesResolved}' = 'true'
  ) THEN
    RAISE EXCEPTION 'normal first acquisition was not marked as resolved';
  END IF;

  -- N連は最終drawと同じtransactionで、event_id順の完成payloadを1件だけ作る。
  PERFORM public.execute_gacha_transaction_with_chat_outbox(
    'batch-ok', 'batch-viewer', 'Batch Viewer',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    300, 'batch-reward', 'batch-ok', 1, 3, 'CI Pack'
  );
  PERFORM public.execute_gacha_transaction_with_chat_outbox(
    'batch-ok:2', 'batch-viewer', 'Batch Viewer',
    '22222222-2222-4222-8222-222222222222'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    NULL, 'batch-reward', 'batch-ok', 2, 3, 'CI Pack'
  );
  PERFORM public.execute_gacha_transaction_with_chat_outbox(
    'batch-ok:3', 'batch-viewer', 'Batch Viewer',
    '33333333-3333-4333-8333-333333333333'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    NULL, 'batch-reward', 'batch-ok', 3, 3, 'CI Pack'
  );

  SELECT count(*)::integer
    INTO v_count
    FROM public.chat_notification_outbox
    WHERE batch_id = 'batch-ok'
      AND status = 'pending'
      AND expected_draw_count = 3
      AND assembled_draw_count = 3
      AND jsonb_array_length(payload #> '{gachaResult,cards}') = 3
      AND payload #>> '{gachaResult,cards,0,name}' = 'One'
      AND payload #>> '{gachaResult,cards,1,name}' = 'Two'
      AND payload #>> '{gachaResult,cards,2,name}' = 'Three'
      AND payload #>> '{chatSnapshot,cardCount}' = '1'
      AND payload #>> '{chatSnapshot,uniqueCount}' = '3'
      AND payload #>> '{chatSnapshot,allCount}' = '3'
      AND payload #> '{chatSnapshot,newCardNames}' = '["One", "Two", "Three"]'::jsonb
      AND payload #>> '{chatSnapshot,newCardNamesResolved}' = 'true';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'normal 3-draw first-acquisition outbox was not resolved';
  END IF;

  -- 過去に全種を所持していたviewerでも、今回N連で作られる各historyとuser_cardsは
  -- 同一timestamp groupで一対一に対応する。そのため初入手0件でもtrueである。
  PERFORM public.execute_gacha_transaction_with_chat_outbox(
    'known-zero-batch', 'known-zero-viewer', 'Known Zero Viewer',
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    300, 'known-zero-reward', 'known-zero-batch', 1, 3, NULL
  );
  PERFORM public.execute_gacha_transaction_with_chat_outbox(
    'known-zero-batch:2', 'known-zero-viewer', 'Known Zero Viewer',
    '22222222-2222-4222-8222-222222222222'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    NULL, 'known-zero-reward', 'known-zero-batch', 2, 3, NULL
  );
  PERFORM public.execute_gacha_transaction_with_chat_outbox(
    'known-zero-batch:3', 'known-zero-viewer', 'Known Zero Viewer',
    '33333333-3333-4333-8333-333333333333'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    NULL, 'known-zero-reward', 'known-zero-batch', 3, 3, NULL
  );
  IF NOT EXISTS (
    SELECT 1
    FROM public.chat_notification_outbox
    WHERE batch_id = 'known-zero-batch'
      AND jsonb_array_length(payload #> '{gachaResult,cards}') = 3
      AND payload #> '{chatSnapshot,newCardNames}' = '[]'::jsonb
      AND payload #>> '{chatSnapshot,newCardNamesResolved}' = 'true'
  ) THEN
    RAISE EXCEPTION 'normal 3-draw zero-new-card result was not resolved';
  END IF;

  -- relay待ち中に所有数やcatalogが変わっても、versioned payloadはcommit時点の
  -- placeholder値を保持する。送信側が現在値を再問合せしない契約のDB側回帰。
  INSERT INTO public.user_cards (user_id, card_id)
  SELECT id, '11111111-1111-4111-8111-111111111111'::uuid
  FROM public.users
  WHERE twitch_user_id = 'batch-viewer';
  UPDATE public.cards
  SET is_active = false
  WHERE id = '33333333-3333-4333-8333-333333333333';
  IF NOT EXISTS (
    SELECT 1
    FROM public.chat_notification_outbox
    WHERE batch_id = 'batch-ok'
      AND payload #>> '{chatSnapshot,cardCount}' = '1'
      AND payload #>> '{chatSnapshot,uniqueCount}' = '3'
      AND payload #>> '{chatSnapshot,allCount}' = '3'
      AND payload #> '{chatSnapshot,newCardNames}' = '["One", "Two", "Three"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'chat placeholder snapshot changed after later DB mutations';
  END IF;

  -- chat無効時はカード履歴だけを確定し、容量を消費するoutbox行を作らない。
  PERFORM public.execute_gacha_transaction_with_chat_outbox(
    'disabled-event', 'disabled-viewer', 'Disabled Viewer',
    '44444444-4444-4444-8444-444444444444'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    100, 'disabled-reward', 'disabled-event', 1, 1, NULL
  );
  SELECT count(*)::integer INTO v_count
  FROM public.gacha_history
  WHERE event_id = 'disabled-event';
  IF v_count <> 1 OR EXISTS (
    SELECT 1 FROM public.chat_notification_outbox WHERE batch_id = 'disabled-event'
  ) THEN
    RAISE EXCEPTION 'chat-disabled draw did not preserve the zero-outbox invariant';
  END IF;

  -- 過去障害で最終eventだけ先に存在する歯抜けでも、不足分を補完した後の
  -- duplicate final呼出しが全履歴からoutboxを復元する。gap-viewerには過去時刻の
  -- One複数枚とThree一枚があり、今回のOne二回drawには同時timestampの所持行を一枚だけ置く。
  INSERT INTO public.gacha_history (
    event_id, user_twitch_id, user_twitch_username, card_id, streamer_id,
    reward_cost, reward_id
  ) VALUES
    (
      'batch-gap', 'gap-viewer', 'Gap Viewer',
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      300, 'gap-reward'
    ),
    (
      'batch-gap:3', 'gap-viewer', 'Gap Viewer',
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      NULL, 'gap-reward'
    ),
    (
      'batch-gap:4', 'gap-viewer', 'Gap Viewer',
      '33333333-3333-4333-8333-333333333333',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      NULL, 'gap-reward'
    );
  -- fixture全体は1 transactionなので `now()` は上のhistory.redeemed_atと同一になる。
  -- しかしOneのhistoryは二件で、この一枚を二件へ使い回す実装はresolved=trueにして
  -- しまう。timestamp groupの件数照合がfalseにすることを下で検証する。
  INSERT INTO public.user_cards (user_id, card_id, obtained_at)
  SELECT id, '11111111-1111-4111-8111-111111111111'::uuid, now()
  FROM public.users
  WHERE twitch_user_id = 'gap-viewer';
  PERFORM public.execute_gacha_transaction_with_chat_outbox(
    'batch-gap:2', 'gap-viewer', 'Gap Viewer',
    '22222222-2222-4222-8222-222222222222'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    NULL, 'gap-reward', 'batch-gap', 2, 4, NULL
  );
  v_result := public.execute_gacha_transaction_with_chat_outbox(
    'batch-gap:4', 'gap-viewer', 'Gap Viewer',
    '33333333-3333-4333-8333-333333333333'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    NULL, 'gap-reward', 'batch-gap', 4, 4, NULL
  );
  IF (v_result ->> 'is_duplicate')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'gap final was not reported as duplicate: %', v_result;
  END IF;
  SELECT count(*)::integer INTO v_count
  FROM public.chat_notification_outbox
  WHERE batch_id = 'batch-gap'
    AND jsonb_array_length(payload #> '{gachaResult,cards}') = 4
    -- final_countはOne二回drawとThree一回drawについて十分でも、今回のobtained_at
    -- groupはOne一枚・Three零枚。事前所持行や一枚の新規行をhistory付与へ使い回さず
    -- falseを永続化する。
    AND payload #>> '{chatSnapshot,newCardNamesResolved}' = 'false';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'gap recovery did not reconstruct an unresolved complete outbox';
  END IF;
  SELECT count(*)::integer INTO v_count
  FROM public.user_cards uc
  JOIN public.users u ON u.id = uc.user_id
  WHERE u.twitch_user_id = 'gap-viewer';
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'gap recovery did not preserve past ownership plus one new card';
  END IF;

  -- PostgreSQLのNULL比較はunknownになる。NULL draw位置を明示拒否しない回帰では、
  -- 履歴だけ作ってoutboxが無い半端なsuccessになるため、副作用0まで検証する。
  BEGIN
    PERFORM public.execute_gacha_transaction_with_chat_outbox(
      'null-index', 'null-viewer', 'Null Viewer',
      '11111111-1111-4111-8111-111111111111'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
      100, 'null-reward', 'null-index', NULL, 1, NULL
    );
    RAISE EXCEPTION 'NULL index accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'NULL index accepted' THEN
      RAISE;
    END IF;
  END;
  BEGIN
    PERFORM public.execute_gacha_transaction_with_chat_outbox(
      'null-count', 'null-viewer', 'Null Viewer',
      '11111111-1111-4111-8111-111111111111'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
      100, 'null-reward', 'null-count', 1, NULL, NULL
    );
    RAISE EXCEPTION 'NULL count accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'NULL count accepted' THEN
      RAISE;
    END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.gacha_history
    WHERE event_id IN ('null-index', 'null-count')
  ) OR EXISTS (
    SELECT 1 FROM public.chat_notification_outbox
    WHERE batch_id IN ('null-index', 'null-count')
  ) THEN
    RAISE EXCEPTION 'NULL draw validation left a partial side effect';
  END IF;

  -- live/Cron同時配送をowner leaseで直列化し、誤ownerのackをfenceする。
  UPDATE public.chat_notification_outbox
  SET status = 'processing',
      lease_id = v_lease_a,
      lease_expires_at = now() + interval '60 seconds',
      attempt_count = attempt_count + 1
  WHERE batch_id = 'single-event'
    AND status = 'pending';
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION 'initial chat outbox claim failed';
  END IF;

  UPDATE public.chat_notification_outbox
  SET lease_id = v_lease_b
  WHERE batch_id = 'single-event'
    AND (
      status = 'pending'
      OR (status = 'processing' AND lease_expires_at <= now())
    );
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 0 THEN
    RAISE EXCEPTION 'unexpired chat outbox lease was claimed twice';
  END IF;

  UPDATE public.chat_notification_outbox
  SET status = 'sent', sent_at = now(), lease_id = NULL, lease_expires_at = NULL
  WHERE batch_id = 'single-event'
    AND status = 'processing'
    AND lease_id = v_lease_b;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 0 THEN
    RAISE EXCEPTION 'wrong owner acknowledged chat outbox';
  END IF;

  UPDATE public.chat_notification_outbox
  SET status = 'sent', sent_at = now(), lease_id = NULL, lease_expires_at = NULL
  WHERE batch_id = 'single-event'
    AND status = 'processing'
    AND lease_id = v_lease_a;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION 'lease owner could not acknowledge chat outbox';
  END IF;

  -- 期限切れownerはreclaimでき、attempt_countを引き継いで上限へ進む。
  UPDATE public.chat_notification_outbox
  SET status = 'processing',
      lease_id = v_lease_a,
      lease_expires_at = now() - interval '1 second',
      attempt_count = 1
  WHERE batch_id = 'batch-ok';
  WITH candidates AS (
    SELECT id
    FROM public.chat_notification_outbox
    WHERE batch_id = 'batch-ok'
      AND status = 'processing'
      AND lease_expires_at <= now()
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.chat_notification_outbox AS outbox
  SET lease_id = v_lease_b,
      lease_expires_at = now() + interval '60 seconds',
      attempt_count = outbox.attempt_count + 1
  FROM candidates
  WHERE outbox.id = candidates.id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.chat_notification_outbox
    WHERE batch_id = 'batch-ok'
      AND lease_id = v_lease_b
      AND attempt_count = 2
  ) THEN
    RAISE EXCEPTION 'expired lease was not reclaimed with fencing';
  END IF;
END
$$;

RESET ROLE;
