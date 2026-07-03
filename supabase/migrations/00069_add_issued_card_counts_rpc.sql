-- Issue #548: 発行上限付きカードの「発行済み枚数」集計をDB側のGROUP BY COUNTへ移す。
--
-- 旧実装(GachaService.executeGacha)は、発行上限(max_issuance_count)が設定された
-- カードIDの集合に対して user_cards を
--   SELECT card_id FROM user_cards WHERE card_id IN (...)
-- で「該当行を全件」フェッチし、アプリ側(JS)で card_id ごとに件数を数えていた。
-- 人気の限定カード(発行数が数千枚に達するもの)ほど、件数を知るためだけに
-- 数千行をDBからアプリへ転送することになり、発行数が増えるほど線形にI/O・
-- メモリ・レイテンシが悪化する。
--
-- get_issued_card_counts は同じ集計をDB側で GROUP BY / COUNT(*) して、
-- { "<card_id>": <count>, ... } 形式のJSONBオブジェクト1個だけを返す。
-- 返却サイズは「発行上限付きカードの種類数」(通常は配信者あたり一桁〜十数件)
-- に比例し、発行済み枚数そのものには一切依存しなくなる。
--
-- user_cards(card_id) には 00001_initial_schema.sql の idx_user_cards_card_id が
-- 既に存在する(00067/00068 で重複索引が整理済み)ため、新規インデックスは不要。
-- このインデックスにより WHERE card_id = ANY($1) は索引スキャンで解決できる。
--
-- Rewriting the issued-count aggregation from "fetch every matching row and
-- count client-side" to a single server-side GROUP BY COUNT query. Response
-- size now scales with the number of distinct limited cards (typically a
-- handful per streamer), not with how many copies have been issued.
--
-- 呼び出し側 (GachaService.getIssuedCounts) は、この関数が無停止デプロイの
-- 過渡期でまだ存在しない場合 (42883) に、旧来の select+in によるフェッチ→
-- JS集計へ自動フォールバックする。挙動(Map<card_id, count>の中身)は
-- 完全に同一のまま維持される。

DROP FUNCTION IF EXISTS get_issued_card_counts(UUID[]);

CREATE OR REPLACE FUNCTION get_issued_card_counts(
  p_card_ids UUID[]
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_object_agg(counts.card_id, counts.issued_count),
    '{}'::JSONB
  )
  FROM (
    SELECT card_id, COUNT(*)::BIGINT AS issued_count
    FROM user_cards
    WHERE card_id = ANY(p_card_ids)
    GROUP BY card_id
  ) counts;
$$;

COMMENT ON FUNCTION get_issued_card_counts(UUID[]) IS
  '指定した card_id 集合について、user_cards の発行済み枚数を { "<card_id>": <count> } のJSONBオブジェクトとしてDB側でGROUP BY集計して返す(Issue #548)。';

REVOKE ALL ON FUNCTION get_issued_card_counts(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_issued_card_counts(UUID[]) TO service_role;
