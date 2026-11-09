-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1907: #1896 の残項目。
--   1. 保存前の容量予約を原子的に行い、R2 失敗時に解放できるようにする。
--   2. blob_files（正本）と storage_usage（キャッシュ）の差分を再照合する。
--
-- 設計:
-- - 予約は storage_usage を直接増やさず storage_reservations に行を追加する。
--   予約中（R2 保存中）のバイト数も上限判定に含めるが、台帳である
--   storage_usage / blob_files には触れない。そのため再照合は blob_files だけを
--   正本にでき、アップロード中の予約と競合しない。
-- - reserve / commit / release / update_storage_usage / reconcile はすべて
--   同じ transaction-level advisory lock を最初に取得し、容量会計を直列化する。
--   アップロード頻度に対してロック区間は短く（数クエリ）、並列ユーザー間の
--   上限突破を構造的に防ぐ。
-- - 予約には TTL を持たせる。Workers が落ちて commit/release されなかった予約は
--   TTL 経過後の reserve / reconcile で回収され、容量を永久に占有しない。
-- - RLS は設定しない。storage_usage/blob_files 等の既存 RLS は Supabase 時代の
--   PostgREST/anon 経路を塞ぐための名残で、現行の PlanetScale 直結経路には
--   PostgREST が存在しない。storage_reservations へ到達できるのはアプリの DB
--   ロールだけであり、テーブルを新設しても公開面は増えない。
CREATE TABLE IF NOT EXISTS public.storage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_prefix varchar(8) NOT NULL,
  file_size bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT storage_reservations_size_positive CHECK (file_size > 0),
  CONSTRAINT storage_reservations_prefix_length
    CHECK (char_length(user_prefix) = 8 AND user_prefix <> '_global_')
);

COMMENT ON TABLE public.storage_reservations IS
  '保存前の容量予約。R2 保存成功時に commit_storage_reservation で blob_files/使用量へ確定し、失敗時は release_storage_reservation で破棄する。';
COMMENT ON COLUMN public.storage_reservations.id IS
  '予約ID。commit/release の冪等な照合キー。';
COMMENT ON COLUMN public.storage_reservations.expires_at IS
  '予約の有効期限。経過した予約は reserve/reconcile が回収する。';

CREATE INDEX IF NOT EXISTS idx_storage_reservations_expires_at
  ON public.storage_reservations (expires_at);
CREATE INDEX IF NOT EXISTS idx_storage_reservations_user_prefix
  ON public.storage_reservations (user_prefix);

