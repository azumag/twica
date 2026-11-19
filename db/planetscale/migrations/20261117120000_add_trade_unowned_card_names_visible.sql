-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #2070: トレード限定の配信者設定「未所持カードの名前だけをトレードで公開する」。
--
-- 意味（次回の可視性実装で使う）:
--   show_unowned_cards = true かつ show_unowned_card_details = false のとき、
--   トレードの掲示板・入札・応諾の画面に限り、未所持カードの名前とレアリティを
--   視聴者に見せ、取引を成立可能にする。画像と説明は見せない。
--   show_unowned_cards = false ならこの設定は無効。
--   コレクション画面の表示（show_unowned_card_details によるマスク）は変えない。
--
-- 既定 false は現行挙動（未所持カードはトレードで名前も見えない）を維持する。
-- この列は次回の可視性実装でアプリ側（src/lib/trade.ts / src/lib/trade-auction.ts）が
-- 参照し、既存の未所持カード表示設定とは独立して保存する。
--
-- 適用順序: 追加のみの加法的変更なので DB-first でよい（旧アプリはこの列を
-- SELECT しない。Drizzle の明示列 SELECT / UPDATE にだけ現れる）。
-- NOT NULL DEFAULT false の定数既定値は PostgreSQL 11 以降テーブル書き換えを
-- 伴わないため、既存行のバックフィルも不要。
-- 再実行しても安全なように IF NOT EXISTS を付ける。

ALTER TABLE public.streamers
  ADD COLUMN IF NOT EXISTS trade_unowned_card_names_visible boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.streamers.trade_unowned_card_names_visible IS
  '未所持カードの名前だけをトレードで公開する (#2070)。show_unowned_cards が true かつ show_unowned_card_details が false のとき、トレードの掲示板・入札・応諾の画面に限り、未所持カードの名前とレアリティを表示して取引を成立させる。画像と説明は表示しない。show_unowned_cards が false の場合は無効。コレクション画面の表示は従来どおり show_unowned_card_details が決める。';
