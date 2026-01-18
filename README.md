# twica

Twitch配信者向けカード引きシステム (Gacha) アプリケーション。

## Tech Stack

| Component | Responsibility |
| :--- | :--- |
| **Next.js (App Router)** | UI framework, Server Components, API Routes |
| **Vercel** | Hosting, serverless functions, CI/CD |
| **Supabase (PostgreSQL)** | Persistent database for users, cards, gacha history |
| **Supabase Auth** | Twitch OAuth authentication |
| **Vercel Blob** | Card image storage |
| **Twitch API / EventSub** | Channel rewards integration |
| **Sentry** | Error tracking and automatic GitHub issue creation |

## Architecture

```mermaid
graph LR
    User[User/Streamer] --> NextJS[Next.js App/Vercel]
    NextJS --> SupabaseAuth[Supabase Auth]
    NextJS --> SupabaseDB[Supabase DB]
    NextJS --> VercelBlob[Vercel Blob]
    NextJS --> Twitch[Twitch API]
    NextJS --> Sentry[Sentry]
    Sentry --> GitHub[GitHub Issues]

    Subgraph[Data Flows]
    AuthFlow[Auth: JWT-based]
    UploadFlow[Upload: Client-side to Blob]
    GachaFlow[Gacha: EventSub triggers]
    BattleFlow[Battle: Card battles with abilities]
    ErrorTracking[Error: Sentry + GitHub Issues]
    End

    User --> AuthFlow
    User --> UploadFlow
    User --> GachaFlow
    User --> BattleFlow
    AuthFlow --> ErrorTracking
    GachaFlow --> ErrorTracking
    BattleFlow --> ErrorTracking
```

## Project Structure

```
src/
├── lib/
│   ├── constants.ts      # Application constants
│   ├── env-validation.ts # Environment variable validation
│   ├── gacha.ts          # Gacha algorithm implementation
│   ├── session.ts        # Session management with expiry validation
│   ├── supabase/         # Supabase client exports
│   │   ├── index.ts      # Unified client exports
│   │   └── admin.ts      # Admin client for server-side operations
│   └── twitch/
│       └── auth.ts       # Twitch OAuth utilities
├── app/
│   ├── api/auth/twitch/callback/route.ts  # OAuth callback handler
│   └── ...
```

## Environment Variables

| Variable | Required | Description |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `TWITCH_CLIENT_ID` | Yes | Twitch Application Client ID |
| `TWITCH_CLIENT_SECRET` | Yes | Twitch Application Client Secret |
| `NEXT_PUBLIC_TWITCH_CLIENT_ID` | Yes | Public Twitch Client ID |
| `NEXT_PUBLIC_APP_URL` | Yes | Application URL |
| `BLOB_READ_WRITE_TOKEN` | Yes | Vercel Blob storage token |
| `TWITCH_EVENTSUB_SECRET` | Yes | Twitch EventSub webhook secret |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Sentry Data Source Name |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | No | Sentry environment (production/development) |
| `SENTRY_AUTH_TOKEN` | No | Sentry authentication token |
| `SENTRY_ORG` | No | Sentry organization slug |
| `SENTRY_PROJECT` | No | Sentry project slug |
| `GACHA_COST` | No | Gacha cost in channel points (default: 100) |

## Testing

```bash
# Run unit tests
npm run test:unit

# Run tests with UI
npm run test:unit:ui

# Run all tests (unit + integration)
npm run test:all

# Run integration tests only
npm run test:integration
```

## Getting Started

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

## Supabase Setup

1. Create a new Supabase project
2. Run migrations in `supabase/migrations/`
3. Enable Twitch Authentication in Supabase Dashboard

## Deployment (Vercel)

1. Connect GitHub repository to Vercel
2. Configure environment variables in Vercel dashboard
3. Automatic CI/CD on push to main

### CI/CD

