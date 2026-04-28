-- 未所持カードの視聴者向け表示設定を streamers テーブルに追加
-- Add unowned-card visibility settings (for the viewer-facing collection page) to streamers table.
--
-- Issue: #395
--
-- 既定値は両方 false。これは追加前の挙動（未所持カードは視聴者には全く見えない）と一致する。
-- The defaults preserve the pre-feature behavior, where unowned cards are invisible to viewers.
--
-- show_unowned_cards:
--   未所持カードを視聴者向けコレクションページに表示するか。
--   Whether to display unowned cards on the viewer-facing collection page at all.
--
-- show_unowned_card_details:
--   未所持カードを表示する場合に画像（および説明）まで露出するかどうか。
--   show_unowned_cards が false の場合は意味を持たない。
--   When unowned cards are shown, whether to reveal image (and description). No effect when
--   show_unowned_cards is false.

ALTER TABLE streamers
  ADD COLUMN IF NOT EXISTS show_unowned_cards BOOLEAN DEFAULT FALSE NOT NULL,
  ADD COLUMN IF NOT EXISTS show_unowned_card_details BOOLEAN DEFAULT FALSE NOT NULL;

COMMENT ON COLUMN streamers.show_unowned_cards IS
  'Whether unowned cards are visible on the viewer collection page (default: false, opt-in)';
COMMENT ON COLUMN streamers.show_unowned_card_details IS
  'When show_unowned_cards is true, whether to reveal card image/description (false = placeholder only)';
