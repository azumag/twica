-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #2045: チャット通知テンプレートに {packUnique}/{packAll} を追加する。
--   {packUnique} = 獲得カード（N連まとめ通知では先頭カード。{packName}と同じ基準）が
--                  属するパック内で、視聴者が所持している有効カードの種類数
--   {packAll}    = そのパックの有効カード総数
-- 既存の {unique}/{all}（配信者の全パック合算）の意味と出力は変えない。
--
-- {num}/{unique}/{all} と同じく、relay時に現在値を再読込するとbackoff中の別ガチャや
-- カード設定変更で本文が変わる。ガチャcommitと同じtransaction内のoutbox INSERT時点で
-- payload.chatSnapshot.packCounts = { "<packKey>": {"unique": n, "all": m}, ... } を
-- 当選カードに現れる各パックについて保存し、再送を決定的にする。
--
-- 配備順序に依存しない（app-firstヘッダー不要）理由:
--   - 既存関数は置換せず、BEFORE INSERT triggerを1本追加するだけの加法的変更。
--   - chatSnapshotへ未知keyを足すだけなので、旧workerはpackCountsを無視する。旧workerの
--     decoder（chat-notification-outbox.ts）はchatSnapshotの既知fieldだけを検証して
--     payloadを素通しするため、追加keyでDLQ行きにならない。
--   - 新workerはpackCounts欠落（migration前の行・集計スキップ行）を空文字へfallbackする。
--   - triggerはテンプレートに {packUnique}/{packAll} が含まれるときだけ集計するため、
--     トークンを使い始める前はmigrationだけ先に入っても実行コストも出力も変わらない。
--   注意: トークンを使い始めた後に旧アプリへロールバックすると、旧アプリはこのトークンを
--   知らないため `{packUnique}` が未置換のままチャットに出る（docs/QA.md に記載）。
--
-- 同じBEFORE INSERTのtrigger（snapshot_chat_outbox_delivery_settings、
-- zz_snapshot_chat_outbox_individual_card_counts）とは書き込み先のkeyが異なり、どれも
-- jsonb_setで既存payloadへ追記するだけなので、実行順（名前順）に依存しない。名前は
-- 既存のzz_ prefixに揃え、snapshot系triggerの最後に並べる。

CREATE OR REPLACE FUNCTION public.snapshot_chat_outbox_pack_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_single_template text;
  v_multi_template text;
  v_streamer_id uuid;
  v_user_twitch_id text;
  v_user_id uuid;
  v_pack_counts jsonb;
