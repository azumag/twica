-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #2045: チャット通知へパック単位のコンプ進捗プレースホルダー
-- {packUnique}/{packAll} を追加するため、chat_notification_outbox の
-- BEFORE INSERT trigger で payload.chatSnapshot.packCounts を保存する。
--
-- {unique}/{all}（全パック合算）の意味は変えない。packCounts は
--   { "<packKey>": { "unique": n, "all": m } }
-- の形で、当選カードが属する各パックについて
--   unique = そのパック内で視聴者が所持する有効カードの種類数
--   all    = そのパックの有効カード総数
-- を commit 時点の値として保持する。packKey はカード payload の
-- collection_name で、空/NULL は未分類カード用の予約キー __default__
-- （validation/collection-name.ts の DEFAULT_PACK_SENTINEL）に写す。
--
-- execute_gacha_transaction_with_chat_outbox 本体は置換しない。cardCountsを
-- 追加した 20260915113000_individual_multi_draw_single_template_snapshot.sql
-- と同じ方式（BEFORE INSERT trigger + jsonb_set）で payload v1/v2 へ加法的に
-- 拡張するため、旧workerは未知keyを無視し、新workerはfield欠落の旧outboxで
-- プレースホルダーを空文字にする。migrationとアプリの適用順序に依存しない。

CREATE OR REPLACE FUNCTION public.snapshot_chat_outbox_pack_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_streamer_id uuid;
  v_user_twitch_id text;
  v_pack_counts jsonb;
BEGIN
  -- 集計を行うかの判定を最初に行う。スナップショットされたテンプレート
  -- （単発・N連）のどちらにも {packUnique}/{packAll} が無い場合は集計せず、
  -- 利用しない配信者のガチャコストを増やさない。テンプレート未設定（NULL）は
  -- デフォルトテンプレートを意味し、デフォルトにはpackプレースホルダーが
  -- 無いため coalesce で空文字として扱う。migration/fixture由来の最小payloadも
  -- ここで自然に早期returnされる。
  IF position('{packUnique}' in coalesce(
        NEW.payload #>> '{streamer,chat_announcement_template}', '')) = 0
     AND position('{packAll}' in coalesce(
        NEW.payload #>> '{streamer,chat_announcement_template}', '')) = 0
     AND position('{packUnique}' in coalesce(
        NEW.payload #>> '{streamer,chat_announcement_multi_template}', '')) = 0
     AND position('{packAll}' in coalesce(
        NEW.payload #>> '{streamer,chat_announcement_multi_template}', '')) = 0 THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_streamer_id := nullif(NEW.payload #>> '{streamer,id}', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;
  v_user_twitch_id := nullif(NEW.payload #>> '{userId}', '');

  -- migration/fixture由来の最小payloadや旧形式を壊さない。正規のv1/v2 payload
  -- だけを拡張する（20260915113000 の cardCounts trigger と同じ防御境界）。
  IF v_streamer_id IS NULL
     OR v_user_twitch_id IS NULL
     OR jsonb_typeof(NEW.payload #> '{gachaResult,cards}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.payload #> '{chatSnapshot}') IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;

  -- 当選カードが属する各パックについて、有効カード総数（all）と、視聴者が
  -- 所持する有効カードの種類数（unique）を1クエリで集約する。カードの
  -- collection_name の空/NULLは __default__ へ写す規則はアプリ側の
  -- resolveCardPackKey（''||sentinel → sentinel）と厳密に一致させるため
  -- nullif('', ...) 経由で統一する。
  WITH drawn_pack_keys AS (
    SELECT DISTINCT
      coalesce(nullif(drawn.card_payload ->> 'collection_name', ''), '__default__')
        AS pack_key
    FROM jsonb_array_elements(NEW.payload #> '{gachaResult,cards}') AS drawn(card_payload)
    WHERE jsonb_typeof(drawn.card_payload) = 'object'
  ),
  pack_all AS (
    SELECT
      k.pack_key,
      count(*)::integer AS all_count
    FROM drawn_pack_keys k
    JOIN public.cards c
      ON c.streamer_id = v_streamer_id
     AND c.is_active = true
     AND coalesce(nullif(c.collection_name, ''), '__default__') = k.pack_key
    GROUP BY k.pack_key
  ),
  pack_owned AS (
    SELECT
      k.pack_key,
      count(DISTINCT uc.card_id)::integer AS unique_count
    FROM drawn_pack_keys k
    JOIN public.users u
      ON u.twitch_user_id = v_user_twitch_id
    JOIN public.user_cards uc
      ON uc.user_id = u.id
    JOIN public.cards c
      ON c.id = uc.card_id
     AND c.streamer_id = v_streamer_id
     AND c.is_active = true
     AND coalesce(nullif(c.collection_name, ''), '__default__') = k.pack_key
    GROUP BY k.pack_key
  )
  SELECT coalesce(
    jsonb_object_agg(
      k.pack_key,
      jsonb_build_object(
        'unique', coalesce(o.unique_count, 0),
        'all', coalesce(a.all_count, 0)
      )
    ),
    '{}'::jsonb
  )
  INTO v_pack_counts
  FROM drawn_pack_keys k
  LEFT JOIN pack_all a ON a.pack_key = k.pack_key
  LEFT JOIN pack_owned o ON o.pack_key = k.pack_key;

  NEW.payload := jsonb_set(
    NEW.payload,
    '{chatSnapshot,packCounts}',
    v_pack_counts,
    true
  );
  RETURN NEW;
END;
$$;

-- 同じBEFORE INSERT triggerは名前順に実行される。delivery settings
-- （snapshot_chat_outbox_delivery_settings）と individual cardCounts
-- （zz_snapshot_chat_outbox_individual_card_counts）のどちらとも独立に動くが、
-- zz_ prefixにして既存triggerとの名前衝突と実行順の暗黙依存を避ける。
DROP TRIGGER IF EXISTS zz_snapshot_chat_outbox_pack_counts
  ON public.chat_notification_outbox;
CREATE TRIGGER zz_snapshot_chat_outbox_pack_counts
  BEFORE INSERT ON public.chat_notification_outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.snapshot_chat_outbox_pack_counts();

REVOKE ALL ON FUNCTION public.snapshot_chat_outbox_pack_counts()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_chat_outbox_pack_counts()
  TO service_role;

COMMENT ON FUNCTION public.snapshot_chat_outbox_pack_counts() IS
  '{packUnique}/{packAll}を含むテンプレートを使う配信者だけ、当選カード各パックの有効カード総数とパック内所持種類数をpayload.chatSnapshot.packCountsへ保存する。';
