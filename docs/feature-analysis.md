# Feature Analysis — 460 Trip Planner

**Companion document to `CLAUDE.md`**. Where CLAUDE.md tells us *how* to build, this document explains *why* we chose what we chose. Revisit after every major milestone.

**Last updated:** 2026-04-19 (initial version)

---

## 1. Purpose and scope

Before committing to extending TREK as "460 Trip Planner", we surveyed the landscape of trip-planning software — commercial apps, open-source self-hosted alternatives, and the various niche tools people stitch together. This document captures that survey and distils it into a concrete list of features we will, won't, and might build on top of TREK.

It is not intended to be exhaustive market research. It covers the applications most frequently named when travellers describe how they plan and record trips, plus the self-hosted open-source alternatives that were candidates for our starting point.

The goals of the analysis were:

1. Identify the genuine feature gap between TREK and the best-of-breed alternatives.
2. Separate "delightful but peripheral" features from "load-bearing" ones.
3. Make scope decisions once, so that neither future-us nor Claude Code quietly expands the project.

---

## 2. Applications surveyed

We reviewed the following applications. Each one-liner below captures what the application is genuinely *best at*, not what it claims to do.

**Commercial / cloud-hosted:**

- **Wanderlog** — Visual, map-first trip planning with real-time collaborative editing. The closest commercial analogue to what we want.
- **TripIt** — Automated itinerary assembly from forwarded booking confirmations, plus industry-leading real-time flight alerts. Twenty years of airline data pipelines behind it.
- **Pilot (pilotplans.com)** — "Notion for trips." Free, collaborative, flexible block-based planning with chat.
- **Google Travel / Sheets / Docs** — The default path for people who don't adopt a dedicated tool. Auto-captures bookings from Gmail; no real itinerary builder.
- **Notion (as used for trips)** — Flexible database and notes, widely used despite being generic. Strong for records, weak for maps.
- **Splitwise** — Not a trip planner, but the de facto expense-splitting companion that every traveller ends up using.
- **WhenAvailable** — Lightweight date-availability polling. Solves the "when can everyone go?" problem before any trip exists.
- **TripStone** — AI itinerary generator. Representative of the emerging category of LLM-based planners.

**Open-source / self-hosted:**

- **TREK** — Our chosen starting point. Self-hosted, collaborative, PWA, real-time sync. Covered in detail in §4.
- **AdventureLog** — Self-hosted travel logger with stronger emphasis on recording completed trips than planning future ones.
- **trip** (itskovacs) — Minimalist self-hosted POI tracker. Less feature-rich than TREK.
- **OpenTripPlanner / GraphHopper** — Not in scope; these are transit routing engines, not itinerary planners.

---

## 3. Feature comparison matrix

The matrix below compares applications across the capabilities that emerged from the survey as meaningful differentiators. A filled cell means the feature is present; a dash means absent or materially weaker than the leaders.

| Capability | Wanderlog | TripIt | Pilot | Notion | AdventureLog | Splitwise | TREK |
|---|---|---|---|---|---|---|---|
| Day-by-day itinerary with drag-and-drop | Yes | Limited | Yes | DIY | Yes | — | Yes |
| Map-based planning with pins and routes | Yes | Limited | Yes | — | Yes | — | Yes |
| Place details (photos, hours, reviews) | Yes | Manual | Yes | DIY | Limited | — | Yes |
| Closed-on-this-day warnings | Yes | — | — | — | — | — | — |
| Inter-stop travel time | Yes | — | — | — | — | — | — |
| Real-time collaborative editing | Yes | — | Yes | Yes | Yes | — | Yes |
| Role-based permissions | Yes | — | Yes | Yes | Yes | — | Yes |
| Auto-import bookings from email | Pro only | Yes | Yes | — | — | — | — |
| Real-time flight alerts | — | Yes | — | — | — | — | — |
| Reservations and confirmation tracking | Yes | Yes | Yes | DIY | Limited | — | Yes |
| File/document attachments | Yes | Yes | Yes | Yes | Yes | — | Yes |
| Expense tracking (categories, per-person) | Yes | — | Basic | DIY | — | Yes | Yes |
| Settle-up / who-owes-whom | Yes | — | — | — | — | Yes | — |
| Packing lists with templates | Yes | — | Yes | DIY | — | — | Yes |
| Weather forecasts | Limited | — | — | — | — | — | Yes |
| Per-day journal / trip diary | — | — | Limited | Yes | Yes | — | — |
| Photo galleries per day or place | Limited | — | Limited | Yes | Yes | — | Limited |
| Visited-countries map and stats | — | Stats only | — | DIY | Yes | — | Yes |
| Public shareable trip guide | Yes | — | — | Yes | Limited | — | — |
| Pre-trip date availability poll | — | — | — | — | — | — | — |
| Shared segments across trips | — | — | — | — | — | — | — |
| Offline read access | Pro | Yes | Yes | Limited | Yes | Yes | Yes |
| Offline write (record while offline) | Limited | Limited | Limited | Limited | Limited | Yes | — |
| JSON / structured export | Limited | Limited | — | Yes | Limited | Limited | — |
| Self-hosted / data ownership | No | No | No | No | Yes | No | Yes |
| Native iOS and Android apps | Yes | Yes | Yes | Yes | PWA | Yes | PWA |
| Real-time sync across devices | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