- GitHub Actions runs on push to main and pull requests
- Build uses dummy environment variables for CI (no external API calls)
- Vercel automatically deploys on merge to main

   ## Recent Changes

   - Issue #30 created: Code Quality - Complete API Error Message Standardization
          - Several files still use hardcoded error messages in Japanese or English
          - Should use ERROR_MESSAGES constants for consistency and maintainability
          - Design documented in ARCHITECTURE.md
   - Issue #29 implementation completed
          - N+1 query problem in Battle Get API fixed
          - Single query with JOIN now fetches all data (battle + user card + opponent card)
          - Database queries reduced from 2 to 1
          - `as any` type cast removed
          - CI passed successfully
          - Issue closed
    - Issue #28 implementation completed
         - N+1 query problem in Battle Stats API fixed
         - Single query with JOIN now fetches all data (battles + opponent cards)
         - Database queries reduced from N+1 to 1 (11 queries → 1 query for 10 battles)
         - `as any` type cast removed from battle history processing
         - CI passed successfully (59 tests)
         - Issue closed
   - Issue #27 implementation completed
         - All `.select('*')` replaced with explicit field selection
         - Data transfer reduced by 50%+ (59 tests passed)
         - No TypeScript/ESLint errors
         - No regressions in existing functionality
         - Issue closed
   - Issue #27 implementation completed
        - All `.select('*')` replaced with explicit field selection
        - Data transfer reduced by 50%+ (59 tests passed)
        - No TypeScript/ESLint errors
        - No regressions in existing functionality
        - Issue closed
   - Issue #26 implementation completed
        - Rate limiting now fails closed on error
        - Circuit breaker pattern implemented
        - Development environment uses in-memory fallback
        - Production environment blocks requests on error
        - Sentry error reporting enhanced
        - Issue closed
     - Issue #25 implementation completed
         - Unify API error messages to English
         - Add ERROR_MESSAGES constant in src/lib/constants.ts
         - Add API response type definitions in src/types/api.ts
         - Update all API routes to use ERROR_MESSAGES constants
         - Issue closed
     - Issue #23, #24 implementation completed
         - CPU Opponent Database Inconsistency fixed
         - Hardcoded Gacha Cost removed
         - Issues closed
   - Issue #20 Sentry integration implementation completed
      - Error tracking and automatic GitHub issue creation
      - Design documented in ARCHITECTURE.md
      - Issue closed
  - Issue #21 Test Suite Improvement implementation completed
      - Integrate upload API test with Vitest framework
      - Convert JavaScript test to TypeScript
      - Remove TODO blocking test execution
      - Design documented in ARCHITECTURE.md
      - Issue closed
- Twitch login error handling improvements completed (Issue #19)
    - Detailed error messages for authentication failures
    - Enhanced error logging and user feedback
    - Issue closed after successful implementation
- API error handling standardization completed (Issue #18)
    - Unified error handler across all API routes
    - Consistent error messages and proper error logging
    - Issue closed after successful implementation
- Type safety improvements completed (Issue #17)
    - Removed `any` type usage in cards API
    - Added proper TypeScript type definitions for Supabase queries
    - ESLint warnings resolved
- Middleware to Proxy migration completed (Issue #16)
    - Next.js 16 compatibility update
    - Successfully migrated `middleware.ts` to `proxy.ts`
    - Build warnings resolved
- Card battle system implementation completed (Issue #15)
    - 1v1 CPU battle with turn-based combat
    - Card stats: HP, ATK, DEF, SPD
    - Skill system with multiple types (attack, defense, heal, special)
    - Battle history and statistics tracking
    - Animated battle UI with real-time logs
    - Code quality improvements (ESLint fixes, TypeScript type safety)
- Rate limiting implementation completed (Issue #13)
- README mermaid diagram fixed (Issue #14)
- Terms of Service page implemented and issue #8 closed
- CI Supabase Realtime environment variables fixed (dummy values for build)
- Architecture documentation updated with CI fix design
- CI environment variable validation fixed (skip in CI environment)
- Card image upload size limit validation added (max 1MB, JPEG/PNG only)
- XSS vulnerability fix (callback route error parameter encoding)
- Session expiry validation added
- Improved error handling in Twitch auth
- Environment variable validation utility added
- Gacha algorithm extracted to dedicated module
- Supabase clients unified exports
- Constants centralized
