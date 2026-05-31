-- Add video-card media type support while preserving existing image cards.
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'image';

ALTER TABLE public.cards
  DROP CONSTRAINT IF EXISTS cards_media_type_check;

ALTER TABLE public.cards
  ADD CONSTRAINT cards_media_type_check
  CHECK (media_type IN ('image', 'video'));

CREATE INDEX IF NOT EXISTS idx_cards_streamer_media_type
  ON public.cards (streamer_id, media_type);

COMMENT ON COLUMN public.cards.media_type IS
  'Card media kind. image preserves existing image_url behavior; video stores a video URL in image_url.';