The clearest patterns visible in this matrix:

- **No existing product handles shared segments across distinct trips.** Every collaborative tool treats a trip as a single shared document with multiple members. None distinguish "our trip" from "the shared bit of our trip."
- **Offline writes are universally weak.** Every app that markets "offline access" means read-only access. Splitwise is the sole exception, and it's a single-purpose tool.
- **Trip recording is separated from trip planning.** Wanderlog, Pilot, and TripIt are planners. AdventureLog and Notion are where people put the journal. No single product does both well.
- **JSON export is rare and usually partial.** Data portability is talked about more than it's delivered.

---

## 4. What TREK already provides

Before identifying gaps, it's essential to state what TREK gives us out of the box, so we don't accidentally rebuild it. The following is based on TREK v2.6.2 (March 2026):

**Planning:**
- Drag-and-drop day planner with cross-day moves.
- Interactive Leaflet map with photo markers, clustering, route visualisation, customisable tile sources.
- Place search via Google Places or OpenStreetMap (free, no key required).
- Day notes with timestamps, icons, drag-and-drop reordering.
- Route optimisation with export to Google Maps.
- Weather forecasts (16-day via Open-Meteo, historical climate averages as fallback).

**Travel management:**
- Reservations and bookings (flights, hotels, restaurants) with status, confirmation numbers, and file attachments.
- Budget tracking with category pie chart, per-person and per-day splitting, multi-currency support.
- Packing lists with categories, colour coding, progress tracking, smart suggestions.
- Document manager (up to 50 MB per attachment).
- PDF export of complete trip plans.

**Mobile and PWA:**
- Progressive Web App installable on iOS and Android from the browser.
- Service worker offline caching for map tiles, API GETs, uploads, and static assets (read-only).
- Fullscreen standalone mode, themed status bar, splash screen, touch-optimised layouts.

**Collaboration:**
- Real-time WebSocket sync — changes appear instantly across connected users.
- Multi-user trips with role-based access.
- SSO via OIDC (Google, Apple, Authentik, Keycloak).
- Two-factor authentication (TOTP).
- Collab addon: group chat, shared notes, polls, activity sign-ups.

**Customisation and admin:**
- Vacay addon: personal vacation day planner with 100+ countries' public holidays.
- Atlas addon: visited countries map with travel stats, streak tracking, continent breakdown.
- Dashboard widgets for currency conversion and timezone clocks.
- Admin panel with user management, API keys, auto-backups, GitHub release tracking.
- Dark mode, multilingual (English + German), configurable units.

This is a substantial feature set. The question for the analysis is not "what's missing from TREK" in isolation — it's "what's missing from TREK *relative to our specific needs*."

---

## 5. Feature gaps organised by theme

The gaps between TREK and the best-of-breed commercial alternatives fall into five clusters. Not every cluster is equally important for our use case.

### 5.1 Cluster 1 — Booking ingestion and flight intelligence

TripIt's moat is here. Forwarding a booking confirmation to a parse-aware inbox and having a reservation appear in the itinerary automatically is the single biggest time-saver the commercial tools offer. Wanderlog offers it in Pro. TripIt offers superior flight alerts — delay notifications often arrive before the airline's own alerts.

**How it matters to us:** Moderate. We book relatively few flights per year, so manual entry is tolerable. Flight alerts are useful but don't justify their build cost. A per-trip forwarding inbox would be genuinely time-saving but is not load-bearing.

**Privacy note:** Several user reviews from our research flagged that forwarding travel emails to a cloud service is a trust decision some people decline. Running ingestion on our own server is a privacy *win* over the commercial alternatives, not a loss — one of the underrated benefits of self-hosting.

### 5.2 Cluster 2 — Planning intelligence layered on the map

The features that make Wanderlog feel smart are the small map-adjacent touches. When you drag a temple onto a Tuesday, it warns you it's closed on Tuesdays. The itinerary shows estimated walk or drive time between today's stops. Adding a place by name pulls in photos, opening hours, and a description automatically.

TREK has the map and place search but lacks the contextual nudges.

