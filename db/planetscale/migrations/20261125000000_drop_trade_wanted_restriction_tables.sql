-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #2118: 旧「交換対象の制限」テーブルを削除する contract migration。
--
-- 対象(いずれも 20261123000000_trade_wanted_restrictions.sql が作成):
--   - public.trade_wanted_restriction_rules (出品カードごとのルール = 親)
--   - public.trade_wanted_restriction_items (許可カード = 子。rules への FK)
--
-- #2116 で「出品カードごとの制限」として追加したこの2テーブルは、#2117
-- (20261124000000_trade_wanted_allowlist_per_streamer.sql) で配信者ごとの
-- trade_wanted_allowlist_rules / _items に置き換えられ、どこからも参照されない。
-- 旧テーブルの行は本番・preview とも 0 件(適用前の読み取りで確認済み)。
--
-- 適用前後のどの版のアプリ・Worker も旧テーブルを参照しない根拠:
--   1. 本番で現在動いているのは #2117 以降のアプリ(Workers の実行バージョン
--      b9ee6cda)で、そのコードに旧テーブルへの参照は無い。#2116 と #2117 は同じ
--      リリース(#2119 の昇格)に含まれており、本番で旧テーブルを参照する #2116 の
--      コードが動いた期間は無い(旧テーブルを知らない #2116 以前の版も参照しない)。
--      preview も #2117 以降へ置き換え済みで、旧テーブルを参照する #2116 のビルドへ
--      戻す運用はしない。
--   2. 判定に関わる4つの関数シグネチャは 20261124000000 で新テーブル参照へ
--      差し替え済み(3引数版はエラーコードを読み替える互換ラッパー):
--        accept_trade_offer(text, uuid, uuid, smallint)
--        accept_trade_offer(text, uuid, uuid)
--        place_trade_auction_bid(text, uuid, uuid, smallint, uuid)
--        trade_auction_bid_unsettleable_reason(uuid)
--      DROP の直前に pg_get_functiondef で public の全ルーチンを走査し、旧テーブル名を
--      含むものが1つでもあればこの migration は中止する(下のガード)。
--   3. 旧テーブルは本番・preview とも 0 件(適用前の読み取りで確認済み)。行があれば
--      削除せず中止する(下のガード。読み取り後に増えていても、ロックして数え直す)。
--
-- 順序: docs/QA.md「migrationとアプリの適用順序」の app-first ヘッダーは付けない。
--   アプリ先行が必要なのは「旧アプリが新しい DB 状態を正しく扱えない」変更であり、
--   本 migration はどの版のアプリも読み書きしないテーブルを削除するだけ。
--   src/lib/db/schema.ts の旧 Drizzle 定義も同時に消すが、その定義への参照がアプリに
--   無いため実行時のクエリは変わらない。push 時の自動適用(DB 先行)で問題ない。
--   verify-db-schema.js は手動実行で CI ゲートではない。DB へ未適用の状態で新しい
--   schema.ts を使って実行した場合だけ、旧2テーブルが「DB にだけ存在」として差分に
--   出る(適用後は一致する)。
--
-- これは非加法的(DROP TABLE)な contract migration のため、scripts/db-migrate.js の
-- APPROVED_CONTRACT_MIGRATIONS に version・SHA-256 checksum・根拠を登録し、push の
-- 自動適用で他の migration と一緒に適用する(tests/unit/db-migrate-non-additive-scan.test.ts
-- の KNOWN_APPLIED_NON_ADDITIVE にも登録する)。checksum が一致しない限り適用されない。

SET LOCAL lock_timeout = '5s';

-- ============================================================
-- 0. 安全ガード(いずれも DROP より前)
-- ============================================================
-- 旧テーブルを参照するルーチンが残ったまま DROP すると、本番の応諾・入札が実行時に
-- 42P01 で壊れる。PL/pgSQL の関数本体はテーブルへの依存として登録されないため、
-- DROP TABLE 自体は成功してしまう(ビュー等は依存として記録されるので DROP が失敗する)。
-- 削除前に public の通常関数・プロシージャ(prokind IN ('f', 'p'))の定義を走査し、
-- 1つでも旧テーブル名を含めば中止する。比較は定数文字列との strpos なので、LIKE の
-- ワイルドカード(_)に影響されず、動的 SQL の組み立てもしない。
-- pg_get_functiondef は集約・ウィンドウ関数に使うと 42809 で失敗する。WHERE の
-- prokind 条件との評価順は保証されないため、CASE で通常関数・プロシージャの行だけに
-- 適用する(CASE は選ばれた分岐しか評価しない)。
DO $$
DECLARE
  v_routine regprocedure;
BEGIN
  FOR v_routine IN
    SELECT p.oid::regprocedure
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind IN ('f', 'p')
      AND strpos(
        CASE WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid) ELSE '' END,
        'trade_wanted_restriction_'
      ) > 0
  LOOP
    RAISE EXCEPTION
      '旧テーブルを参照するルーチンが残っています: % (Issue #2118 の DROP を中止)',
      v_routine;
  END LOOP;
END
$$;

-- 行が残っていれば削除せず中止する(0 件を前提に、想定外のデータを黙って消さない)。
-- 数える前に親(rules) → 子(items)の順で ACCESS EXCLUSIVE を取る(子が親を参照する FK の
-- 書き込み順に合わせ、親を先にロックしてデッドロックの窓を狭める)。count と DROP の間に
-- 書き込みが割り込む隙間を作らない。テーブルが既に無い環境では、そのテーブルのブロックを
-- 飛ばす(後続の DROP TABLE IF EXISTS と同じく、未作成環境でも失敗しない)。
DO $$
DECLARE
  v_rows bigint;
BEGIN
  IF to_regclass('public.trade_wanted_restriction_rules') IS NOT NULL THEN
    LOCK TABLE public.trade_wanted_restriction_rules IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO v_rows FROM public.trade_wanted_restriction_rules;
    IF v_rows > 0 THEN
      RAISE EXCEPTION
        'public.trade_wanted_restriction_rules に % 行残っています。削除せず中止します (Issue #2118)',
        v_rows;
    END IF;
  END IF;

  IF to_regclass('public.trade_wanted_restriction_items') IS NOT NULL THEN
    LOCK TABLE public.trade_wanted_restriction_items IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO v_rows FROM public.trade_wanted_restriction_items;
    IF v_rows > 0 THEN
      RAISE EXCEPTION
        'public.trade_wanted_restriction_items に % 行残っています。削除せず中止します (Issue #2118)',
        v_rows;
    END IF;
  END IF;
END
$$;

-- ============================================================
-- 1. DROP TABLE(子 → 親の順。子が親の offered_card_id を参照している)
-- ============================================================
DROP TABLE IF EXISTS public.trade_wanted_restriction_items;
DROP TABLE IF EXISTS public.trade_wanted_restriction_rules;