-- ---------------------------------------------------------------------------
-- 容量予約
--
-- 戻り値:
--   reservation_id = 予約ID（outcome='reserved' のときのみ非 NULL）
--   outcome        = 'reserved' | 'user_limit' | 'global_limit'
--
-- 上限判定には「確定済みの storage_usage」と「有効な予約の合計」を両方含める。
-- これがないと、同じユーザー/全体に対する並列アップロードが互いの予約を見ずに
-- 上限を突破できる（#1896 完了条件2）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_storage_usage(
  p_user_prefix varchar(8),
  p_size bigint,
  p_user_limit bigint,
  p_global_limit bigint,
  p_ttl_seconds integer DEFAULT 900
) RETURNS TABLE (reservation_id uuid, outcome text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_reservation_id uuid;
  v_user_bytes bigint;
  v_global_bytes bigint;
  v_reserved_user bigint;
  v_reserved_global bigint;
BEGIN
  IF p_size IS NULL OR p_size <= 0 THEN
    RAISE EXCEPTION 'p_size must be a positive bigint (got %)', p_size;
  END IF;
  IF p_user_limit IS NULL OR p_user_limit < 0
     OR p_global_limit IS NULL OR p_global_limit < 0 THEN
    RAISE EXCEPTION 'storage limits must be non-negative';
  END IF;
  IF p_user_prefix IS NULL
     OR char_length(p_user_prefix) <> 8
     OR p_user_prefix = '_global_' THEN
    RAISE EXCEPTION 'invalid user prefix for storage reservation: %', p_user_prefix;
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'p_ttl_seconds must be positive (got %)', p_ttl_seconds;
  END IF;

  -- すべての容量会計操作が同じロックを取るため、この時点で他の reserve/commit/
  -- release/reconcile/update は完了済みか待機中になる。ロック順の逆転は無い。
  PERFORM pg_advisory_xact_lock(hashtext('twica.storage_usage')::bigint);

  -- 落ちた Worker が残した期限切れ予約を回収する。TTL は十分長い（既定15分）ため、
  -- 正常な R2 保存（最大でも数秒）を巻き込むことはない。
  DELETE FROM public.storage_reservations WHERE expires_at <= now();

  -- 行が無い環境（初期化前・新規ユーザー）でも判定できるよう 0 行を作る。
  INSERT INTO public.storage_usage (user_prefix, bytes_used, blob_count)
  VALUES ('_global_', 0, 0), (p_user_prefix, 0, 0)
  ON CONFLICT (user_prefix) DO NOTHING;

  SELECT bytes_used INTO v_user_bytes
  FROM public.storage_usage WHERE user_prefix = p_user_prefix;
  SELECT bytes_used INTO v_global_bytes
  FROM public.storage_usage WHERE user_prefix = '_global_';
  SELECT COALESCE(SUM(file_size), 0) INTO v_reserved_user
  FROM public.storage_reservations WHERE user_prefix = p_user_prefix;
  SELECT COALESCE(SUM(file_size), 0) INTO v_reserved_global
  FROM public.storage_reservations;

  -- 全体上限を先に判定する（画面の既存挙動・文言と合わせる）。
  IF v_global_bytes + v_reserved_global + p_size > p_global_limit THEN
    reservation_id := NULL;
    outcome := 'global_limit';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_user_bytes + v_reserved_user + p_size > p_user_limit THEN
    reservation_id := NULL;
    outcome := 'user_limit';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.storage_reservations (user_prefix, file_size, expires_at)
  VALUES (p_user_prefix, p_size, now() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_reservation_id;

  reservation_id := v_reservation_id;
  outcome := 'reserved';
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.reserve_storage_usage(varchar, bigint, bigint, bigint, integer) IS
  '追加バイト数を原子的に予約する。確定済み使用量と有効な予約の合計で上限を判定し、reserved/user_limit/global_limit を返す。';

-- ---------------------------------------------------------------------------
-- 予約の確定
--
-- blob_files への INSERT と storage_usage の加算、予約行の削除を同一トランザクション
-- （1関数呼び出し）で行う。呼び出し元が RPC の失敗を検知できるよう、失敗は例外で返す。
--
-- 戻り値:
--   'committed'              = 新規に確定した
--   'already_committed'      = 同じ URL が既に確定済み（再送。使用量は増やさない）
--   'reservation_not_found'  = 予約が無い（期限切れ回収・二重解放など）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commit_storage_reservation(
  p_reservation_id uuid,
  p_url text,
  p_storage_type varchar,
  p_user_prefix varchar(8),
  p_size bigint
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_prefix varchar(8);
  v_file_size bigint;
  v_inserted integer;
  v_existing public.blob_files%ROWTYPE;
BEGIN
  IF p_reservation_id IS NULL THEN
    RAISE EXCEPTION 'p_reservation_id is required';
  END IF;
  IF p_url IS NULL OR btrim(p_url) = '' THEN
    RAISE EXCEPTION 'p_url is required';
  END IF;
  IF p_storage_type IS NULL OR p_storage_type NOT IN ('r2', 'vercel') THEN
    RAISE EXCEPTION 'invalid storage type: %', p_storage_type;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('twica.storage_usage')::bigint);

  SELECT r.user_prefix, r.file_size
  INTO v_user_prefix, v_file_size
  FROM public.storage_reservations r
  WHERE r.id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- 予約が無い場合でも、同じ URL が同じ所有者・サイズで既に確定済みなら
    -- 再送（commit の応答だけ失われたケース）として成功扱いにする。これがないと
    -- 呼び出し元が R2 オブジェクトを補償削除し、台帳だけが残る不整合になる。
    SELECT * INTO v_existing FROM public.blob_files WHERE url = p_url;
    IF FOUND
       AND v_existing.user_prefix = p_user_prefix
       AND v_existing.file_size = p_size THEN
      RETURN 'already_committed';
    END IF;
    RETURN 'reservation_not_found';
  END IF;

  -- 呼び出し元の引数と予約内容の不一致はプログラム誤りのため、容量を確定せず
  -- 例外にする（誤ったサイズで台帳を更新しない）。
  IF v_user_prefix <> p_user_prefix OR v_file_size <> p_size THEN
    RAISE EXCEPTION
      'storage reservation mismatch: reserved user=% size=%, requested user=% size=%',
      v_user_prefix, v_file_size, p_user_prefix, p_size;
  END IF;

  SELECT * INTO v_existing FROM public.blob_files WHERE url = p_url;
  IF FOUND THEN
    IF v_existing.user_prefix <> v_user_prefix OR v_existing.file_size <> v_file_size THEN
      RAISE EXCEPTION 'blob file URL already recorded with different ownership/size: %', p_url;
    END IF;
    -- 再送: 使用量は既に加算済みなので、予約だけ破棄して成功扱いにする。
    DELETE FROM public.storage_reservations WHERE id = p_reservation_id;
    RETURN 'already_committed';
  END IF;

  INSERT INTO public.blob_files (url, user_prefix, file_size, storage_type)
  VALUES (p_url, v_user_prefix, v_file_size, p_storage_type)
  ON CONFLICT (url) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    -- 上の SELECT と INSERT の間に他経路が同じ URL を入れた場合。所有権が同じなら
    -- 再送と同様に扱う（通常は起きない）。
    SELECT * INTO v_existing FROM public.blob_files WHERE url = p_url;
    IF NOT FOUND
       OR v_existing.user_prefix <> v_user_prefix
       OR v_existing.file_size <> v_file_size THEN
      RAISE EXCEPTION 'blob file URL conflict while committing: %', p_url;
    END IF;
    DELETE FROM public.storage_reservations WHERE id = p_reservation_id;
    RETURN 'already_committed';
  END IF;

  -- ユーザーとグローバルの両方を同じトランザクションで加算する。
  INSERT INTO public.storage_usage (user_prefix, bytes_used, blob_count, updated_at)
  VALUES (v_user_prefix, v_file_size, 1, now())
  ON CONFLICT (user_prefix) DO UPDATE SET
    bytes_used = public.storage_usage.bytes_used + EXCLUDED.bytes_used,
    blob_count = public.storage_usage.blob_count + EXCLUDED.blob_count,
    updated_at = now();

  INSERT INTO public.storage_usage (user_prefix, bytes_used, blob_count, updated_at)
  VALUES ('_global_', v_file_size, 1, now())
  ON CONFLICT (user_prefix) DO UPDATE SET
    bytes_used = public.storage_usage.bytes_used + EXCLUDED.bytes_used,
    blob_count = public.storage_usage.blob_count + EXCLUDED.blob_count,
    updated_at = now();

  DELETE FROM public.storage_reservations WHERE id = p_reservation_id;
  RETURN 'committed';
END;
$$;

COMMENT ON FUNCTION public.commit_storage_reservation(uuid, text, varchar, varchar, bigint) IS
  '予約を確定し、blob_files への記録と storage_usage の加算を原子的に行う。';

-- ---------------------------------------------------------------------------
-- 予約の解放（R2 保存失敗・台帳確定失敗の補償）
-- 予約は storage_usage を変更していないため、行を削除するだけでよい。
-- 冪等: 既に無い場合は false を返す。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_storage_reservation(
  p_reservation_id uuid
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('twica.storage_usage')::bigint);

  DELETE FROM public.storage_reservations WHERE id = p_reservation_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

COMMENT ON FUNCTION public.release_storage_reservation(uuid) IS
  '容量予約を破棄する。予約は storage_usage を変更しないため減算は不要。冪等。';

-- ---------------------------------------------------------------------------
-- 既存の使用量更新（削除経路）にも同じ advisory lock を取らせる。
-- reconcile と並行して減算が消える（lost update）のを防ぐ。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_storage_usage(
  p_user_prefix VARCHAR(8),
  p_size_delta BIGINT,
  p_count_delta INT
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('twica.storage_usage')::bigint);

  -- ユーザーの使用量を更新（存在しなければ挿入）
  INSERT INTO storage_usage (user_prefix, bytes_used, blob_count, updated_at)
  VALUES (p_user_prefix, GREATEST(0, p_size_delta), GREATEST(0, p_count_delta), NOW())
  ON CONFLICT (user_prefix) DO UPDATE SET
    bytes_used = GREATEST(0, storage_usage.bytes_used + p_size_delta),
    blob_count = GREATEST(0, storage_usage.blob_count + p_count_delta),
    updated_at = NOW();

  -- グローバル使用量を更新
  UPDATE storage_usage SET
    bytes_used = GREATEST(0, bytes_used + p_size_delta),
    blob_count = GREATEST(0, blob_count + p_count_delta),
    updated_at = NOW()
  WHERE user_prefix = '_global_';
END;
$$;

COMMENT ON FUNCTION public.update_storage_usage(varchar, bigint, integer) IS
  'ストレージ使用量を更新（ユーザーとグローバル両方）。容量会計の advisory lock を取得する。';

-- ---------------------------------------------------------------------------
-- 台帳の再照合
--
-- blob_files を正本として storage_usage を再計算する。戻り値は「修正した差分」のみ。
-- 予約中（storage_reservations）のバイト数は台帳に含めない（予約はまだファイルとして
-- 確定していないため）。advisory lock により commit / update と直列化される。
--
-- 使い方:
--   SELECT * FROM reconcile_storage_usage();
-- 戻り値が 0 行なら差分なし。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_storage_usage()
RETURNS TABLE (
  user_prefix varchar(8),
  previous_bytes bigint,
  actual_bytes bigint,
  previous_count integer,
  actual_count integer
)
LANGUAGE plpgsql
AS $$
-- RETURNS TABLE の出力列 user_prefix が storage_usage.user_prefix と同じ名前のため、
-- ON CONFLICT (user_prefix) などが PL/pgSQL 変数と列のどちらか判定できなくなる。
-- この関数内では列参照を優先する（出力列は最後に明示的に SELECT する）。
#variable_conflict use_column
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('twica.storage_usage')::bigint);

  -- 期限切れ予約の回収もこのジョブの責務に含める。
  DELETE FROM public.storage_reservations WHERE expires_at <= now();

  INSERT INTO public.storage_usage (user_prefix, bytes_used, blob_count)
  VALUES ('_global_', 0, 0)
  ON CONFLICT (user_prefix) DO NOTHING;

  -- 一時テーブルは作らない（migration の非加法検知が DROP TABLE を拾うため）。
  -- 差分の算出と更新を 1 文の CTE にまとめ、差分 CTE は更新前のスナップショットから
  -- 作る。データ変更 CTE は参照されなくても PostgreSQL が一度だけ実行する。
  RETURN QUERY
  WITH actual AS (
    SELECT
      b.user_prefix,
      SUM(b.file_size)::bigint AS bytes_used,
      COUNT(*)::integer AS blob_count
    FROM public.blob_files b
    WHERE b.user_prefix <> '_global_'
    GROUP BY b.user_prefix
  ),
  totals AS (
    SELECT
      COALESCE(SUM(b.file_size), 0)::bigint AS bytes_used,
      COUNT(*)::integer AS blob_count
    FROM public.blob_files b
  ),
  user_diffs AS (
    SELECT
      COALESCE(a.user_prefix, s.user_prefix)::varchar(8) AS user_prefix,
      COALESCE(s.bytes_used, 0)::bigint AS previous_bytes,
      COALESCE(a.bytes_used, 0)::bigint AS actual_bytes,
      COALESCE(s.blob_count, 0)::integer AS previous_count,
      COALESCE(a.blob_count, 0)::integer AS actual_count
    FROM actual a
    FULL OUTER JOIN public.storage_usage s ON s.user_prefix = a.user_prefix
    WHERE COALESCE(a.user_prefix, s.user_prefix) <> '_global_'
      AND (
        COALESCE(a.bytes_used, 0) <> COALESCE(s.bytes_used, 0)
        OR COALESCE(a.blob_count, 0) <> COALESCE(s.blob_count, 0)
      )
  ),
  global_diff AS (
    SELECT
      '_global_'::varchar(8) AS user_prefix,
      COALESCE(g.bytes_used, 0)::bigint AS previous_bytes,
      t.bytes_used AS actual_bytes,
      COALESCE(g.blob_count, 0)::integer AS previous_count,
      t.blob_count AS actual_count
    FROM totals t
    LEFT JOIN public.storage_usage g ON g.user_prefix = '_global_'
    WHERE COALESCE(g.bytes_used, 0) <> t.bytes_used
       OR COALESCE(g.blob_count, 0) <> t.blob_count
  ),
  diffs AS (
    SELECT * FROM user_diffs
    UNION ALL
    SELECT * FROM global_diff
  ),
  upsert_users AS (
    INSERT INTO public.storage_usage (user_prefix, bytes_used, blob_count, updated_at)
    SELECT a.user_prefix, a.bytes_used, a.blob_count, now()
    FROM actual a
    ON CONFLICT (user_prefix) DO UPDATE SET
      bytes_used = EXCLUDED.bytes_used,
      blob_count = EXCLUDED.blob_count,
      updated_at = now()
    WHERE public.storage_usage.bytes_used IS DISTINCT FROM EXCLUDED.bytes_used
       OR public.storage_usage.blob_count IS DISTINCT FROM EXCLUDED.blob_count
    RETURNING 1
  ),
  zero_users AS (
    -- blob_files に行が無いユーザーのカウンタは 0 に戻す（全削除後の過大計上）。
    UPDATE public.storage_usage s
    SET bytes_used = 0, blob_count = 0, updated_at = now()
    WHERE s.user_prefix <> '_global_'
      AND NOT EXISTS (SELECT 1 FROM actual a WHERE a.user_prefix = s.user_prefix)
      AND (s.bytes_used <> 0 OR s.blob_count <> 0)
    RETURNING 1
  ),
  upsert_global AS (
    INSERT INTO public.storage_usage (user_prefix, bytes_used, blob_count, updated_at)
    SELECT '_global_', t.bytes_used, t.blob_count, now()
    FROM totals t
    ON CONFLICT (user_prefix) DO UPDATE SET
      bytes_used = EXCLUDED.bytes_used,
      blob_count = EXCLUDED.blob_count,
      updated_at = now()
    WHERE public.storage_usage.bytes_used IS DISTINCT FROM EXCLUDED.bytes_used
       OR public.storage_usage.blob_count IS DISTINCT FROM EXCLUDED.blob_count
    RETURNING 1
  )
  SELECT
    d.user_prefix,
    d.previous_bytes,
    d.actual_bytes,
    d.previous_count,
    d.actual_count
  FROM diffs d
  ORDER BY d.user_prefix;
END;
$$;

COMMENT ON FUNCTION public.reconcile_storage_usage() IS
  'blob_files を正本として storage_usage を再計算し、修正した差分を返す。期限切れ予約も回収する。';

-- ---------------------------------------------------------------------------
-- 権限 (#1907)
--
-- grants.sql の ALTER DEFAULT PRIVILEGES は「migration を適用したロール」に
-- 依存するため、適用ロールが変わると新規オブジェクトへの GRANT が静かに
-- 効かなくなる（grants.sql 冒頭のコメント参照）。容量予約が permission denied
-- になると全アップロードが 500 になるため、既存の trade_auctions 等と同じく
-- この migration 内で明示的に GRANT / REVOKE する。
--
-- PostgREST/anon 経路は現行アーキテクチャには存在しないが、PUBLIC の既定
-- EXECUTE 権限を残すと将来の公開面追加時に意図せず到達可能になるため塞ぐ。
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE public.storage_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storage_reservations TO service_role;

REVOKE ALL ON FUNCTION public.reserve_storage_usage(varchar, bigint, bigint, bigint, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_storage_usage(varchar, bigint, bigint, bigint, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.commit_storage_reservation(uuid, text, varchar, varchar, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_storage_reservation(uuid, text, varchar, varchar, bigint)
  TO service_role;

REVOKE ALL ON FUNCTION public.release_storage_reservation(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_storage_reservation(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.reconcile_storage_usage()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_storage_usage()
  TO service_role;
