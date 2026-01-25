-- ガチャ効果音設定をstreamersテーブルに追加
-- Add gacha sound effect settings to streamers table

-- gacha_sound_url: R2に保存された効果音ファイルのURL
-- gacha_sound_enabled: 効果音の有効/無効フラグ（デフォルトはtrue）

ALTER TABLE streamers
ADD COLUMN IF NOT EXISTS gacha_sound_url TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS gacha_sound_enabled BOOLEAN DEFAULT TRUE NOT NULL;

-- コメントを追加
COMMENT ON COLUMN streamers.gacha_sound_url IS 'URL of the gacha sound effect file stored in R2 (max 1MB, MP3/WAV/WebM/OGG)';
COMMENT ON COLUMN streamers.gacha_sound_enabled IS 'Whether to play sound effect on gacha (default: true)';
