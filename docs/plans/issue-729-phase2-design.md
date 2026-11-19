# Issue #729 Phase 2 Design Proposal

Trade establishment notification + fraud/RMT detection on the current Cloudflare / PlanetScale stack.

| Field | Value |
|---|---|
| Issue | twica#729 |
| Phase | 2 — 成立通知 (establishment notification) + 不正検知 (fraud / RMT detection) |
| Status | Design proposal only (no implementation) |
| Branch | `feat/729-phase2-design` (from `origin/preview`) |
| Worktree | `/home/hatch/work/wt/twica/trade-729-design` |
| Stack | Cloudflare Workers + Durable Objects + PlanetScale PostgreSQL (**no Supabase Realtime**) |
| Transport basis | `src/lib/realtime.ts` overlay facade (DO WebSocket primary + PlanetScale-backed HTTP polling fallback) |
| Author | Cline |
| Date | 2026-11-19 (UTC) |

---

## 1. Background and scope

### 1.1 Why phase 2 exists

Card trading (#715 / #722) ships an MVP in which a trade offer moves `open -> completed` through the accept RPC, but **no establishment notification is sent**. Participants confirm the result on the マイトレード (My Trades) page only. Per `tasks/plans/README.md` (the #715 section, owner decision 2026-10-08), 成立通知・不正検知 was deferred to issue #729 phase 2 and must not be implemented in the MVP.

This document is the phase 2 design proposal. It re-baselines the deferred design onto the **current** runtime (Cloudflare / PlanetScale, fixed since the Supabase / PostgREST driver was retired). It deliberately does **not** resurrect the old Supabase Realtime broadcast / private-channel migration draft.

### 1.2 In scope (this proposal)

1. **Notification transport redesign** for trade establishment on Cloudflare / PlanetScale, built on the existing overlay transport (`src/lib/realtime.ts` facade) rather than a new parallel system.
2. **Header badge + page fetch fallback**: an unread trade-notification badge delivered through the transport, with an authenticated HTTP poll fallback for disconnected/stale clients.
3. **Private delivery boundary**: a trade notification is delivered only to the trade's parties (offerer and accepter), scoped to the streamer context, never leaked to other viewers of the same overlay room.
4. **Fraud detection / RMT (real-money trading) consideration**: structured log analysis keyed on offerer / accepter / IP, anomaly patterns, a TOS clause basis, and cooldown / rate-limit judgment.

### 1.3 Out of scope (phase 3+ or explicitly excluded)

- Implementation of any code in `src/`, `workers/`, or `db/`. This document is a proposal only.
- Resurrection of Supabase Realtime, PostgREST, `service_role`, or `DB_DRIVER` dual-driver paths (retired; see `tasks/plans/README.md`).
- Cross-streamer trade notification routing (trades are intra-streamer in the current model; delivery remains scoped per streamer room).
- Badge UI component implementation (only the update path/count contract is designed).
- Automated enforcement actions (bans, rollbacks); detection produces signals/judgment, not automatic punishment.


---

## 2. Current state: overlay transport

The app already runs a production overlay transport that this proposal reuses:

- **`src/lib/realtime.ts`** — `subscribeToGachaResults(options)` facade. Controller with two paths:
  - **DO-primary**: Cloudflare Durable Object WebSocket (`do-primary` mode) for low-latency push to an overlay room.
  - **PlanetScale-backed HTTP polling**: runs while disconnected and for explicit reconnect / sequence-gap recovery. Rows are read from `gacha_history` via a cursor `(redeemedAt, historyId)` and converted to the same versioned envelope by `buildPollingRealtimeEvents()` in `src/lib/overlay-realtime/contract.ts`. A ten-minute reconciliation covers the gapless failure case where a committed row was never published to the room.
- **`src/lib/overlay-realtime/publisher.ts`** — `publishOverlayRealtimeEvent()` signs and fans out a committed draw to the DO room; a failed immediate publish is not an error because the polling cursor recovers the committed row on its next pass ("delivery is an optimization after the authoritative DB commit").
- **`workers/overlay-realtime/src/index.ts`** — the DO room: WebSocket accept, signed internal publish (`x-internal-streamer-id` / `x-internal-nonce` / `x-internal-timestamp` with replay nonce), per-room and per-client rate limits, kill-switch alarm, heartbeat, presence capability, and a 24h delivery dedupe ledger.
- **`src/lib/overlay-realtime/resolve-config.ts`** — resolves `mode: 'do-primary' | 'polling-only'` per streamer plus a `configVersion` fingerprint so clients notice rollouts without an extra request.
- **No Supabase** URL, key, SDK, or channel is used anywhere in the transport (`realtime.ts` header comment).

Key design invariant carried forward: **the database commit is authoritative; the transport is a best-effort delivery optimization that must never lose a committed event because polling recovery restores it.**

---

## 3. Goals

| # | Goal |
|---|---|
| G1 | Deliver a trade-establishment notification to the offerer and the accepter when an offer transitions `open -> completed`. |
| G2 | Delivery is **private**: only the two parties (within the streamer context) receive it; other viewers in the same overlay room must not see it. |
| G3 | Header badge shows the viewer's unread trade-notification count; an authenticated page-fetch endpoint updates the badge when the transport is disconnected or the client missed a push. |
| G4 | Reuse the existing overlay transport patterns (DO primary, PlanetScale polling fallback, signed publish, dedupe, cursor recovery) — no new transport, no Supabase. |
| G5 | Detection surface for fraud/RMT is built from structured logs keyed on offerer / accepter / IP, with anomaly patterns, a TOS basis, and explicit cooldown / rate-limit judgment. |
| G6 | Fail safe: a notification delivery failure must never roll back or otherwise affect the trade commit itself. |

---

## 4. Design: notification transport

### 4.1 Transport selection

**Primary:** extend the existing overlay Durable Object WebSocket rooms to carry a new event type `trade_established` alongside `gacha_result`.

**Fallback/recovery:** PlanetScale-backed HTTP polling endpoint, reusing the polling-presence / cursor pattern, serving `trade_established` events keyed by a trade cursor.

**Not chosen:** a separate WebSocket server, Supabase Realtime, or a new dedicated notification Worker. Rationale: the overlay facade already handles connect/reconnect/dedupe/cursor state; adding a parallel transport duplicates that state machine and contradicts the phase-2 re-baseline rule (build on `src/lib/realtime.ts`, not a new system).

### 4.2 Event model

New shared contract event (illustrative, additive to `src/lib/overlay-realtime/contract.ts`):

```ts
type TradeRealtimeEventV1 = {
  schemaVersion: 1
  type: 'trade_established'   // new, alongside 'gacha_result'
  eventId: string             // trade_offers.accepted_request_id (idempotency key)
  tradeId: string             // trade_offers.id
  batchId: string             // == eventId for dedupe alignment
  streamerId: string          // offered_streamer_id == wanted_streamer_id context
  occurredAt: string          // trade_offers.completed_at
  user: { twitchUsername: string }  // the recipient this envelope is addressed to
  offer: {
    offererUserId: string
    accepterUserId: string
    offeredCardId: string
    wantedCardId: string
    wantedQuantity: number
  }
  soundGroupId?: string
  deliveryKind: 'committed'   // demo events not used for trades
}
```

Each party receives their own envelope addressed to their `twitchUsername` so the client can match `options.userTwitchUsername` and so the badge count is per-recipient.

### 4.3 Publish path (accept RPC → transport)

1. The trade accept RPC (PlanetScale) commits `trade_offers.status = 'completed'`, sets `completed_at` and `accepted_request_id` inside one transaction. This is the **authoritative commit**.
2. Immediately after commit, the RPC calls the overlay publisher to fan out `trade_established` to the streamer's DO room (one envelope addressed to the offerer, one to the accepter). This is **best-effort optimization**, exactly like gacha: if publish fails, the trade is still completed and polling recovery restores the notification.
3. Publish is signed with the existing internal-request scheme (`x-internal-streamer-id`, `x-internal-nonce`, `x-internal-timestamp`, replay nonce) so the DO room accepts it only from the app Worker.
4. Because a trade involves exactly two recipients, the publisher emits **two envelopes** (one per party) to the same streamer room. Each envelope carries `user.twitchUsername` so connected sockets filter to their own address. The DO room's existing per-room publish rate limit applies; trades are low-volume relative to gacha draws, so no new bucket is required initially (see §7 for the trade-write soft bucket already covered by #728).

### 4.4 Client subscription (facade extension)

`subscribeToTradeResults(options)` mirrors `subscribeToGachaResults`:

- Connects to the streamer's overlay room in `do-primary` mode; otherwise polling-only.
- On socket message of type `trade_established`, validates the envelope, matches `user.twitchUsername` to the viewer, dedupes by `eventId` (24h window, same as the DO delivery ledger), and invokes the callback with the trade payload. The callback returns a delivery result; `false`/error leaves the event uncommitted in dedupe state and triggers the normal recovery path.
- On connect / reconnect / sequence gap, requests a recovery poll from the trade polling endpoint with the client's trade cursor, draining DB pages before live frames so DB order is preserved.
- Exposes `onStatusChange` / `onError` with the same `RealtimeError` taxonomy (`connection | subscription | broadcast | unknown`).

### 4.5 Delivery guarantees and recovery

| Guarantee | Mechanism |
|---|---|
| At-least-once per party | Publisher emits per-party envelopes; client dedupes by `eventId`; recovery poll re-sends unseen trades after the cursor. |
| No loss on publish failure | Trade commit is authoritative; polling cursor recovers the row on the next pass. |
| Order preservation | Recovery pages drain before live frames are delivered (`bufferLiveFrames` pattern). |
| Cursor stability | `trade_offers.completed_at` + `id` as the polling cursor, ordered `(completed_at, id)`. |
| Duplicate suppression | `accepted_request_id` idempotency key on accept; client-side `eventId` dedupe; DO 24h delivery dedupe ledger. |


---

## 5. Private delivery boundary

Trade notifications are **private user data**, not public overlay broadcast. The boundary is enforced at three layers:

### 5.1 Authorization layer (who may receive)

- A `trade_established` envelope is addressed to exactly one `twitchUsername` (offerer or accepter).
- The DO room only delivers an envelope to a socket whose authenticated identity matches `user.twitchUsername`. Authentication is the existing session / presence capability used by the overlay (the room already validates `presence` capability tokens for authorized sockets).
- A viewer who is not a party to the trade (offerer ≠ viewer AND accepter ≠ viewer) never receives the envelope, even if they are connected to the same streamer room.

### 5.2 Content layer (what is revealed)

- The envelope exposes only what each party already knows: the other party's username, the two card IDs, quantities, and the completed timestamp.
- It does **not** expose card names or details for cards the viewer does not own (the existing card-visibility rules from #715/#726/#727 apply: card names are secret to non-owners). If a card's details are hidden from a party, that party's envelope omits/redacts name/image and relies on the party's own collection data for rendering.
- No streamer other than the trade's streamer context receives the trade.

### 5.3 Transport layer (room isolation)

- Delivery happens inside the streamer's overlay DO room (`OVERLAY_ROOMS`, keyed by streamer). Rooms are already isolated per streamer; the per-envelope `user.twitchUsername` filter adds the intra-room private boundary.
- The polling fallback endpoint (`/api/overlay/[streamerId]/events` or a new trade-notification route) requires an authenticated session and returns only trades where the viewer is offerer or accepter, filtered in SQL (not after pagination, to avoid row-count leakage — consistent with the existing visibility rule discipline in `trade.ts`).

### 5.4 Boundary summary

```
                    streamer DO room (overlay)
 ┌─────────────────────────────────────────────┐
 │  socket A (offerer)  ←→  envelope addressed │
 │  socket B (accepter) ←→  to offerer only    │
 │  socket C (stranger)  ✗ no delivery         │
 └─────────────────────────────────────────────┘
  SQL fallback: WHERE (offerer_user_id = viewer
                        OR accepter_user_id = viewer)
                AND streamer_id = viewer's streamer context
```

---

## 6. Header badge + page fetch fallback

### 6.1 Badge semantics

- **Badge = per-viewer unread trade-notification count.** "Unread" = a `trade_established` addressed to the viewer whose `completed_at` is newer than the viewer's `tradeNotificationsLastReadAt` (a per-user setting, stored in PlanetScale; defaults to account creation / first trade view).
- Count is computed server-side on the badge endpoint and pushed incrementally through the transport when a new `trade_established` arrives for the viewer.

### 6.2 Update path

1. **Push (primary):** on `trade_established` receipt for the viewer, client increments the unread count locally and re-renders the header badge.
2. **Fetch fallback (reliable):** when the transport is disconnected, on page load/reconnect, or periodically (bounded interval), the page calls an authenticated endpoint `GET /api/notifications/trades/unread` (PlanetScale) which returns `{ unreadCount: number, cursor: string }`. The client reconciles the badge with this authoritative count.
3. **Read marking:** when the viewer opens マイトレード / the notifications list, the client marks notifications read and POSTs `tradeNotificationsLastReadAt`; the badge resets to 0 until the next unread establishment.

### 6.3 Fallback triggers

- Transport `mode === 'polling-only'` (config resolved per streamer).
- Socket `onStatusChange('DO_DELIVERY_TASK_ERROR')` or `onError(type: 'connection')`.
- Page visibility change / focus (bounded, not on every focus to avoid thundering herd).
- Periodic reconcile with a long interval (e.g. 5 min) only when a badge is displayed.

---

## 7. Rate-limit and cooldown context (from #728)

The existing rate-limit backend policy (`docs/rate-limit-backend-policy.md`, issue #728) classifies buckets:

| Bucket class | Backend | Fail mode | Relevance to #729 |
|---|---|---|---|
| `authLogin`, `activateCode` | Durable Object (strict) | fail-closed (503) | Not for trade notification |
| `tradeWrite` / `tradeRead` / `gacha*` / `eventsub*` etc. | KV + memory (soft) | fail-open | Trade offer create/accept already rate-limited here |

For #729:
- Trade offer creation and acceptance continue under the existing `tradeWrite` soft bucket (fail-open). No new strict bucket is introduced in this phase without a separate security review and owner approval (per #728: strict bucket changes require security review).
- Notification **delivery** (publish to DO) is protected by the room's existing per-room / per-client publish rate limits in the overlay Worker.
- The badge **fetch** endpoint goes through the app's global / route rate limiter (`/api/overlay/` routes already have their own limiter and are excluded from the global one to avoid KV RMW duplication during OBS polling).
- Fraud/RMT cooldowns (§8) are implemented as **judgment signals first**, not automatic hard blocks. If a cooldown is later enforced, it should be added as a soft bucket under the #728 fail-open contract so an outage does not freeze trading.


---

## 8. Fraud detection / RMT (real-money trading) consideration

### 8.1 Detection basis (TOS clause)

Detection operates under a Terms of Service clause that prohibits:
- Compensated / real-money trades of cards outside the platform's intended mechanics.
- Multi-account or coordinated accounts used to launder cards or inflate trade volume.
- Offer patterns structured to evade rate limits or visibility gates.

The TOS clause provides the policy basis for logging, analysis, and any future enforcement. Detection in phase 2 produces **signals and human-review queues**, not automatic sanctions.

### 8.2 Structured log analysis

Each trade lifecycle event (offer create, accept, cancel) emits a structured log record containing, at minimum:

| Field | Purpose |
|---|---|
| `trade_id` (`trade_offers.id`) | Event identity; idempotent across retries |
| `accepted_request_id` / `request_id` | Idempotency keys; links offer↔accept |
| `offerer_user_id` | Offerer identity |
| `accepter_user_id` | Accepter identity (populated at accept) |
| `offered_card_id`, `wanted_card_id` | Card definitions involved |
| `offered_streamer_id`, `wanted_streamer_id` | Streamer context (must match for a valid trade) |
| `completed_at` | Timing for velocity analysis |
| `client_ip` (sanitized, truncated) | Source IP for clustering |
| `session_id` / `device_id` (if available) | Session clustering |
| `event_type` | `offer_created` | `offer_accepted` | `offer_cancelled` |
| `anomaly_flags` | Computed flags (see §8.3) |

Logs are sanitized per `src/lib/log-sanitizer.ts` before storage/export: no raw access tokens, no full PII beyond what is needed for detection, IPs truncated/hash-bucketed where retention policy requires.

### 8.3 Anomaly patterns (detection heuristics)

A pattern is a signal, not a verdict. Suggested initial heuristics (to be tuned against MVP real data, per the #729 deferral note to "observe MVP real-data abuse trends"):

1. **Velocity:** offerer or accepter completes N trades within a short window (e.g., > K trades per hour/day) far above the per-user baseline.
2. **IP clustering:** many distinct user IDs offer/accept from the same client IP (or same IP subnet) in a window — multi-account / farm indicator.
3. **Account pairing:** the same offerer↔accepter pair repeats at high frequency, or one account accepts many offers from many newly-created accounts.
4. **New-account concentration:** a large share of a user's trades involve accounts created within a short window.
5. **Cross-streamer/card mismatch:** trades involving high-value cards between accounts with no prior collection relationship (risk score input only).
6. **Rate-limit proximity:** repeated `tradeWrite` soft-limit approaches or 429s from the same identifier cluster.

Heuristics are evaluated offline (batch/stream analysis over the structured logs) and optionally as lightweight real-time counters for the most expensive signals only.

### 8.4 Cooldown / rate-limit judgment

- **Judgment first:** an anomaly score flags a trade or account for review; a human or a separate policy process decides enforcement.
- **Cooldown (if later enforced):** applied as a soft, time-windowed cooldown on offer creation/acceptance for the flagged identifier (user/IP cluster), under the existing fail-open soft rate-limit contract (#728), never fail-closed.
- **No automatic ban/rollback:** detection does not revert trades or suspend accounts in phase 2.
- **Feedback loop:** review outcomes feed back into heuristic tuning; detection thresholds are not hardcoded in the trade accept path.


---

## 9. Data model notes (no new tables required for phase 2 proposal)

Phase 2 can be proposed without new tables by reusing existing columns:

- `trade_offers.status` (`open -> completed`), `completed_at`, `accepted_request_id` (idempotency) — the establishment signal.
- `trade_offers.offerer_user_id`, `accepter_user_id` — the two parties for private delivery.
- `trade_offers.offered_streamer_id`, `wanted_streamer_id` — streamer scope (room routing).
- A per-user `tradeNotificationsLastReadAt` setting — required for the unread badge; proposed as a new column / user-settings row (to be confirmed in implementation).

If implementation wants a dedicated notifications table for cleaner polling/cursor semantics, that is an implementation decision, not part of this proposal.

---

## 10. Alternatives considered

| Alternative | Why not selected |
|---|---|
| New dedicated notification Worker/WebSocket | Duplicates connect/reconnect/dedupe/cursor state already in `realtime.ts`; contradicts re-baseline on existing overlay transport. |
| Supabase Realtime private channels | Retired runtime; explicitly excluded by #729 deferral / `tasks/plans/README.md`. |
| Broadcasting `trade_established` to the whole streamer room | Violates private delivery boundary (G2); card-name visibility rules would be undermined. |
| Strict (fail-closed) rate limit for fraud cooldowns | #728 requires security review + owner approval for strict buckets; fail-open soft contract is the safe default. |
| Automatic ban/rollback on anomaly | Out of scope; detection is signal/judgment only in phase 2. |

---

## 11. Open questions / follow-ups (implementation phase)

1. Confirm `accepter_user_id` column presence and NOT NULL semantics on `trade_offers` for the accept path.
2. Confirm per-user settings table/column for `tradeNotificationsLastReadAt`, or propose a dedicated `trade_notifications` table.
3. Decide badge endpoint route (`/api/notifications/trades/unread` vs extending `/api/overlay/[streamerId]/events`).
4. Tune anomaly heuristics against MVP real-data abuse trends (per the deferral note).
5. Security review if any strict rate-limit bucket is later added for fraud cooldowns.
6. Determine retention and sanitization rules for structured trade logs (IP truncation, PII).

---

## 12. Non-goals (explicit)

- No Supabase Realtime / PostgREST / service_role path.
- No code changes in this phase.
- No UI/badge component implementation.
- No automatic enforcement (ban/rollback) from fraud detection.
- No cross-streamer notification routing.

---

## Appendix: source references

- `src/lib/realtime.ts` — overlay transport facade (`subscribeToGachaResults`, DO-primary + polling recovery).
- `src/lib/overlay-realtime/contract.ts` — `buildPollingRealtimeEvents`, envelope schema, `OVERLAY_REALTIME_TRANSPORT_DISABLED`.
- `src/lib/overlay-realtime/publisher.ts` — signed publish to DO room; polling recovers on failure.
- `src/lib/overlay-realtime/resolve-config.ts` — `do-primary` vs `polling-only`, `configVersion`.
- `workers/overlay-realtime/src/index.ts` — DO room: signed publish, rate limits, kill switch, heartbeat, dedupe ledger.
- `src/lib/trade.ts` — offer/accept, `tradeOffersTable`, `TradeOfferStatus`, `TradeCanAccept`.
- `src/lib/db/schema.ts` — `tradeOffers` (`offerer_user_id`, `accepter_user_id`, `status`, `completed_at`, `request_id`, `accepted_request_id`, streamer IDs).
- `docs/rate-limit-backend-policy.md` — #728 bucket classification (strict DO vs soft KV, fail-open).
- `tasks/plans/README.md` (#715 section) — #729 phase-2 deferral, post-MVP, do not resurrect Supabase Realtime, build on `src/lib/realtime.ts`.

