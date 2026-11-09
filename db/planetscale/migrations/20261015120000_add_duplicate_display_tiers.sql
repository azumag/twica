-- migration-transaction: required
-- migration-providers: planetscale
-- Issue #1782（問い合わせ #1728）: 被り（重複）カードの「所有枚数に応じた表示段階」。
--
-- 視聴者からの要望は「被りカードが一定枚数以上になると段階的にエフェクトが
-- 変わる／見た目が変わる」というもの。本 migration はその配信者設定のみを追加する。
--
--   duplicate_display_tiers: レアリティ名 → 厳密増加する所有枚数のしきい値配列。
--     例: {"legendary": [2, 5], "common": [3, 6, 10]}
--       legendary は 2枚で1段階・5枚で2段階、common は 3枚で1段階・6枚で2段階・
--       10枚で3段階。配列が無いレアリティは段階表示をしない。
--     NULL（既定）は「どのレアリティも段階表示しない」= 機能OFF。
--
-- 設計は pack_album_grid_sizes (#1765 フォローアップ) / pack_rarity_weights (#578)
-- と同じ「streamers 上の JSONB マップ + CHECK 制約の検証関数」。アプリ側の検証は
-- src/lib/duplicate-display-tiers.ts が同じ規則を実装する（表示側と保存側で
-- 規則がずれると「保存できたのに反映されない」が起きるため）。
--
-- rename_card_pack のカスケード追加は行わない: キーはレアリティ名であり
-- カードパック名ではないため、パック名の変更でキーが孤立することはない
-- （ rarity_weights もカスケード対象ではないのと同じ理由）。
--
-- Issue #1782 (request #1728): per-rarity owned-copy thresholds that drive the
-- duplicate-card display tiers. JSONB map on streamers, validated by a CHECK
-- constraint function, mirroring pack_album_grid_sizes / pack_rarity_weights.
-- No rename_card_pack cascade is needed because the keys are rarity names,
-- not pack names.

ALTER TABLE public.streamers
  ADD COLUMN IF NOT EXISTS duplicate_display_tiers JSONB DEFAULT NULL;

-- CHECK 制約経由で実行されるため、修飾名 + search_path 固定にして
-- 空 search_path 下でも実行時名前解決が失敗しないようにする
-- （pack_album_grid_sizes の 20261014120000 と同じ理由）。
CREATE OR REPLACE FUNCTION public.check_duplicate_display_tiers_values(tiers JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  entry_key TEXT;
  entry_value JSONB;
  entry_count INTEGER;
  threshold_count INTEGER;
  threshold_index INTEGER;
  previous_threshold INTEGER;
  current_threshold INTEGER;
  threshold_text TEXT;
BEGIN
  IF tiers IS NULL THEN
    RETURN TRUE;
  END IF;

  IF jsonb_typeof(tiers) <> 'object' THEN
    RETURN FALSE;
  END IF;

  -- 上限54件 = 既定レアリティ4種 + カスタムレアリティ上限50件。
  SELECT COUNT(*) INTO entry_count FROM jsonb_object_keys(tiers);
  IF entry_count > 54 THEN
    RETURN FALSE;
  END IF;

  FOR entry_key IN SELECT jsonb_object_keys(tiers) LOOP
    entry_value := tiers -> entry_key;

    -- キーはレアリティ名と同じ 1..40 文字（rarity_weights のキー規則と共通）。
    IF char_length(entry_key) < 1 OR char_length(entry_key) > 40 THEN
      RETURN FALSE;
    END IF;

    -- 制御文字 / Bidi override を含むレアリティ名は弾く（表示が壊れるため）。
    -- PostgreSQL のテキスト正規表現では UTF-8 バイト値 0x00 / 0x9F を文字クラスに
    -- 書けない（invalid byte sequence for encoding "UTF8" で構文エラーになる）
    -- ため、1文字ずつコードポイントを数値比較する。ascii() はマルチバイト文字では
    -- そのコードポイントを返す（chr(8234) → 8234）ため、Bidi override も
    -- 同一の比較で判定できる。
    IF EXISTS (
      SELECT 1
      FROM generate_series(1, char_length(entry_key)) AS char_offset
      WHERE ascii(substr(entry_key, char_offset, 1)) BETWEEN 0 AND 31
         OR ascii(substr(entry_key, char_offset, 1)) BETWEEN 127 AND 159
         OR ascii(substr(entry_key, char_offset, 1)) BETWEEN 8234 AND 8239
         OR ascii(substr(entry_key, char_offset, 1)) BETWEEN 8294 AND 8297
    ) THEN
      RETURN FALSE;
    END IF;

    -- 値は所有枚数のしきい値配列（1..3 要素）。
    IF jsonb_typeof(entry_value) <> 'array' THEN
      RETURN FALSE;
    END IF;

    threshold_count := jsonb_array_length(entry_value);
    IF threshold_count < 1 OR threshold_count > 3 THEN
      RETURN FALSE;
    END IF;

    previous_threshold := NULL;
    FOR threshold_index IN 0 .. threshold_count - 1 LOOP
      -- jsonb に jsonb→数値 のキャストは無いため、正規化されたテキスト表現を
      -- 経由して整数性と範囲を検証する（"2" は通し、"2.5" や "abc" は弾く）。
      -- pack_album_grid_sizes の N 検証と同じ手法。
      threshold_text := (entry_value -> threshold_index)::text;
      IF threshold_text !~ '^[0-9]+$' THEN
        RETURN FALSE;
      END IF;

      current_threshold := threshold_text::integer;
      -- 所有枚数 1 は「被り」ではないため 2 未満は弾く。
      IF current_threshold < 2 OR current_threshold > 9999 THEN
        RETURN FALSE;
      END IF;

      -- 厳密増加を必須にする。同値・逆順だと「何枚で何段階か」が一意に定まらず、
      -- 配信者が設定した段階設計が表示側で崩れる。
      IF previous_threshold IS NOT NULL AND current_threshold <= previous_threshold THEN
        RETURN FALSE;
      END IF;
      previous_threshold := current_threshold;
    END LOOP;
  END LOOP;

  RETURN TRUE;
END;
$$;

ALTER TABLE public.streamers
  DROP CONSTRAINT IF EXISTS streamers_duplicate_display_tiers_valid;

ALTER TABLE public.streamers
  ADD CONSTRAINT streamers_duplicate_display_tiers_valid
  CHECK (public.check_duplicate_display_tiers_values(duplicate_display_tiers));
