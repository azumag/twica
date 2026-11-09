-- migration-transaction: required
-- migration-providers: planetscale

-- 視聴者が自分のガチャ履歴を削除すると、同じ交換のカードが再発行される問題の修正。
--
-- 問題:
--   ガチャの冪等性キーは gacha_history.event_id だけだった。視聴者は
--   DELETE /api/gacha-history/[id] で自分の履歴行を物理削除できるため、削除後に
--   同じ event が再実行されると、RPC は「未処理」と判定してカードを再発行していた。
--   再実行の経路は、Twitch の再送（webhook が 503 を返したとき）と、KV に退避した
--   event の replay（error-reporter が 20 分ごとに自動実行）。
--   N 連ガチャの途中で 1 枚目の行を消すと、最終 draw の完成判定
--   （chat outbox history incomplete）で失敗する。その後の replay は先頭の欠けた
--   draw から再開し、1 回の交換でカードが余分に発行される
--   （3 連で 4 枚になることを、隔離した PostgreSQL で再現済み）。
--
-- 設計（業界標準の「冪等性キーを業務データと別に保持する」方式）:
--   - 削除時に AFTER DELETE trigger が、event_id とカードの情報を
--     gacha_history_event_tombstones（墓石）へ残す。API の削除経路に限らず、
--     将来の一括削除などにも同じ不変条件が効くよう、trigger で集約する。
--   - RPC の duplicate 判定と N 連 batch の再構成は、履歴と墓石の両方を見る。
--     削除済み draw のカードは user_cards に残っているため、batch の完成判定と
--     チャット通知の内容は削除の影響を受けない。overlay の realtime 配信は
--     gacha_history の行が揃っている batch だけを送る（overlay-realtime/publisher.ts
--     の buildCommittedEnvelope）ため、途中で削除された batch は従来どおり表示されない。
--   - 履歴と墓石の event_id は互いに排他であることを前提にする（RPC は墓石のある
--     event へ履歴を挿入しない）。運用者が SQL で墓石のある event の履歴を再挿入
--     すると、batch の再構成で同じ draw を 2 回数え、'history incomplete' で失敗する
--     （fail-closed で、カードの二重発行にはならない）。
--   - アプリ側の再開位置（countCompletedDrawPrefix）も墓石を「完了済み」と数える
--     （src/lib/services/gacha.ts）。
--
-- カードや配信者の削除による CASCADE では墓石を残さない:
--   カードを消すと user_cards も CASCADE で消えるため、元の発行自体がなくなる。
--   この場合は再実行で別のカードを付与しても二重発行にならず、従来の挙動を保つ。
--   trigger は削除後にカード・配信者の行がまだ存在するときだけ墓石を書く
--   （CASCADE 中の AFTER trigger からは、親行の削除が見える）。墓石自体も
--   cards / streamers への FK を ON DELETE CASCADE にし、後からカードが
--   削除されたときに古い墓石が完成判定を妨げないようにする。
--
-- 保持する情報:
--   完成判定と通知内容の再構成に必要な列だけを持つ（event_id、card_id、
--   streamer_id、user_twitch_id、redeemed_at）。表示名や reward の情報は持たない。
--   墓石が必要なのは、KV に退避した event の TTL（7 日、src/lib/maintenance/
--   eventsub-park.ts）と Twitch の再送期間の間だけ。現時点では purge しない
--   （行は小さく、削除は視聴者の操作に限られる）。増えてきたら deleted_at に
--   索引を張り、30 日より古い墓石を消す保守処理を追加する。
--
-- migration 未適用の窓（アプリと migration の適用は非同期）:
--   - 新アプリ + 旧 DB: 墓石テーブルが無い（42P01）間、アプリは墓石なしで再開
--     位置を数える（従来どおり）。
--   - 旧アプリ + 新 DB: RPC は墓石を duplicate と判定するので、再発行は起きない。
--     ただし N 連の途中で削除された場合、旧アプリは再開位置を誤って 'Duplicate
--     event' で終えるため、残りの draw が付与されない。削除の直後にその batch の
--     replay が起きる場合だけで、窓は migration とアプリのデプロイの間に限られる。
--     新アプリは 42P01 を墓石なしとして扱うので、アプリを先にデプロイしてから
--     migration を適用すれば、この窓は生じない。
--
-- 権限と RLS: 既存の trade_auctions / storage_reservations と同じく、RLS は使わず、
--   service_role への明示的な GRANT と PUBLIC/anon/authenticated からの REVOKE で守る。
--
-- ロック: 墓石の INSERT は cards への FK 確認で、カード行に FOR KEY SHARE を取る。
--   配信者が同じカードを削除していて、その CASCADE が視聴者の削除中の履歴行を
--   待つと、まれにデッドロックになり得る。PostgreSQL が片方を中断し、削除 API が
--   500 を返すだけで、データは壊れない。頻度は無視できるので受け入れる。

