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
