-- migration-transaction: required
-- migration-providers: planetscale

-- N連をindividual配送するとき、各segmentは通常の単発チャットテンプレートを使う。
-- {num}/{unique} も単発と同じ意味にするには、relay時の現在値を再読込せず、ガチャcommit
-- 時点の最終所持数から各draw直後の値を復元できる必要がある。
--
-- 既存payload v1のchatSnapshotへcardCountsをadditiveに追加する。旧workerは未知keyを
-- 無視でき、新workerはfield欠落の旧outboxを従来snapshotへfallbackするため、migrationと
-- appの配備順に依存しない。

CREATE OR REPLACE FUNCTION public.snapshot_chat_outbox_individual_card_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_streamer_id uuid;
  v_user_twitch_id text;
  v_card_counts jsonb;
BEGIN
  -- 同じBEFORE INSERTのdelivery settings triggerは名前順で先に実行される。
  -- zz_ prefixのtriggerにして、そのsnapshot済みdelivery_modeだけを見て判定する。
  IF NEW.delivery_mode IS DISTINCT FROM 'individual'
     OR NEW.expected_draw_count <= 1 THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_streamer_id := nullif(NEW.payload #>> '{streamer,id}', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;
  v_user_twitch_id := nullif(NEW.payload #>> '{userId}', '');

  -- migration/fixture由来の最小payloadや旧形式を壊さない。正規のv1 payloadだけを拡張する。
  IF v_streamer_id IS NULL
     OR v_user_twitch_id IS NULL
     OR jsonb_typeof(NEW.payload #> '{gachaResult,cards}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.payload #> '{chatSnapshot}') IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;

  WITH drawn_card_ids AS (
    SELECT DISTINCT (drawn.card_payload ->> 'id')::uuid AS card_id
    FROM jsonb_array_elements(NEW.payload #> '{gachaResult,cards}') AS drawn(card_payload)
    WHERE jsonb_typeof(drawn.card_payload) = 'object'
      AND nullif(drawn.card_payload ->> 'id', '') IS NOT NULL
  ),
  final_counts AS (
    SELECT
      drawn.card_id,
      count(uc.id)::integer AS final_count
    FROM drawn_card_ids drawn
    JOIN public.cards c
      ON c.id = drawn.card_id
     AND c.streamer_id = v_streamer_id
    JOIN public.users u
      ON u.twitch_user_id = v_user_twitch_id
    LEFT JOIN public.user_cards uc
      ON uc.user_id = u.id
     AND uc.card_id = drawn.card_id
    GROUP BY drawn.card_id
  )
  SELECT coalesce(
    jsonb_object_agg(final_counts.card_id::text, final_counts.final_count),
    '{}'::jsonb
  )
  INTO v_card_counts
  FROM final_counts;

  NEW.payload := jsonb_set(
    NEW.payload,
    '{chatSnapshot,cardCounts}',
    v_card_counts,
    true
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_snapshot_chat_outbox_individual_card_counts
  ON public.chat_notification_outbox;
CREATE TRIGGER zz_snapshot_chat_outbox_individual_card_counts
  BEFORE INSERT ON public.chat_notification_outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.snapshot_chat_outbox_individual_card_counts();

REVOKE ALL ON FUNCTION public.snapshot_chat_outbox_individual_card_counts()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_chat_outbox_individual_card_counts()
  TO service_role;

COMMENT ON FUNCTION public.snapshot_chat_outbox_individual_card_counts() IS
  'individual N連を単発テンプレートで決定的に再送するため、当選cardごとのcommit時最終所持数をpayload.chatSnapshot.cardCountsへ保存する。';
