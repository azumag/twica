-- Allow unauthenticated OBS overlays to receive only gacha broadcasts on
-- private Realtime channels. This keeps Realtime working when Supabase
-- "Allow public access" is disabled, without opening arbitrary topics.

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Overlay can receive gacha broadcasts" ON realtime.messages;

CREATE POLICY "Overlay can receive gacha broadcasts"
ON realtime.messages
FOR SELECT
TO anon, authenticated
USING (
  (SELECT realtime.topic()) LIKE 'gacha:%'
);
