# Issue 515 Realtime ID Payload Plan

## Goal

Reduce Supabase Realtime egress caused by multi-draw overlay broadcasts without regressing overlay display or chat announcements.

## Industry Guidance

- Supabase Broadcast counts one sent message plus one message for each subscribed client, so payload size and subscriber count both matter for egress and billing.
- Supabase Realtime is suitable for low-latency notifications, but large display payloads should be kept out of fanout channels when they can be fetched separately.
- Cloudflare Workers/Durable Objects are the long-term fit for persistent fanout, while short-lived HTTP detail fetches can be cached and retried more predictably.
- Cloudflare cache is edge-local and best used as a short TTL absorber for repeated identical detail fetches from multiple OBS sources/tabs.

## Implementation

1. Change the Realtime payload contract in `src/lib/realtime.ts` to support lightweight draw result notifications:
   - keep legacy `card` / `cards` support for compatibility
   - add `historyIds`, `cardIds`, `drawCount`, and optional `soundGroupId`
2. Plumb history IDs through the gacha service:
   - `execute_gacha_transaction` already returns `history_id`; preserve it in `GachaResult`
   - `executeGachaDraws()` must return ordered history IDs per draw, including duplicate card IDs
   - legacy fallback can omit history IDs and should keep full-card Realtime compatibility rather than pretending IDs are available
3. Change EventSub broadcasts in `src/app/api/twitch/eventsub/route.ts`:
   - broadcast only IDs/order metadata for multi-draw EventSub results
   - keep full card objects available inside the same process for chat notifications
   - preserve single-card API/manual gacha compatibility unless the route has history IDs available
4. Add/extend an overlay detail API:
   - support `ids=` batch lookup of `gacha_history.id` values on `/api/overlay/[streamerId]/events`
   - handle `ids=` in a separate branch that does not require `since`
   - keep the existing `since` polling behavior unchanged
   - return full card display data ordered like requested IDs
   - include conservative cache headers only when all requested IDs were found
   - return `Cache-Control: no-store` for partial/empty batches so a write/read race is not pinned in cache
5. Update overlay client:
   - if Realtime payload contains full cards, use existing path
   - if Realtime payload contains IDs only, fetch details once in batch, retry lightly for write/read race, then enqueue cards in order
   - preserve image, description, sound-once behavior, and polling fallback
6. Add focused tests:
   - EventSub broadcast no longer includes full `cards` objects for multi-draw
   - chat announcement still receives full cards and preserves `{cards}` / `{newCards}` behavior
   - overlay fetches detail payload for ID-only Realtime and displays all cards in order
   - overlay details API orders batch responses by requested IDs
   - overlay details API accepts `ids=` without `since`, filters by `streamerId`, and avoids caching partial batches

## Validation

- `npx vitest run tests/unit/eventsub-reward-mismatch.test.ts tests/unit/components/overlay-page.test.tsx`
- Add and run a focused route test for `/api/overlay/[streamerId]/events?ids=...`.
- `npm run lint`
- `npm run build` or `npm run workers:build` if the change reaches Next/Worker boundaries.

## Review Focus

- No visible overlay regression for `image_url`, `description`, display order, or sound-once behavior.
- No chat notification regression for multi-draw placeholders or new-card detection.
- No N+1 detail fetches per card.
- No new unauthenticated broad data exposure beyond the existing public overlay endpoint scoped by `streamerId`.
