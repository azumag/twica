-- channel_point_usage_stats is a server-side aggregate table used through
-- get_channel_point_usage_stats(). Keep direct table access closed.
ALTER TABLE channel_point_usage_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage channel point usage stats" ON channel_point_usage_stats;
CREATE POLICY "Service role can manage channel point usage stats"
ON channel_point_usage_stats
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
