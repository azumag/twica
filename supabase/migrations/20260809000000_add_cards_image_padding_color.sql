-- migration-transaction: required
-- migration-providers: planetscale
--
-- #899: カード画像の余白（フィット）モード
-- トリミングではなく「画像全体を収める + 余白を焼き込む」モードで生成したカードの
-- 余白の色を記録する。NULL = 余白なし（従来のトリミング画像）。
-- 表示側は NULL なら object-cover、非 NULL なら object-contain + この色を背景にする。
-- 加法的（additive）な変更のため、既存カード・既存コードに影響はない。
ALTER TABLE cards ADD COLUMN IF NOT EXISTS image_padding_color text;
