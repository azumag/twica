# Cloudflare Workers Builds Deployment

TwiCa deploys the Next.js Worker through Cloudflare Workers Builds. GitHub
Actions remains responsible for Supabase migrations from the existing GitHub
Environment secrets, remains available as a fallback until the Cloudflare
connection is confirmed, and continues to deploy the auxiliary error-reporter
Worker after the cutover.

## Build Targets

Configure two Cloudflare Workers Builds connections.

### Production Worker

- Worker: `twica`
- Production branch: `main`
- Root directory: repository root
- Node.js version: `20` from `.node-version`
- Build command: `npm run workers:build`
- Deploy command: `npm run cloudflare:deploy:production`
- Non-production branch builds: disabled

Required build variables / secrets:

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_TWITCH_CLIENT_ID`
- `NEXT_PUBLIC_CF_IMAGES_ENABLED`

Do not duplicate `SUPABASE_DB_URL` in Cloudflare Build Variables. It is a
Postgres connection string for migrations, not the Supabase project URL, and is
read from the existing GitHub Environment secret by the migration job.

Runtime secrets such as `TWITCH_CLIENT_SECRET`, `TWITCH_EVENTSUB_SECRET`,
`SUPABASE_SECRET_KEY`, `CSRF_TOKEN_SALT`, `R2_PUBLIC_URL`, and
`R2_SOUND_PUBLIC_URL` stay in the Worker runtime variables/secrets, not only in
build variables.

### Preview Worker

- Worker: `twica-preview`
- Production branch: `preview`
- Root directory: repository root
- Node.js version: `20` from `.node-version`
- Build command: `npm run workers:build`
- Deploy command: `npm run cloudflare:deploy:preview`
- Non-production branch builds: optional
- Non-production branch deploy command: `npm run cloudflare:upload:preview`

Use preview values for the same build variables listed above. The preview deploy
script refuses to deploy unless `WORKERS_CI_BRANCH=preview`, so accidental
promotion from feature branches fails before touching the Worker.

If non-production branch builds are enabled, feature branches upload version
previews for `twica-preview` without running Supabase migrations. The checked-in
deploy wrapper also falls back to this upload path if the preview deploy command
is invoked on a feature branch, so branch builds cannot accidentally promote a
feature branch to the preview deployment.

## Cutover

1. Connect both Workers to the GitHub repository in Cloudflare.
2. Confirm a `preview` branch build deploys `twica-preview`.
3. Confirm a `main` branch build deploys `twica`.
4. In GitHub repository variables, set
   `CLOUDFLARE_WORKERS_BUILDS_ENABLED=true`.
5. Keep `.github/workflows/deploy-cloudflare.yml` enabled. With the variable set,
   it skips the legacy app deploy while still applying Supabase migrations from
   GitHub Environment secrets, and deploys `workers/error-reporter` for
   production.

## Safety Rules

- Production Supabase migrations run only from `main`.
- Preview Supabase migrations run only from `preview`.
- Feature branch preview uploads do not run migrations.
- `SUPABASE_DB_URL` stays in GitHub Environment secrets; Cloudflare Build
  Variables should only contain values required by the Next.js build.
- Do not enable the GitHub repository variable until Cloudflare Builds has
  successfully deployed both Workers once.

## Operational Runbook: Repairing Migration History

Background: issue #536 (5/31 incident postmortem). Cloudflare Workers Builds
deploys the app independently of GitHub Actions, so a Worker build can go live
before (or without) `supabase db push` having applied the matching migration.
`.github/workflows/ci.yml`'s migration-order check (#541,
`scripts/check-migration-order.js`) catches the common authoring mistake (a
new migration numbered lower than what's already merged), and
`.github/workflows/smoke-check.yml` (#536) alerts after the fact if a deploy
went out with schema the DB doesn't have yet. This section covers the manual
recovery tools for when the remote migration history has actually diverged
from local files or from the live schema. This is a break-glass procedure,
not a routine step.

### The two tools, and how they differ

- `supabase migration repair <version> --status applied|reverted` only
  mutates the remote bookkeeping table
  (`supabase_migrations.schema_migrations`). It does not run any SQL and does
  not change the actual schema.
  - `--status applied`: inserts a history row marking `<version>` as applied,
    without executing it. Use this when the migration's SQL was already run
    against the remote DB by some other means (applied manually, or applied
    by a previous `db push` that then failed to record it) and only the
    history bookkeeping is missing or wrong.
  - `--status reverted`: deletes the history row for `<version>`. Use this to
    remove a stale or incorrect entry, e.g. a migration file was deleted or
    renumbered (as happened repeatedly around #531/#562) and an old number is
    still recorded remotely.
- `supabase db push --include-all` force-applies migrations that are missing
  from the remote history table, bypassing the normal "not in history, so
  apply" bookkeeping check that also drives the "out of order" rejection.
  Unlike `migration repair`, this actually executes the migration's SQL
  against the remote DB.

### When to use which

- `db push` rejects a migration as "out of order", or as already having a
  lower number than the latest applied migration, but the listed migrations
  are confirmed genuinely new and unapplied remotely: run
  `supabase db push --include-all --dry-run` first to see exactly which files
  it would apply, verify each one against the live schema (Supabase dashboard
  SQL editor, or `select column_name from information_schema.columns where
  table_name = '...'`), then run it for real without `--dry-run`.
- A migration's schema change is confirmed already live remotely, but
  `supabase migration list --linked` (`npm run db:status`) shows it as
  missing or unrecorded: use `migration repair <version> --status applied`.
  Do not use `db push --include-all` for this case. Most of this repo's
  migrations use `IF NOT EXISTS` guards so a re-run is often harmless, but any
  migration that isn't idempotent (a bare `INSERT` without `ON CONFLICT`, a
  one-off data backfill, etc.) can fail loudly or silently duplicate/corrupt
  data if re-executed.
- The history table has an entry for a migration number that no longer
  corresponds to any file in `supabase/migrations/` (deleted or renumbered):
  `migration repair <old-version> --status reverted`.

### Commands

```bash
# Inspect remote history vs local files first (npm run db:status)
npx supabase migration list --linked

# Preview what db push --include-all would apply, before running for real
npx supabase db push --include-all --dry-run

# Force-apply migrations missing from remote history
npx supabase db push --include-all

# Mark a migration as applied in history WITHOUT executing its SQL
npx supabase migration repair <version> --status applied

# Remove a stale/incorrect history entry
npx supabase migration repair <version> --status reverted
```

### Do NOT

- Do not run `--include-all` just to make the error go away without first
  running `--dry-run` and manually checking, for each migration it lists,
  whether that schema change is already present on the live DB.
- Do not `migration repair --status applied` a migration whose schema change
  has not actually been applied remotely. This only edits the bookkeeping
  table, not the schema, so the app will behave as if the column, table, or
  function exists and hit the exact #525-527 failure mode (code referencing
  schema that was never applied).
- If it's unclear which specific migrations are safe to mark-applied versus
  safe to re-run, treat it as a P0/P1 incident: get a second engineer to
  verify against the live schema before mutating remote migration history,
  rather than guessing under pressure.
- The flag semantics above are summarized from the official CLI reference; if
  behavior is ever in doubt, defer to the docs rather than this summary:
  https://supabase.com/docs/reference/cli/supabase-migration-repair and
  https://supabase.com/docs/reference/cli/supabase-db-push
