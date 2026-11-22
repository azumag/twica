-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #2070 フォローアップ: 未所持カードの「項目別公開設定」（名前・画像・説明）。
--
-- 背景:
--   現行の公開可否は show_unowned_cards（未所持カードの枠を表示するか）と
--   show_unowned_card_details（未所持カードの詳細＝画像・説明まで見せるか）の
--   2段階だけで、名前・画像・説明を個別に選べない。本 migration はその3項目を
--   それぞれ独立した boolean 列として streamers に追加する。
--   既存の show_unowned_cards は「未所持カード自体を表示するか」のマスター
--   スイッチとして残す。
--   旧 show_unowned_card_details と trade_unowned_card_names_visible (#2070) は
--   旧アプリ・旧画面との互換のため今回は削除しない（削除は後続リリース）。
--   項目別設定への移行後も旧アプリが同じ見え方になるよう、新アプリは
--   名前・画像・説明の3列の AND（3列すべて true のときだけ true）を
--   旧 show_unowned_card_details へそのままミラー書込みする。AND を取るのは、
--   旧列 true が「3項目すべて公開」を意味していたため。部分公開の状態を
--   旧列 true として過大に公開しないよう、false も含めて AND の結果を書く。
--
-- 既定値:
--   3列とも false。新アプリで配信者が明示的に有効化するまで追加公開はしない。
--   旧アプリはこれらの列を SELECT も UPDATE もしないため、追加だけでは挙動が
--   変わらない。
--
-- バックフィル:
--   現行の「詳細公開」と同じ公開内容を維持するため、show_unowned_cards = true
--   かつ show_unowned_card_details = true の行だけ、3列を true にする。
--   これは「旧設定で詳細まで見えていた配信者」を新設定でも同じ見え方にする
--   一度きりの移行であり、NOT (3列すべて true) 条件により再実行時は 0 行更新の
--   no-op になる（冪等）。
--   show_unowned_cards = false かつ show_unowned_card_details = true の行は
--   対象外にする。この組み合わせでは旧画面も何も公開しない（マスタースイッチが
--   OFF で詳細フラグは無視される）ため、対象外にしても現行の公開内容は変わらない。
--   逆にこの行の3列を true にすると、将来 show_unowned_cards を ON にしたときに
--   配信者が選んでいない項目まで公開されうる。本番にはこの組み合わせの行が
--   0件であることも確認済みなので、推定で埋めずに対象外とする。
--
-- 適用順序:
--   列の追加と既定値に基づくバックフィルだけの加法的変更なので DB-first でよい
--   （docs/QA.md「migrationとアプリの適用順序」）。旧アプリは新列を SELECT も
--   UPDATE もしないため、DB が先行しても旧アプリは従来どおり動作する。
--   app-first ヘッダーは付けない。
--
-- 再実行安全性:
--   ADD COLUMN IF NOT EXISTS と冪等なバックフィルにより、同じファイルを再適用
--   しても失敗しない。NOT NULL DEFAULT false の定数既定値は PostgreSQL 11 以降
--   テーブル書き換えを伴わない。

ALTER TABLE public.streamers
  ADD COLUMN IF NOT EXISTS show_unowned_card_name boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_unowned_card_image boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_unowned_card_description boolean NOT NULL DEFAULT false;

-- 旧「詳細公開」と同じ見え方を維持するバックフィル。
-- NOT (...) により、すでに3列とも true の行は更新しない（再実行しても 0 行）。
UPDATE public.streamers
   SET show_unowned_card_name = true,
       show_unowned_card_image = true,
       show_unowned_card_description = true
 WHERE show_unowned_cards
   AND show_unowned_card_details
   AND NOT (show_unowned_card_name AND show_unowned_card_image AND show_unowned_card_description);

COMMENT ON COLUMN public.streamers.show_unowned_card_name IS
  '未所持カードの「名前」を公開する項目別設定。show_unowned_cards が true のときだけ有効で、false なら本列が true でも何も公開しない。HP/攻撃/防御/速度/スキルは設定対象外で、未所持カードには常に表示しない。レアリティと表示番号は本設定に関係なく常に公開する。旧 show_unowned_card_details との互換のため、新アプリは名前・画像・説明の3列の AND を旧列へミラー書込みする（3列すべて true のときだけ旧列も true。旧列は後続リリースまで残す）。';

COMMENT ON COLUMN public.streamers.show_unowned_card_image IS
  '未所持カードの「画像」を公開する項目別設定。show_unowned_cards が true のときだけ有効で、false なら本列が true でも何も公開しない。HP/攻撃/防御/速度/スキルは設定対象外で、未所持カードには常に表示しない。レアリティと表示番号は本設定に関係なく常に公開する。旧 show_unowned_card_details との互換のため、新アプリは名前・画像・説明の3列の AND を旧列へミラー書込みする（3列すべて true のときだけ旧列も true。旧列は後続リリースまで残す）。';

COMMENT ON COLUMN public.streamers.show_unowned_card_description IS
  '未所持カードの「説明」を公開する項目別設定。コレクション画面のみに反映され、トレード・オークションには表示しない。show_unowned_cards が true のときだけ有効で、false なら本列が true でも何も公開しない。HP/攻撃/防御/速度/スキルは設定対象外で、未所持カードには常に表示しない。レアリティと表示番号は本設定に関係なく常に公開する。旧 show_unowned_card_details との互換のため、新アプリは名前・画像・説明の3列の AND を旧列へミラー書込みする（3列すべて true のときだけ旧列も true。旧列は後続リリースまで残す）。';
