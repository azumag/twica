-- migration-transaction: required
-- migration-providers: planetscale

-- Twitch は同じ authorization の refresh を単一スレッドに集約するよう求めており、
-- 1 refresh token から同時に有効化できる access token にも上限がある。Cloudflare
-- Workers の isolate 間では Promise を共有できず、Hyperdrive transaction の中で
-- 外部 OAuth API を待つこともできないため、各credential行に有効期限付きleaseを持つ。
--
-- lease取得はDB時刻を使う単一UPDATE、外部API呼び出しはtransaction外、token保存は
-- 旧refresh token + lease IDのfencing CASとする。期限切れleaderが遅れて完了しても、
-- 新しいleaderの結果を上書きできない。nullable列の追加だけなので旧コードと共存でき、
-- appコードより先に安全に配備できるexpand migrationである。
ALTER TABLE public.users
  ADD COLUMN twitch_refresh_lease_id uuid,
  ADD COLUMN twitch_refresh_lease_expires_at timestamptz;

ALTER TABLE public.twitch_bot_accounts
  ADD COLUMN twitch_refresh_lease_id uuid,
  ADD COLUMN twitch_refresh_lease_expires_at timestamptz;

COMMENT ON COLUMN public.users.twitch_refresh_lease_id IS
  'Fencing token for the request currently refreshing this Twitch credential.';
COMMENT ON COLUMN public.users.twitch_refresh_lease_expires_at IS
  'Database-clock deadline after which another request may recover the refresh lease.';
COMMENT ON COLUMN public.twitch_bot_accounts.twitch_refresh_lease_id IS
  'Fencing token for the request currently refreshing this Twitch BOT credential.';
COMMENT ON COLUMN public.twitch_bot_accounts.twitch_refresh_lease_expires_at IS
  'Database-clock deadline after which another request may recover the refresh lease.';