**How it matters to us:** Low to moderate. These are polish features — delightful when you notice them, not load-bearing. We should pick them up only after the foundations are right.

### 5.3 Cluster 3 — Pre-trip coordination

Before a trip exists as a record, the group needs to agree on *when*. WhenAvailable solves this with account-free date polling. Doodle serves the same function. TREK has polls inside a trip but nothing at the pre-trip layer.

**How it matters to us:** High. Co-ordinating dates with another couple is the single most friction-heavy moment of group travel, and we'll do it several times a year. Worth building.

### 5.4 Cluster 4 — Recording and post-trip life

We explicitly set planning *and* recording as project goals. Wanderlog is weak at recording — it's a planner. AdventureLog is explicitly strong here, which is why it shows up in the comparison despite being less feature-complete than TREK overall. TREK's Atlas addon gives us the countries map and stats but not the per-day diary that reads back as a memoir years later.

**How it matters to us:** High. The feature we most want that no current TREK addon provides.

### 5.5 Cluster 5 — Expense reconciliation, not just tracking

TREK tracks categorised expenses and does per-person splitting. That's tracking. It doesn't answer "at the end of the trip, who owes whom how much?" — which is what you actually need at settlement time. Splitwise's dominance in travel groups is entirely because it handles this one computation well.

**How it matters to us:** Moderate. When travelling with another couple the question comes up. Cheap to build (the algorithm is textbook; no schema change required) so the effort-to-value ratio is good.

---

## 6. Prioritised recommendations

Based on the gap analysis and our specific use case (two couples, infrequent but substantial trips, planning + recording), here is the tiered recommendation.

### Tier 1 — Build these

These address the gaps that matter most and that no satisfactory alternative covers.

#### 1.1 Shared segments between trips

**Rationale:** The flagship feature. No existing product handles this. The specific scenario — our trip overlaps with another couple's trip for some days — is common enough for us that it alone justifies the fork.

**Scope:** Segments are a new concept between trip and day. A segment belongs to one or more trips; days in a segment render in every parent trip and edits propagate automatically.

**Build effort:** Moderate. Data model change, a permission check, and a UI affordance. Upstream-worthy if done cleanly.

#### 1.2 Per-day journal with photos

**Rationale:** Turns 460 Trip Planner into a recorder as well as a planner. Closes the biggest gap in our stated goals. AdventureLog demonstrates this is valuable to other travellers too.

**Scope:** Per-day markdown journal field plus a photo gallery with multi-image support. Rendered as a "memoir mode" timeline view.

**Build effort:** Moderate. Reuses existing uploads, file storage, and editor infrastructure.

#### 1.3 Offline-first writes

**Rationale:** TREK's PWA caches reads but mutations fail offline. We visit places with no connectivity. Without this, the app is unusable for the very moments we most want to record.

**Scope:** Local-first architecture with mutation queue, idempotent replay, last-write-wins conflict resolution, online/offline status indicator.

**Build effort:** High — this is the hardest engineering in the project. Not a feature; a cross-cutting constraint that all subsequent features must respect. Must be built before features 1.2, 1.4, and 1.5 because they all assume offline-capable writes.

#### 1.4 JSON export and import

**Rationale:** Data ownership was one of our original reasons for self-hosting. Archival, portability, and offline insurance all flow from a decent export format. A tiny standalone HTML viewer for the exported bundle is the ultimate insurance against any future disappearance of TREK or our server.

**Scope:** Versioned JSON schema, bundle (ZIP) format with attachments, dry-run import validation, standalone offline viewer.

**Build effort:** Moderate.

#### 1.5 Settle-up view on the budget

**Rationale:** Tiny build for obvious value. The algorithm is textbook; the work is almost entirely UI. Removes the need to maintain a parallel Splitwise record for shared-segment expenses.

**Scope:** Read-side computation over existing expense and split data. Per-trip and per-segment views. No schema change.

**Build effort:** Low.

#### 1.6 Pre-trip availability poll

**Rationale:** Solves the hardest moment of group travel — agreeing on dates — which currently requires a separate tool. Lives outside any trip so it's usable before a trip record exists.

**Scope:** New top-level feature. Shareable signed links, no-login voting, one-click promotion of winning dates to a trip.

**Build effort:** Low to moderate.

### Tier 2 — Build if and when the pain is felt

These add real value but don't justify proactive investment. Revisit after using the Tier 1 features on at least one real trip.

#### 2.1 Closed-on-this-day warnings and inter-stop travel time

Small, delightful, not load-bearing. Google Places returns opening hours already; travel time needs a routing API. Do only when we feel the lack on a specific trip.

#### 2.2 Public shareable trip guide

