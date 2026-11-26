-- migration-transaction: required
-- migration-providers: planetscale
-- app-first: #2111（旧アプリは新3列を更新しないため、先行していないと補正後の書込みで再び食い違いを作りうる）

-- Issue #2112: 未所持カードの項目別公開設定（名前・画像・説明）と、
-- 旧 show_unowned_card_details が食い違う行を整合させる補正 migration。
--
-- 背景:
--   #2110 で show_unowned_card_name / show_unowned_card_image /
--   show_unowned_card_description の新3列を追加し、#2111 の新アプリは
--   「3列すべて true のときだけ true」になる AND を旧
--   show_unowned_card_details へミラー書込みする。旧列は、旧アプリが
--   「未所持カードの名前・画像・説明をまとめて公開するか」の単一設定として
--   読み書きしていた互換列である。
--   移行期間中に旧アプリが旧列だけを書き換えると、新3列と旧列が食い違う。
--   食い違いは次の2系統だけを補正対象にする。
--
--   (a) show_unowned_card_details = false かつ新3列がすべて true
--       旧アプリで「詳細を公開」を OFF にした行。閲覧側は
--       resolveUnownedCardVisibility の規則 c により全非公開へ倒れるが、
--       新3列は true のまま残る。次に新アプリで1項目だけ保存したとき、
--       ミラー式が他2列の残存 true を拾って旧列を true に戻し、配信者が
--       切ったはずの公開を復活させうる。このため新3列をすべて false に揃える。
--
--   (b) show_unowned_card_details = true かつ新3列がすべて true ではない
--       旧列 true は旧アプリでは「3項目すべて公開」の意味だった。部分公開や
--       全非公開へ見える新3列を残すと、旧アプリと新アプリで公開範囲が食い違う。
--       旧列 true の意味を優先して新3列をすべて true に揃える。
--
--   部分公開（details=false で新3列の一部だけ true）は、新アプリのミラー書込みが
--   正当に作る状態なので対象外にする。details=false かつ新3列すべて false、
--   details=true かつ新3列すべて true の行も、すでに整合しているため触らない。
--   show_unowned_cards（未所持カードをそもそも表示するかのマスタースイッチ）は
--   この食い違い判定に入れない。マスターが false の行でも旧列と新3列の関係は
--   同じ規則で保存されており、後でマスターを ON にしたときの公開範囲を
--   配信者の設定どおりに保つためである。
--
-- 適用順序:
--   この migration 自体は旧アプリが読み書きできない状態を作らない additive な
--   データ補正だが、旧アプリがまだ稼働していると、補正後に旧列だけを書き換える
--   操作で同じ食い違いを再発させうる。そのため #2111（新3列と旧列のミラー
--   書込みを行うアプリ）が本番で実行済みであることを昇格時に確認する。
--   運用確認を機械的に見落とさないよう app-first ヘッダーを付ける。
--
-- 冪等性:
--   (a) の UPDATE は新3列をすべて false にするため、適用済みの行は
--   「すべて true」条件を満たさなくなる。(b) の UPDATE は新3列をすべて true に
--   するため、適用済みの行は NOT (すべて true) 条件を満たさなくなる。
--   どちらも再実行時は 0 行更新の no-op であり、既に整合している行の値も
--   書き換えない。補正対象列は新3列だけで、旧列やマスタースイッチは更新しない。

-- (a) 旧アプリで詳細公開を OFF にした行: 残存した新3列の true をすべて false に揃える。
UPDATE public.streamers
   SET show_unowned_card_name = false,
       show_unowned_card_image = false,
       show_unowned_card_description = false
 WHERE show_unowned_card_details = false
   AND show_unowned_card_name = true
   AND show_unowned_card_image = true
   AND show_unowned_card_description = true;

-- (b) 旧列 true を「3項目すべて公開」の意味で読む旧アプリと揃えるため、
-- details=true なのに新3列が不揃いの行は新3列をすべて true に揃える。
UPDATE public.streamers
   SET show_unowned_card_name = true,
       show_unowned_card_image = true,
       show_unowned_card_description = true
 WHERE show_unowned_card_details = true
   AND NOT (
     show_unowned_card_name = true
     AND show_unowned_card_image = true
     AND show_unowned_card_description = true
   );