-- gacha_history に CREATE TRIGGER（SHARE ROW EXCLUSIVE ロック）を取る。
-- ガチャの書き込みはこのテーブルに集中するため、長いトランザクションの後ろで
-- DDL が待ち続けて後続の抽選を止めないよう、5 秒で諦めて migration ごと失敗させる
-- （20261018030000_trade_auctions.sql と同じ方針）。
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.gacha_history_event_tombstones (
  event_id text PRIMARY KEY,
  streamer_id uuid NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE,
  user_twitch_id text NOT NULL,
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  redeemed_at timestamptz,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

-- カード・配信者の削除時の CASCADE が全件スキャンにならないよう、FK 列に索引を張る
-- （#614 の cards 参照 FK の無索引による statement timeout と同じ対策）。
CREATE INDEX IF NOT EXISTS gacha_history_event_tombstones_card_id_idx
  ON public.gacha_history_event_tombstones (card_id);
CREATE INDEX IF NOT EXISTS gacha_history_event_tombstones_streamer_id_idx
  ON public.gacha_history_event_tombstones (streamer_id);

COMMENT ON TABLE public.gacha_history_event_tombstones IS
  '削除された gacha_history 行の event_id（冪等性キー）。再送・replay でカードを再発行しないために RPC とアプリが参照する。';

CREATE OR REPLACE FUNCTION public.record_gacha_history_event_tombstone() RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- event_id のない行（EventSub 以外の経路）は冪等性キーを持たない。
  IF OLD.event_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- カード・配信者の削除による CASCADE では、元の発行（user_cards）も消えるため
  -- 墓石を残さない。親行が見えないことで CASCADE を判別する。
  IF NOT EXISTS (SELECT 1 FROM cards WHERE id = OLD.card_id)
     OR NOT EXISTS (SELECT 1 FROM streamers WHERE id = OLD.streamer_id) THEN
    RETURN NULL;
  END IF;

  INSERT INTO gacha_history_event_tombstones (
    event_id, streamer_id, user_twitch_id, card_id, redeemed_at
  )
  VALUES (
    OLD.event_id, OLD.streamer_id, OLD.user_twitch_id, OLD.card_id, OLD.redeemed_at
  )
  ON CONFLICT (event_id) DO NOTHING;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_gacha_history_event_tombstone ON public.gacha_history;
CREATE TRIGGER trg_record_gacha_history_event_tombstone
  AFTER DELETE ON public.gacha_history
  FOR EACH ROW EXECUTE FUNCTION public.record_gacha_history_event_tombstone();

-- 以下は 20260813120000_chat_pack_name_card_collection.sql の定義をそのまま引き継ぎ、
-- duplicate 判定と batch 再構成の 3 か所だけを墓石対応に変更する。
-- シグネチャは変えない（CREATE OR REPLACE で同じ versioned RPC を差し替える）。
CREATE OR REPLACE FUNCTION public.execute_gacha_transaction_with_chat_outbox(
  p_event_id text,
  p_user_twitch_id text,
  p_user_twitch_username text,
  p_card_id uuid,
  p_streamer_id uuid,
  p_reward_cost integer,
  p_reward_id text,
  p_chat_batch_id text,
  p_draw_index integer,
  p_draw_count integer,
  p_collection_name text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id uuid;
  v_history_id uuid;
  v_max_issuance_count integer;
  v_issued_count integer;
  v_cards_payload jsonb;
  v_outbox_count integer;
  v_card_count integer;
  v_unique_count integer;
  v_all_count integer;
  v_new_card_names jsonb;
  v_new_card_names_resolved boolean;
  v_is_duplicate boolean := false;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'event_id must not be null';
  END IF;
  -- PostgreSQLの比較演算はNULLをfalseではなくunknownにするため、範囲比較だけでは
  -- NULLを拒否できない。履歴だけ作ってoutboxを組み立てない半端な成功を防ぐ。
  IF p_draw_index IS NULL OR p_draw_count IS NULL
     OR p_draw_index < 1 OR p_draw_count < 1 OR p_draw_count > 15
     OR p_draw_index > p_draw_count THEN
    RAISE EXCEPTION 'invalid draw position: %/%', p_draw_index, p_draw_count;
  END IF;
  IF p_chat_batch_id IS NOT NULL
     AND p_event_id <> (CASE
       WHEN p_draw_index = 1 THEN p_chat_batch_id
       ELSE p_chat_batch_id || ':' || p_draw_index::text
     END) THEN
    RAISE EXCEPTION 'event_id does not match chat batch draw position';
  END IF;

  -- Twitch再送・live/Cron replayが同じeventを別transactionで同時実行し得る。
  -- card行だけをlockすると、別cardを抽選した再送は直列化されず、同じcardでも
  -- 先行COMMIT後の発行上限をduplicate判定より先に見て誤返金し得る。event_idの
  -- 64bit hashをtransaction advisory lockにし、同一eventのduplicate確認から
  -- outbox再構成までを直列化する。hash衝突は無関係な2件を一時直列化するだけで、
  -- correctnessや権限境界を壊さない。
  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id, 803));

  -- duplicate final drawでも下の全履歴再構成を実行する。歯抜けbatchで不足drawを
  -- 埋めた後、既存の最終eventへ到達した場合にoutboxを作り損ねないため。
  SELECT id INTO v_history_id
  FROM gacha_history
  WHERE event_id = p_event_id;
  v_is_duplicate := FOUND;

  -- 視聴者が履歴を削除してもevent_idの冪等性を失わない。削除時にtriggerが残した
  -- 墓石も「処理済み」とみなし、再送・replayで同じeventのカードを再発行しない。
  IF NOT v_is_duplicate THEN
    v_is_duplicate := EXISTS (
      SELECT 1
      FROM gacha_history_event_tombstones
      WHERE event_id = p_event_id
    );
  END IF;

  IF NOT v_is_duplicate THEN
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

    INSERT INTO gacha_history (
      event_id, user_twitch_id, user_twitch_username, card_id, streamer_id,
      reward_cost, reward_id
    )
    VALUES (
      p_event_id, p_user_twitch_id, p_user_twitch_username, p_card_id,
      p_streamer_id, p_reward_cost, p_reward_id
    )
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id INTO v_history_id;

    IF v_history_id IS NULL THEN
      -- pre-check後に同じeventを別transactionがcommitした競合。カード付与はせず、
      -- duplicate finalなら下のoutbox再構成だけを安全に試みる。
      v_is_duplicate := true;
    ELSE
      INSERT INTO users (twitch_user_id, twitch_username, twitch_display_name)
      VALUES (p_user_twitch_id, p_user_twitch_username, p_user_twitch_username)
      ON CONFLICT (twitch_user_id) DO NOTHING;

      SELECT id INTO v_user_id FROM users WHERE twitch_user_id = p_user_twitch_id;

      IF v_user_id IS NOT NULL THEN
        INSERT INTO user_cards (user_id, card_id, obtained_at)
        VALUES (v_user_id, p_card_id, now());
      END IF;
    END IF;
  END IF;

  IF p_chat_batch_id IS NOT NULL AND p_draw_index = p_draw_count THEN
    -- N連途中にbuilding行を残すと、webhookが2xxを返した後の部分失敗で永久孤児に
    -- なる。最終drawのtransaction内で、確定済みgacha_historyをevent_id順に
    -- 再構成し、全件揃った場合だけ完成済みpendingを1件作る。
    WITH expected_events AS (
      SELECT
        draw_index,
        CASE
          WHEN draw_index = 1 THEN p_chat_batch_id
          ELSE p_chat_batch_id || ':' || draw_index::text
        END AS event_id
      FROM generate_series(1, p_draw_count) AS draw(draw_index)
    ),
    ordered_cards AS (
      SELECT
        expected_events.draw_index,
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'description', c.description,
          'image_url', c.image_url,
          'rarity', c.rarity,
          'drop_rate', c.drop_rate,
          'max_issuance_count', c.max_issuance_count,
          'collection_name', c.collection_name
        ) AS card_payload
      FROM expected_events
      JOIN (
        -- 削除済みdrawも「確定済み」として扱う。視聴者が履歴行を消してもカードは
        -- user_cardsに残っているため、batchの完成判定・通知内容はdeleteの影響を
        -- 受けない。event_idは両テーブルで一意かつ互いに排他（RPCは墓石のある
        -- eventへ履歴を再挿入しない）なので、UNION ALLで重複しない。
        SELECT event_id, card_id, streamer_id, user_twitch_id, redeemed_at
        FROM gacha_history
        UNION ALL
        SELECT event_id, card_id, streamer_id, user_twitch_id, redeemed_at
        FROM gacha_history_event_tombstones
      ) gh ON gh.event_id = expected_events.event_id
      JOIN cards c ON c.id = gh.card_id
      WHERE gh.streamer_id = p_streamer_id
        AND gh.user_twitch_id = p_user_twitch_id
    )
    SELECT jsonb_agg(card_payload ORDER BY draw_index), count(*)::integer
      INTO v_cards_payload, v_outbox_count
      FROM ordered_cards;

    IF v_outbox_count <> p_draw_count THEN
      RAISE EXCEPTION 'chat outbox history incomplete for batch %: expected %, found %',
        p_chat_batch_id, p_draw_count, v_outbox_count;
    END IF;

    -- chat無効時は所有数集約もoutbox INSERTも実行しない。enabled streamerの1行
    -- 存在確認だけに絞り、通知を使わない配信者のガチャコストを増やさない。
    IF EXISTS (
      SELECT 1
      FROM streamers
      WHERE id = p_streamer_id
        AND chat_announcement_enabled = true
    ) THEN
      -- 所有数系placeholderをrelay時に再問合せすると、retry待ちの別ガチャやカード
      -- 設定変更で元の通知本文が変わる。ユーザー所持を1回だけ集約し、{num}、
      -- {unique}、{all}、{newCards}をこのtransactionの同一statement snapshotで
      -- 固定する。relayはこのversioned値だけを使い、外部送信リトライを決定的にする。
      WITH user_card_counts AS (
      SELECT
        uc.card_id,
        count(*)::integer AS final_count,
        bool_or(c.is_active = true) AS is_active
      FROM users u
      JOIN user_cards uc ON uc.user_id = u.id
      JOIN cards c
        ON c.id = uc.card_id
       AND c.streamer_id = p_streamer_id
      WHERE u.twitch_user_id = p_user_twitch_id
      GROUP BY uc.card_id
    ),
    expected_events AS (
      -- CTEはstatementをまたいで共有できない。上のstatementは全historyの完成を
      -- 先にfail-closed検証し、ここではchat有効時だけ所有数を集約するため、同じ
      -- event列を意図的に再定義する。単一statement化するとchat無効配信者にも
      -- placeholder集約コストが発生するため、この重複を保つ。
      SELECT
        draw_index,
        CASE
          WHEN draw_index = 1 THEN p_chat_batch_id
          ELSE p_chat_batch_id || ':' || draw_index::text
        END AS event_id
      FROM generate_series(1, p_draw_count) AS draw(draw_index)
    ),
    drawn_card_counts AS (
      SELECT
        gh.card_id,
        min(expected_events.draw_index) AS first_draw_index,
        count(*)::integer AS drawn_count,
        min(c.name) AS card_name
      FROM expected_events
      JOIN (
        -- 削除済みdrawも「確定済み」として扱う。視聴者が履歴行を消してもカードは
        -- user_cardsに残っているため、batchの完成判定・通知内容はdeleteの影響を
        -- 受けない。event_idは両テーブルで一意かつ互いに排他（RPCは墓石のある
        -- eventへ履歴を再挿入しない）なので、UNION ALLで重複しない。
        SELECT event_id, card_id, streamer_id, user_twitch_id, redeemed_at
        FROM gacha_history
        UNION ALL
        SELECT event_id, card_id, streamer_id, user_twitch_id, redeemed_at
        FROM gacha_history_event_tombstones
      ) gh ON gh.event_id = expected_events.event_id
      JOIN cards c ON c.id = gh.card_id
      -- event_idは一意で上のordered_cardsも完成を検証済みだが、この集約だけを
      -- 読んでも別配信者・別ユーザーの履歴を混入させない防御境界を明示する。
      WHERE gh.streamer_id = p_streamer_id
        AND gh.user_twitch_id = p_user_twitch_id
      GROUP BY gh.card_id
    ),
    expected_history_timestamp_counts AS (
      SELECT
        gh.card_id,
        gh.redeemed_at,
        count(*)::integer AS expected_count
      FROM expected_events
      JOIN (
        -- 削除済みdrawも「確定済み」として扱う。視聴者が履歴行を消してもカードは
        -- user_cardsに残っているため、batchの完成判定・通知内容はdeleteの影響を
        -- 受けない。event_idは両テーブルで一意かつ互いに排他（RPCは墓石のある
        -- eventへ履歴を再挿入しない）なので、UNION ALLで重複しない。
        SELECT event_id, card_id, streamer_id, user_twitch_id, redeemed_at
        FROM gacha_history
        UNION ALL
        SELECT event_id, card_id, streamer_id, user_twitch_id, redeemed_at
        FROM gacha_history_event_tombstones
      ) gh ON gh.event_id = expected_events.event_id
      WHERE gh.streamer_id = p_streamer_id
        AND gh.user_twitch_id = p_user_twitch_id
      GROUP BY gh.card_id, gh.redeemed_at
    ),
    obtained_card_timestamp_counts AS (
      SELECT
        uc.card_id,
        uc.obtained_at,
        count(*)::integer AS obtained_count
      FROM users u
      JOIN user_cards uc ON uc.user_id = u.id
      JOIN cards c
        ON c.id = uc.card_id
       AND c.streamer_id = p_streamer_id
      WHERE u.twitch_user_id = p_user_twitch_id
      GROUP BY uc.card_id, uc.obtained_at
    )
    SELECT
      coalesce((
        SELECT final_count
        FROM user_card_counts
        WHERE card_id = (v_cards_payload -> 0 ->> 'id')::uuid
      ), 0),
      (SELECT count(*)::integer FROM user_card_counts WHERE is_active),
      (
        SELECT count(*)::integer
        FROM cards
        WHERE streamer_id = p_streamer_id
          AND is_active = true
      ),
      coalesce((
        SELECT jsonb_agg(drawn.card_name ORDER BY drawn.first_draw_index)
        FROM drawn_card_counts drawn
        JOIN user_card_counts owned ON owned.card_id = drawn.card_id
        WHERE owned.final_count > 0
          AND owned.final_count - drawn.drawn_count <= 0
      ), '[]'::jsonb),
      NOT EXISTS (
        -- 歯抜け復旧では過去historyが存在してもuser_cardsが無い場合がある。
        -- 各distinct drawについて所持行と最終所持数を確認し、どちらかが欠けるなら
        -- 配列の空/非空を「初入手0件」の根拠にしてはいけない。
        SELECT 1
        FROM drawn_card_counts drawn
        LEFT JOIN user_card_counts owned ON owned.card_id = drawn.card_id
        WHERE owned.card_id IS NULL OR owned.final_count < drawn.drawn_count
      )
      AND NOT EXISTS (
        -- 歯抜け復旧で過去の所持カードが残っているだけでは、そのカードが今回の
        -- historyで実際に付与された証拠にならない。各eventのredeemed_atと同じ
        -- obtained_atをcardごとにgroup化し、同一timestamp groupの件数まで照合する。
        -- 同じカードを同一transaction内で複数drawした場合も、1枚の所持行を複数の
        -- historyへ使い回せないため、初入手0件と判定不能を安全に区別できる。
        SELECT 1
        FROM expected_history_timestamp_counts expected
        LEFT JOIN obtained_card_timestamp_counts confirmed
          ON confirmed.card_id = expected.card_id
         AND confirmed.obtained_at = expected.redeemed_at
        WHERE expected.redeemed_at IS NULL
           OR confirmed.obtained_count IS NULL
           OR confirmed.obtained_count < expected.expected_count
      )
      INTO v_card_count, v_unique_count, v_all_count, v_new_card_names,
        v_new_card_names_resolved;

      -- `newCardNames` はv1の配列契約を維持する。追加fieldは任意で、旧workerは
      -- 未知keyを無視できる。新workerはfield欠落の旧payloadを判定不能として扱い、
      -- 過去のsnapshotを再問合せして配送内容を変えない。
      INSERT INTO public.chat_notification_outbox (
      batch_id, payload_version, payload, expected_draw_count,
      assembled_draw_count, status
    )
    SELECT
      p_chat_batch_id,
      1,
      jsonb_build_object(
        'batchId', p_chat_batch_id,
        'broadcasterTwitchUserId', s.twitch_user_id,
        'userId', p_user_twitch_id,
        'streamer', jsonb_build_object(
          'id', s.id,
          'chat_announcement_enabled', s.chat_announcement_enabled,
          'chat_announcement_template', s.chat_announcement_template,
          'chat_announcement_multi_template', s.chat_announcement_multi_template,
          'chat_announcement_multi_show_cards', s.chat_announcement_multi_show_cards,
          'default_card_pack_name', s.default_card_pack_name
        ),
        'gachaResult', jsonb_build_object(
          'type', 'gacha',
          'card', v_cards_payload -> 0,
          'cards', v_cards_payload,
          'userTwitchUsername', p_user_twitch_username,
          'rewardId', p_reward_id,
          'collectionName', p_collection_name
        ),
        'chatSnapshot', jsonb_build_object(
          'cardCount', v_card_count,
          'uniqueCount', v_unique_count,
          'allCount', v_all_count,
          'newCardNames', v_new_card_names,
          'newCardNamesResolved', v_new_card_names_resolved
        )
      ),
      p_draw_count,
      p_draw_count,
      'pending'
    FROM streamers s
    WHERE s.id = p_streamer_id
      AND s.chat_announcement_enabled = true
      ON CONFLICT (batch_id) DO NOTHING;
    END IF;
  END IF;

  IF v_is_duplicate THEN
    RETURN jsonb_build_object(
      'is_duplicate', true,
      -- final duplicateは歯抜け/応答消失回復で再構成した完全なカード列を返す。
      -- アプリは残drawだけの配列をoverlay batchとして誤採番せずに済む。
      'cards', CASE
        WHEN p_chat_batch_id IS NOT NULL AND p_draw_index = p_draw_count
          THEN v_cards_payload
        ELSE NULL
      END
    );
  END IF;

  RETURN jsonb_build_object(
    'is_duplicate', false,
    'limit_reached', false,
    'history_id', v_history_id,
    'cards', CASE
      WHEN p_chat_batch_id IS NOT NULL AND p_draw_index = p_draw_count
        THEN v_cards_payload
      ELSE NULL
    END
  );
END;
$$;

COMMENT ON FUNCTION public.execute_gacha_transaction_with_chat_outbox(
  text, text, text, uuid, uuid, integer, text, text, integer, integer, text
) IS
  'ガチャ確定とchat outbox組立を同一transactionで実行するversioned RPC。削除済み履歴の墓石（gacha_history_event_tombstones）もduplicate判定とbatch再構成に含める。';

-- ---------------------------------------------------------------------------
-- 権限
--
-- grants.sql の ALTER DEFAULT PRIVILEGES は migration を適用したロールに依存する
-- ため、新規オブジェクトにはこの migration 内で明示的に GRANT / REVOKE する
-- （20261023000000_storage_reservation_and_reconcile.sql と同じ方針）。
-- 墓石への INSERT は、履歴を削除したロールの権限で trigger から行われる。
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE public.gacha_history_event_tombstones FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.gacha_history_event_tombstones TO service_role;

REVOKE ALL ON FUNCTION public.record_gacha_history_event_tombstone()
  FROM PUBLIC, anon, authenticated;