BEGIN
  -- このtriggerで例外が外へ出ると、同じtransactionのガチャ確定（カード付与・履歴）ごと
  -- rollbackされる。通知の付加情報より付与を優先するため、どの経路でも例外を外へ出さず、
  -- 想定外の入力はRETURN NEW（無加工）で返す。判定は安価な順に
  -- ①テンプレート判定 ②形状判定 ③集計 とし、トークン未使用の配信者には
  -- JSON参照数回以外のコストを掛けない。

  -- ① テンプレート判定。個別配送(individual)のN連は単発テンプレートを使い、配送時に
  -- 混雑でsummaryへ変わることもあるため、draw数やdelivery_modeでは絞らず、
  -- 単発・N連どちらかのテンプレートにトークンがあれば集計する。
  -- strpos(NULL, ...) はNULLを返し、IF NOT (NULL) は偽扱いで素通りしてしまうため、
  -- coalesceで「NULLは含まない」に正規化する（大文字小文字は区別する）。
  -- payloadが配列やスカラーでも #>> はNULLを返すだけで例外にならない。
  v_single_template := NEW.payload #>> '{streamer,chat_announcement_template}';
  v_multi_template := NEW.payload #>> '{streamer,chat_announcement_multi_template}';
  IF NOT (
    coalesce(strpos(v_single_template, '{packUnique}'), 0) > 0
    OR coalesce(strpos(v_single_template, '{packAll}'), 0) > 0
    OR coalesce(strpos(v_multi_template, '{packUnique}'), 0) > 0
    OR coalesce(strpos(v_multi_template, '{packAll}'), 0) > 0
  ) THEN
    RETURN NEW;
  END IF;

  -- ② 形状判定。migration/fixture由来の最小payloadや旧形式を壊さない。
  -- streamer idは正規表現で形を確かめてからcastし、castの例外を起こさない
  -- （subtransactionを使うのは③の集計だけにする）。
  v_user_twitch_id := nullif(NEW.payload #>> '{userId}', '');
  IF jsonb_typeof(NEW.payload #> '{chatSnapshot}') IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.payload #> '{gachaResult,cards}') IS DISTINCT FROM 'array'
     OR v_user_twitch_id IS NULL
     OR coalesce(
       (NEW.payload #>> '{streamer,id}')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
       false
     ) = false THEN
    RETURN NEW;
  END IF;
  v_streamer_id := (NEW.payload #>> '{streamer,id}')::uuid;

  -- ③ 集計。ブロック全体をEXCEPTION WHEN OTHERSで包み、想定外の失敗（型の異常、将来の
  -- schema変更による参照エラー等）でも通知の付加情報を諦めて付与を通す。
  -- subtransactionのコストとの比較:
  --   - ここへ来るのはトークンを使う配信者のoutbox INSERTだけで、1行（=N連1バッチ）に
  --     1回しか入らない（drawごとではない）。既存のcardCounts triggerもuuid castに
  --     同じEXCEPTIONブロックを使っており、同程度のコストは既に許容している。
  --   - ブロック内は読み取りのみで書き込みをしないため、subtransactionにXIDが割り当て
  --     られず、PGPROCのsubxact cache溢れ（64件超）の問題も起きない。
  --   - 「無加工で返す」はpackCounts欠落＝アプリ側で空文字になるだけで、通知自体は送る。
  -- WHEN OTHERSはquery_canceled（statement_timeout等）を捕捉しないため、明示的な
  -- キャンセルは従来どおりtransactionを止める（握りつぶすべきでないため意図どおり）。
  -- PL/pgSQLの変数代入はEXCEPTIONで巻き戻らないため、ブロック内ではlocal変数へ計算
  -- するだけにし、NEW.payloadへの代入はブロックを抜けた後で行う。
  BEGIN
    -- users行が無い（初回ガチャ前に削除された等）場合はv_user_idがNULLになり、下の
    -- EXISTSは常に偽 → unique=0。usersをJOINするとallまで消えるため変数で引く。
    -- 使用index: users_twitch_user_id_key (twitch_user_id)
    SELECT u.id
      INTO v_user_id
      FROM public.users u
     WHERE u.twitch_user_id = v_user_twitch_id;

    -- packKeyはアプリの resolveCardPackKey（collection_name || '__default__'）と同じ式。
    -- '__default__' は DEFAULT_PACK_SENTINEL（src/lib/validation/collection-name.ts）で、
    -- '__' 始まりは予約語として実パック名に登録できないため衝突しない。
    -- payloadのカードはこのtransaction内でcardsから組み立てたもので、collection_nameは
    -- 下のcards行と同じsnapshotの値になる。カードidは使わない（castの失敗面を作らない）。
    --
    -- 使用index:
    --   cards:      idx_cards_streamer_id (streamer_id) で配信者のカードに絞る
    --   user_cards: idx_user_cards_user_card (user_id, card_id, obtained_at) の先頭2列で
    --               所持の有無だけを判定する
    -- user_cardsは1枚1行なので count(*) では枚数になる。種類数にするため、カード行を
    -- 主にしてEXISTSで所持判定する（同一カード複数所持でも1と数える）。
    -- all・uniqueとも当該配信者の is_active = true のカードに限る（{unique}/{all}と同じ定義）。
    -- 有効カードが0件のパックキーはGROUP BYの結果に現れないので出力されない。パックの
    -- rename等で当選カードのキーとDBのキーがずれても 0/0 と誤表示せず、アプリ側では
    -- 欠落＝空文字になる。
    WITH drawn_pack_keys AS (
      SELECT DISTINCT
        coalesce(nullif(drawn.card_payload ->> 'collection_name', ''), '__default__') AS pack_key
      FROM jsonb_array_elements(NEW.payload #> '{gachaResult,cards}') AS drawn(card_payload)
      WHERE jsonb_typeof(drawn.card_payload) = 'object'
    ),
    pack_progress AS (
      SELECT
        coalesce(nullif(c.collection_name, ''), '__default__') AS pack_key,
        count(*)::integer AS all_count,
        count(*) FILTER (
          WHERE EXISTS (
            SELECT 1
            FROM public.user_cards uc
            WHERE uc.user_id = v_user_id
              AND uc.card_id = c.id
          )
        )::integer AS unique_count
      FROM public.cards c
      WHERE c.streamer_id = v_streamer_id
        AND c.is_active = true
        AND coalesce(nullif(c.collection_name, ''), '__default__') IN (
          SELECT pack_key FROM drawn_pack_keys
        )
      GROUP BY 1
    )
    SELECT jsonb_object_agg(
      pack_progress.pack_key,
      jsonb_build_object(
        'unique', pack_progress.unique_count,
        'all', pack_progress.all_count
      )
    )
    INTO v_pack_counts
    FROM pack_progress;
  EXCEPTION WHEN OTHERS THEN
    -- 黙って捨てると壊れたクエリでpackCountsが恒久的に欠落しても気付けないため、
    -- 付与は通しつつサーバーログに原因を残す。
    RAISE WARNING 'snapshot_chat_outbox_pack_counts skipped: % (SQLSTATE %)', SQLERRM, SQLSTATE;
    RETURN NEW;
  END;

  -- jsonb_object_aggは0行でNULLを返し、jsonb_setはSTRICTなのでNULLを渡すとpayload全体が
  -- NULLになる。payloadはNOT NULLで、その違反はtrigger終了後に起きるため上の
  -- EXCEPTIONでは捕捉できずガチャごとrollbackされる。必ず空objectへ正規化する。
  -- chatSnapshotは②でobjectと確認済みなので、jsonb_setはpackCountsを追記するだけで
  -- 既存のcardCounts等を消さない（chatSnapshot自体は作り直さない）。
  NEW.payload := jsonb_set(
    NEW.payload,
    '{chatSnapshot,packCounts}',
    coalesce(v_pack_counts, '{}'::jsonb),
    true
  );
  RETURN NEW;
END;
$$;

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
  'テンプレートが{packUnique}/{packAll}を使う場合だけ、当選カードの各パックについてcommit時点の所持種類数と有効カード総数をpayload.chatSnapshot.packCountsへ保存する（Issue #2045）。例外は外へ出さず無加工で返す。';