A read-only, nicely-formatted version of a completed trip that can be shared with friends heading to the same place. Piggybacks on the journal feature.

#### 2.3 Calendar integration via iCal feed

One-way export as a subscribable calendar feed is an 80/20 solution and is easy. Full two-way sync is much harder and not worth the complexity for our use.

#### 2.4 Activity sign-ups

TREK's Collab addon already has primitives for this. Polish to see how close it gets before building something new.

### Tier 3 — Explicitly out of scope

Listed explicitly so they don't creep back in. Revisit after two years of use if circumstances change.

#### 3.1 Real-time flight alerts

TripIt's moat exists because of twenty years of airline-data pipelines. Replicating it is weeks of work for a feature TripIt's free tier already provides well. Pragmatic solution: keep a TripIt account alongside 460 Trip Planner for flight-day alerts only. Skip.

#### 3.2 AI itinerary generation

The current wave of AI planners produces generic results and doesn't solve the real planning problem. Easy to bolt on later if circumstances change. Not foundational. Skip.

#### 3.3 Curated city guides / Explore tab

Wanderlog's guides work because millions of users create them. We won't generate network effects. Don't build a feature that depends on scale we don't have. Skip.

#### 3.4 Neighbourhood safety, visa data, carbon-footprint tracking

Data-heavy features needing paid data sources and regular updates. TripIt Pro exists for these. Skip.

#### 3.5 Receipt OCR and scanning

Phone camera plus manual entry is 30 seconds per expense. OCR is fiddly in practice and rarely saves the time it promises. Skip.

#### 3.6 Booking email import via forwarded confirmations

**Re-scoped from Tier 1 to Tier 3 during CLAUDE.md drafting.** Significant parser work for a feature that saves moderate time. Not worth the build until the foundations (shared segments, offline, journal, export) are in place. Revisit after two years of use.

---

## 7. Build sequencing rationale

The order in which we build the Tier 1 features matters. Our chosen sequence:

1. **Baseline use of TREK unmodified** (Milestone 0)
2. **Brand as 460 Trip Planner; add Capacitor native wrappers** (Milestone 1)
3. **Shared segments** (Milestone 2)
4. **Offline-first writes** (Milestone 3)
5. **Per-day journal with photos** (Milestone 4)
6. **JSON export and import** (Milestone 5)
7. **Settle-up view** (Milestone 6)
8. **Availability poll** (Milestone 7)

The logic:

- **Baseline first.** Using upstream unmodified for one real trip tells us which gaps are theoretical and which are real. Avoids building features for problems we only think we have.
- **Capacitor before features, not after.** Every feature needs to work on iOS, Android, and desktop. Wrapping into native apps first means every subsequent feature is designed mobile-native from the start. Retrofitting is more expensive.
- **Shared segments before offline.** Segments are a data-model change; offline writes depend on stable mutation endpoints. Getting the data model settled first makes the sync-queue work easier.
- **Offline before journal.** The journal is the feature we most want to use offline. No point building it as online-only.
- **Export after journal.** Exports must include journal content, so journal first.
- **Settle-up and availability poll last among Tier 1.** Both are lower-risk, lower-complexity features; they're good Milestone 6/7 choices because by then we'll know the codebase well and can ship them efficiently.

---

## 8. Review cadence and change control

This document is not frozen. Revisit and revise:

- **After Milestone 0** — confirm the Tier 1 list against real-trip experience. Delete anything that turned out not to matter. Promote anything that turned out to be critical.
- **After every milestone** — update the "What TREK already provides" section if upstream has shipped something new that closes a gap.
- **After every trip** — capture fresh gaps in a running "pain points" list in `docs/ours-trial-notes.md`. Let them accumulate before re-prioritising the roadmap; single-trip pain is often not representative.
- **Whenever a Tier 3 item starts feeling relevant** — write a short note here explaining *why* it has risen in priority, before promoting it. The friction is the point; it prevents scope creep.

Do not modify the Tier 3 list by simply moving items up. Every promotion to Tier 1 or 2 should be paired with either a Tier 3 demotion or an explicit acknowledgement that the project is growing in scope.

---

## 9. Summary

The feature gap between TREK and the commercial alternatives is narrower than first impressions suggest. Of the six Tier 1 features we intend to build, only one — shared segments — is not adequately covered by any existing product. The other five are either well-handled by free-tier commercial tools but with data-ownership trade-offs we want to avoid (journal, export), or straightforward additions that TREK simply hasn't gotten to yet (settle-up, availability poll, offline writes).

This is the right profile for a fork-and-extend project. If the gap were wider, we'd be building a different product from scratch. If it were narrower, we'd be better off using TREK as-is. The shared-segment feature alone justifies the work, and the rest is paced incremental improvement.
