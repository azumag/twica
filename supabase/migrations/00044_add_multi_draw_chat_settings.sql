-- N連ガチャ向けのチャット通知設定を streamers テーブルに追加
-- Add chat announcement settings dedicated to multi-draw gacha redemptions.

ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS chat_announcement_multi_template TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS chat_announcement_multi_show_cards BOOLEAN DEFAULT TRUE NOT NULL;

COMMENT ON COLUMN streamers.chat_announcement_multi_template IS
  'Custom message template for multi-draw chat announcements. Null uses the built-in multi-draw default.';

COMMENT ON COLUMN streamers.chat_announcement_multi_show_cards IS
  'Whether multi-draw chat announcements include the individual card-name list in {cards}.';
