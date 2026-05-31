# ours-new-user-questions.md

A running log of questions, confusions, and "wait, where's...?" moments that a first-time user has when exposed to 460 Trip Planner. The premise: **the developer hitting their own app fresh is the cheapest possible proxy for new-user testing**, and what trips them up will trip up everyone else.

## How this document is used

Two purposes:

1. **Feeds the user guide.** Every entry here is something the guide needs to either explain explicitly or design out of existence. When writing `docs/ours-user-guide.md` (TBD), this file is the source of "what to cover."
2. **Surfaces UX-improvement candidates.** Some of these will be better fixed in the product than documented around — "the docs explain the workaround" is sometimes a sign the workaround should disappear.

For each entry: capture what the user *did*, what they *expected*, what actually *happened*, and what the real answer is. Distinguish:

- **Misunderstanding** — the feature works as designed; user needs guide-level explanation.
- **Hidden UX** — the feature exists but isn't discoverable from where the user looked.
- **Missing feature** — the user expected something that genuinely isn't there.
- **Bug** — the feature is broken.

**Deploy pipeline note (2026-05-31):** CI-gated deploy verified working end-to-end on commit `2a00770` — GitHub Actions runs server + client tests, only fires the Coolify deploy webhook on success, skips the deploy job on failure. Coolify's own "Watch repository for changes" polling is disabled, so the GitHub Actions path is the only deploy trigger.

## Editing rules

- Claude Code can add entries during product-use sessions when the user reports something. Mark new entries with the date and the user's exact wording where possible — paraphrasing loses nuance.
- Don't pre-resolve entries. Leave them as raw questions even if the answer is obvious. The point is to capture the *question*, not just the answer.
- When an entry has been addressed (guide updated, UX fixed, etc.), move it to the "Resolved" section at the bottom with a one-line outcome.

---

## Open questions

### 2026-05-30 — First-deploy session on `https://460planner.pwkconsulting.org`

After getting the app live on Hetzner/Coolify and logging in as admin for the first time, the user explored the planner UI on a test trip. Four observations:

---

#### Q1. "The splash screen should stay on for a bit longer, maybe twice as long."

- **Category:** UX preference (with mild discoverability angle — too short to read the branding).
- **What's there today:** `client/src/components/shared/SplashScreen.tsx` — 900 ms hold + 450 ms fade = ~1.35 s total, shown once per browser session.
- **Implication for guide:** None directly — splash is invisible to users.
- **Implication for product:** Bump `HOLD_MS` to ~1800 ms. Two-character change. Pending decision.

---

#### Q2. "The place/activity dialog allows you to sort by a category, but I do not see where you can assign a category to a place/activity you enter."

- **Category:** Hidden UX (resolved during the same session) **plus** a new feature request.
- **What actually happens:**
  - The **full edit modal** (`PlaceFormModal.tsx` line 331–368) has a category dropdown and a "+ create category" button.
  - The **quick-add flow** (e.g., right-click on map → "Add place here" / sidebar quick-add) does NOT show the category picker. You can only assign a category by editing the place after creation.
- **User's resolution / follow-up:**
  > "OK, I see where the category is now! Seems appropriate! Might want to add this to the quick-add flow, as on any decent sized trip there will be a lot of places/activities and being able to view by category would be very useful straight up."
- **Implication for guide:**
  - Explain that categories let you filter the place library.
  - Explain that on quick-add you'll need to edit-then-assign category as a follow-up (until the quick-add gains a category picker).
- **Implication for product:** Add category picker to the quick-add flow. Real friction on trips with many places.

---

#### Q3. "On any one day, you can drag to re-order place/activity, but it would be good to be able to actually assign some timing to places/activities."

- **Category:** Hidden UX — the feature exists, just isn't visible where expected.
- **What actually happens:** The `day_assignments` table has `place_time` and `end_time` columns (server/src/db/schema.ts lines 126–127). The `<TimeSection>` in `PlaceFormModal.tsx` (line 370–378) is gated:
  ```
  {/* Time — only shown when editing, not when creating */}
  {place && (
    <TimeSection ... />
  )}
  ```
  So:
  1. Create the place → no time fields visible.
  2. Save and assign to a day.
  3. Re-open the place via edit → time fields now appear.
- **Implication for guide:** Document the "create first, then edit to set times" workflow until the UX is fixed.
- **Implication for product:** Drop the `{place && ...}` gate so time fields appear on creation too. Low-risk UI tweak.

---

#### Q4. "What is the difference between planned and unplanned places/activities?"

- **Category:** Misunderstanding — terminology that's intuitive once explained, not before.
- **What it actually means:**
  - **Planned** = a place that's been assigned to a specific day in the trip.
  - **Unplanned** = a place in the trip's library that hasn't been slotted into any day yet (your "shortlist" / "wishlist").
  - Every place starts as Unplanned when you add it; it becomes Planned once you drag it onto a day or assign it via the day-detail panel.
- **Implication for guide:** This is **fundamental** to the planner mental model and **must be one of the first things the user guide explains**. Likely an early-section diagram showing:
  - Place library (whole-trip)
  - Days (per-day buckets)
  - The drag-onto-day action that converts a place from Unplanned → Planned.
- **Implication for product:** Wording is fine — once explained, it's clear. No code change needed.

---

#### Q5. "Would be useful to have a quick access button to upload photos on the day header strip, rather than having to go into the day to then do it. Uploading photos is probably one of the most common things that will be done during a trip!"

- **Category:** Missing feature (workflow-friction).
- **What's there today:**
  - Per-day photo upload lives **inside** the day-detail panel — you have to click the day to expand it, then scroll to the photo grid, then click Upload.
  - The day-plan sidebar header has a trip-wide **batch-import** Images icon (per `docs/ours-pending-manual-tests.md` M6 follow-up `cc73b42`) but that's project-scoped, not per-day quick-add.
- **Why it matters during a trip (the user's "one of the most common things" claim is correct):**
  - Planning is pre-trip and bursty — happens in long sessions on a laptop.
  - Recording is in-trip and high-frequency — "took a photo, want to attach it to today" should be one or two taps, not a drill-down.
  - On mobile the day-detail panel is even more friction (longer scroll, smaller targets).
- **Possible designs (for product decision later):**
  - Small camera icon on each day header in the sidebar → opens native camera or photo picker for that day directly.
  - Long-press a day header → quick action menu including "Add photo".
  - Sticky "+ Photo to today" floating action button when the trip is in active travel-date range.
- **Implication for guide:** Until this lands, document the current path (day → detail panel → photo grid → upload). Frame photo capture as a first-class workflow with its own section, not buried inside "day editing."
- **Implication for product:** High-leverage UX improvement. Worth promoting onto the near-term backlog — the M6 photo work shipped the *capability* but the *in-trip ergonomics* lag. Captured as a candidate for the next round of polish.

---

#### Q6. "I uploaded a random photo into a day on a new trip I have created for testing. It did not flag that the photo was not actually taken on the day that is being assigned to it. I think there needs to be some sort of warning before proceeding on this. But the warning would be intrusive if, for some reason the user wants to place photos against a specific day, so perhaps there needs to be a configuration setting for 'Check photo timestamp' or similar that the user can turn on and off, default to on"

- **Category:** Missing feature (data-integrity safeguard) **plus** suggested-setting design.
- **What's there today:**
  - **Batch import flow** (sidebar header → Images icon) already does the smart thing: parses EXIF `taken_at`, auto-assigns each photo to the matching day, and flags rows the user can override per-photo (per `docs/ours-pending-manual-tests.md` M6 follow-up `cc73b42`).
  - **Per-day upload flow** (day-detail panel → photo grid → Upload button) does NOT cross-check — it just attaches the photo to whichever day the user is currently viewing, EXIF date or not. The EXIF data IS extracted and stored on `day_photos.taken_at`, but it's not used as a validation gate.
  - So the discrepancy is: batch import = smart, single-photo upload = trust the user.
- **Why the per-day upload silently mismatching is a real risk:**
  - Common mistake: "I'm looking at Day 4, I upload a photo, it goes to Day 4" — even if the photo's EXIF says it was taken on Day 6. Later when you're in memoir mode reviewing the trip the misplaced photo silently distorts the narrative.
  - The user themselves discovered this on the very first upload of their first test trip. That's a strong signal.
- **The user's design (smart trade-off):** Add a per-user setting **"Check photo timestamp"** (or similar wording — `Warn when photo date doesn't match day`), default **on**. When on, single-photo uploads that don't match the day's date show a warning dialog with options:
  - "Add anyway" (user knows what they're doing)
  - "Assign to actual date" (auto-route to the correct day if the date falls within the trip)
  - "Cancel"
- **Why default-on is correct:** the error-prone case is the default. Users who deliberately misalign photos (uncommon) opt in to the looser mode; users who don't (the majority) get the safety net for free.
- **Implication for guide:** Note this safeguard and how to disable it. Frame photo assignment as "EXIF date is the source of truth, override only when intentional."
- **Implication for product:**
  - Add the setting under Settings → ?? (probably the photo/journal area, or a new "Photo handling" section).
  - Surface the warning dialog from the per-day upload path.
  - Apply the same check to drag-drop uploads (any single-photo path).
  - Out of scope here: bulk-fixing previously-misassigned photos (separate "Recheck photos in this trip" admin action — worth flagging but not part of this feature).

---

#### Q7. "The various dialogs are not floating/draggable. Should they be, in particular when viewing on phones etc with limited screen size?"

- **Category:** UX-pattern question — captured as the underlying observation, not the proposed solution.
- **The underlying observation (the real signal):** On a phone-sized viewport, the app's modal dialogs **consume too much of the screen** and **obscure context the user needs to reference**. The user's intuition reached for "make them draggable" as a fix, but the better framing is "modals are too disruptive on small screens — what's the right pattern?"
- **Why draggable was considered and rejected:**
  - No useful destination — a small screen has nowhere helpful to drag *to*.
  - Touch imprecision means accidental drags are common.
  - Fights platform idiom — iOS and Android both standardised on bottom-sheets / full-screen sheets for exactly this case.
  - Accessibility cost — draggable surfaces are harder for screen readers, voice control, and switch users.
  - Desktop *can* benefit from draggable in pro-tooling contexts, but a personal trip planner doesn't have the kind of multi-panel reference workflow where it pays off.
- **The patterns to consider instead (decision deferred — for product-design pass later):**
  1. **Bottom sheets** — slide up from below, partial or full expansion, swipe-down to dismiss. Native mobile idiom.
  2. **Responsive full-screen on mobile, modal on desktop** — same component, different render at small breakpoint (~640 px). The day-detail panel may already do this; worth auditing the place-edit modal, batch-import dialog, reservation form, etc.
  3. **Inline editing** for high-frequency-low-complexity actions — tap-to-edit-in-place beats opening a modal every time.
  4. **Side panels** for context-preserving editing — slide in from edge, keep the rest of the UI visible (the day-detail panel works this way today).
- **What needs auditing:** every modal in the app, classified by:
  - Mobile pattern today (full-screen / centered overlay / side panel / inline)
  - Frequency of use (high → push toward inline or sheet; low → modal is fine)
  - Need for context behind (high → side panel or partial sheet; low → full screen is fine)
- **Implication for guide:** None directly — the guide describes behaviour, not the dialog framing. But the guide WILL eventually need to handle mobile-vs-desktop call-outs, so this observation reinforces the case for **separate "On your phone" sections rather than mixing tap and click instructions inline**.
- **Implication for product:** Modal-pattern audit and incremental upgrade to the right pattern per dialog. **Do not** add draggability. Higher priority for the dialogs the user touches most often during a trip (photo upload, journal entry, day editing) — lower priority for pre-trip-only dialogs (settings, reservation forms, etc.).

---

#### Q8. "When I try to install the app it gives a message 'Unsafe app blocked' 'This app was built for an older version of Android and doesn't include the latest privacy protections' but gives me option to install anyway. We really don't need this coming up!"

- **Category:** Platform issue, not a 460TP bug. Cannot be fixed from our side.
- **What's happening:**
  - When Chrome on Android installs a PWA, it doesn't add a bookmark-shortcut like iOS does. It requests a WebAPK (a real native Android APK wrapping the PWA) from Google's WebAPK Minting Service, then asks Android to install it.
  - Android 14+ checks `targetSdkVersion` on every APK install. If too old, it shows this "Unsafe app blocked / built for an older version" warning.
  - Google's WebAPK Minting Service has been generating WebAPKs with an outdated `targetSdkVersion` — every PWA installed via Chrome on modern Samsung / Pixel hits this warning.
- **Why we can't fix it from our manifest:**
  - The 460TP manifest is clean and modern (verified `server/public/manifest.webmanifest`).
  - The WebAPK build is done by Google, downstream of us — we don't set its `targetSdkVersion`.
  - No PWA manifest knob bypasses this.
- **What to tell users (this is universal Android-PWA advice, not 460TP-specific):**
  - **"Install anyway" is safe.** The WebAPK is signed by Google's WebAPK Minting Service, not by an unknown developer. Android is warning about SDK version, not about malicious code.
  - **Alternative path:** use Samsung Internet instead of Chrome — it bypasses the WebAPK route, but the install is slightly less polished (may run within Samsung Internet rather than as a true standalone app).
  - **Lighter alternative:** Chrome's three-dot menu → "Add to home screen" sometimes uses a bookmark-shortcut path rather than minting a WebAPK.
- **Implication for guide:** Must include a "What's this 'Unsafe app blocked' warning?" callout in the Android install section. Without explanation, non-technical users will (rightly) be wary and abandon the install. Explain it's a Google-side issue, the install is safe, and provide the three options.
- **Implication for product:** Nothing actionable on our side. **Monitor:** Google has acknowledged the WebAPK Minting Service `targetSdkVersion` issue in their bug tracker — when they fix it, this complaint disappears for free. No code change needed at our end.

---

#### Q9. Home-screen icon installed wrong — two compounding bugs, recovery procedure non-obvious

The full sequence the user went through trying to install the PWA on a Samsung Galaxy via Chrome on 2026-05-30:

1. **First install attempt:** Got "Unsafe app blocked" warning (covered in Q8 — universal Android-WebAPK issue). Tapped "Install anyway" — installed, but the home-screen icon was **blank grey** with no visible content at all.
2. **First diagnostic + fix:** The manifest declared the same `icon-512x512.png` as both regular (`purpose: any`) and maskable (`purpose: maskable`). The icon design has the "460" text near the bottom edge and "TRIP PLANNER" subtitle at the very bottom — both outside the inner 80% safe zone that Android adaptive icons require. Android couldn't form a valid adaptive icon and fell back to grey. Fix: separate `icon-maskable.svg` with content properly centered in the safe zone, background filling to the edges; new generator step produces `icon-512x512-maskable.png`; manifest points the maskable entry at the new file. Shipped in commit `2d36f28`.
3. **Recovery for the user's already-installed bad WebAPK:** Uninstall app → clear Chrome's site data for the domain → reload page → reinstall. **This procedure is non-obvious and several steps long.** The user couldn't find "Site settings" via the padlock menu on their Samsung Chrome variant; needed alternative paths (three-dot menu → Settings → Site settings → All sites → find domain → Clear & reset).
4. **Compounding browser issue:** The user switched to Samsung Internet for the reinstall — Samsung Internet failed with a generic "could not install web app" message. Switched back to Chrome.
5. **Second install attempt:** Icon now had the orange gradient background and sun visible, but the "460" text was still missing — invisible.
6. **Second diagnostic + fix:** The Docker build runs in `node:22-alpine` which ships with NO fonts installed. The previous deploy log had a `Fontconfig error: Cannot load default config file` warning that we'd missed. When `sharp` renders the SVG → PNG during the prebuild, `<text>` elements silently render as blank because no font can be resolved. Fix: Dockerfile client-builder stage now installs `fontconfig` + `ttf-liberation` and runs `fc-cache -f`; SVGs updated to prefer Impact (for browsers that have it, e.g. desktop splash) and fall back to Liberation Sans Narrow (available in the build container). Shipped in commit `e5996d0`.
7. **Third install attempt:** Worked correctly — icon shows gradient + sun + visible "460" text.

- **Categories at play:**
  - **Bug** (×2): maskable-icon misshape, missing fonts in build container.
  - **Hidden UX** (recovery): "clear site data + reinstall" is the only way to update an installed PWA's icon — but the path through Chrome's settings is buried.
  - **Platform issue** (Samsung Internet): unreliable PWA installer, no useful error message when it fails.
- **What we can do nothing about:** Samsung Internet's flakiness, Android's "Unsafe app blocked" warning on WebAPKs (Q8), the fact that you can't refresh an installed WebAPK's icon without reinstalling.
- **Implication for guide:** Dedicated **Android install troubleshooting** section covering:
  - Expected appearance of the home-screen icon (showing a screenshot of what "correct" looks like, so users can spot wrong).
  - Recovery procedure for a bad icon: uninstall → clear Chrome site data (via three-dot menu → Settings → Site settings → All sites → find domain → Clear & reset) → reload → reinstall.
  - **Use Chrome, not Samsung Internet** for the install. Samsung Internet may fail with no useful diagnosis.
  - The "Install anyway" warning is safe (also covered in Q8 — likely cross-reference).
- **Implication for product:**
  - The icon fix is now shipped. If we ever redesign the icon, both the regular AND maskable variants need re-doing, with the maskable strictly respecting the safe zone.
  - If we want pixel-perfect Impact in the production icon (Liberation Sans Narrow is a near-but-not-exact match), **convert the "460" text to SVG paths** so the rendered PNG doesn't depend on any font being installed. Flagged as a polish follow-up — not blocking.
  - Consider adding the Fontconfig warning to a build-error checklist so future build-environment regressions get caught earlier.

---

#### Q10. "We should probably ensure that more than two people can be part of the 'partner' group ie kids etc"

- **Category:** Product-spec evolution. M3 partner-pairing was deliberately scoped to 1-to-1 (CLAUDE.md §6 explicitly deferred "Multi-partner or family-unit (3+ accounts) support"). Real-trip use is now pushing against that limit.
- **Important design ambiguity in "kids etc":** there are two distinct concepts under this umbrella and they probably need different solutions, not one combined one:

  **A. Family group — multiple ACCOUNTS that auto-pair together.**
  - Parent + adult child + adult child + adult child — each with their own login, edits trips, has their own settings, can install the PWA on their own phone.
  - Semantically a generalisation of M3: instead of `partner_user_id` being a single FK, it becomes membership in a `household` table that any number of accounts can join.
  - Trip auto-add behaviour scales naturally: new trip → all household members get added.
  - Pairing is still bidirectional / mutual; needs an N-party accept flow rather than 2-party.

  **B. Household members — non-account names tagged on the user.**
  - Minor children, infants, pets, an elderly relative who doesn't use phones — people who appear on the trip but don't *use* the app.
  - They show up in passenger-name lists (flights for the family of 4), photo captions ("kids at the beach"), and expense calculations (party of 5 split bills).
  - Schema-wise this is a `user_household_members` table of `{ user_id, name, dob?, relationship? }` — never any accounts, never any logins.
  - No invite / accept flow needed.

- **Why splitting matters:** Building (A) gives you a fancy multi-account pairing system but doesn't solve the very common "we have a 3-year-old who needs to be on the flight booking" case. Building (B) gives you that case but doesn't help your adult kids actually collaborate on planning. Most household-extension needs combine both.
- **Trade-offs to surface for product decision later:**
  - Permissions: do adult-child accounts (A) get full edit on the parent's trips, or a more limited role?
  - Expense splitting: are household-member-names (B) splittees for splitwise math, or are they free-riders on the parent's share?
  - UI: where does adding a household member live? Settings → Account → Household? Or per-trip "add traveller"?
  - Reservation Smart Import (M2): when extracting passenger names from a PDF, fuzzy-match against not just user + partner but the whole household.
  - Photo auto-caption / tagging: should household members be auto-suggested when captioning?
- **Implication for guide:** Document the current 1-to-1 partner limit explicitly so a user reaching for it doesn't try to add a third account and silently fail. Frame the workaround until family-groups land: each adult registers their own account and you invite them as trip members per-trip (no auto-add).
- **Implication for product:** This is a meaningful next-milestone candidate, not a quick fix. Likely scope: schema migration (new `households` + `household_members` tables), partner-pairing UI replaced by household-management UI, server changes for trip auto-add, fuzzy-match updates in Smart Import. Realistically a multi-day piece of work. **Not started — flagged for discussion** when the wife (and any other planned travel-companions) have actually used the app and we know which interpretation matters most.

---

#### Q11. "Some trips may not have a defined end date. For example, our caravanning trips around Australia likely start on a defined date but may be open-ended. We need to define an open-ended trip and also be able to extend a trip with additional days"

- **Category:** Real-use case the data model partially supports but the UX doesn't cleanly express.
- **What's there today:**
  - Trips can have no dates at all → 7 (or `day_count`) dateless placeholder days. User fills dates later.
  - Trips with both `start_date` and `end_date` → days generated for the range.
  - Editing dates via update trip → `generateDays` regenerates, preserving content where dates overlap.
- **The actual bug:** `generateDays` at line 39 reads `if (!startDate || !endDate)` — if EITHER is missing, BOTH are treated as missing. So providing `start_date` without `end_date` silently throws away the start_date and gives dateless placeholders. Open-ended (start-known, end-unknown) is not a first-class concept.
- **Also missing:** no "+ Add day" affordance. Extending requires editing trip's `end_date`. Mid-trip insertion ("we stayed an extra day in Sydney" between Day 3 and Day 4) isn't supported beyond shuffle-after-extend.
- **Decision (locked):** Both — open-ended trips as a first-class type AND explicit "+ Add day" buttons.
  - Open-ended: `start_date` set + `end_date` null → trip starts with **1 dated day** at start_date. User adds more via "+ Add day at end" as the trip unfolds. (Choosing 1 day, not 7, so the user has to actively own the open-endedness rather than being shown phantom future days.)
  - Explicit affordances: "+ Add day at start" / "+ Add day at end" buttons in the day list. Date inheritance: increment from neighbour by 1 day (or stay dateless if neighbour has no date).
- **Implication for guide:** Document the two trip modes (date-range vs open-ended) and the add-day affordance. Caravanning gets its own example in the planning section.
- **Implication for product:** Server: fix the `generateDays` guard, new addDayAtStart/addDayAtEnd helpers, new endpoints. Client: TripFormModal allow empty `end_date`; small "+ Add day" buttons on day list.

---

#### Q12. "What provisions do we have for editing a planned trip? As you know, things change"

- **Category:** Existing capability + a data-loss safety gap.
- **What's editable today:** Trip metadata (title, description, dates, currency, cover); day metadata (title, notes, journal); places (CRUD + drag-reorder + assignments); reservations; photos; budget; packing list; household membership.
- **The gotchas:**
  - **Truncating dates silently wipes content.** Trip March 1–10 with content on every day → user edits end_date to March 5 → days 6–10 are deleted (cascading places, notes, photos). No "are you sure?" today.
  - **Shifting dates only partially preserves.** March 1–10 → March 8–17 keeps Mar 8–10's content but deletes Mar 1–7. There's no "slide the trip forward by N days, keep everything" affordance.
  - **No first-class day reorder.** Days are date-keyed; swapping day 3 and day 4 means manually swapping dates.
- **Decision (locked):** Warn-before-data-loss first. The shift-trip and reorder-days are nice-to-haves but data-loss-prevention is non-negotiable.
- **Implementation approach:** Client-side compute (we already have trip data loaded) → if user changes dates such that days with content would be deleted, surface a confirmation modal listing affected days + content summary + "Cancel / Delete those days and proceed".
- **Implication for guide:** Cover the editing model + the safety nets. Explicitly call out "shifting a trip by N days" as a future feature, not currently safe.
- **Implication for product:** Single client-side change on TripFormModal's save handler. ~30-min fix. Server-side dry-run mode is an alternative if we want to keep the safety net server-side, but client compute is cheaper.

---

#### Q13. "When I invite another family to share 'X' days on a trip, how does that fit into an existing trip they are planning that may have one or two (or more) segments that are shared with us? What if they have not yet started putting their trip into 460 Planner when I put out the request?"

- **Category:** Two scenarios — one works today, one is a real gap.
- **Scenario A — they have an existing trip with segments already.** Works today. A trip can be linked to N segments simultaneously (each is a separate `trip_segments` row). So their trip can have: "Sydney week with you", "Brisbane week with you", "Adelaide week with another family", "their solo days" — all coexisting in the same parent trip via the union read in `dayService.listDays`. Accept flow: click invite link → see preview → pick which of their trips to link the segment to → segment days slot into their day list alongside other segments.
- **Scenario B — they don't have a trip yet.** Gap. `acceptInvite` in `segmentService.ts` line 296 requires `tripExists(targetTripId)` and line 297 requires `isTripOwner`. So the flow is: register → create a trip → come back and accept. High friction.
- **Decision (locked):** Guided creation (option B). Accept flow asks for a trip title if user has no trips, then creates a stub trip with the segment's dates and that title, then links the segment in.
- **Implementation approach:**
  - Server: extend acceptInvite to accept either `target_trip_id` (existing) OR `new_trip_title` (creates a stub trip from the segment's dates).
  - Client: SegmentAcceptPage trip-picker shows existing trips + a "+ New trip with this segment" option that asks for a title.
- **Implication for guide:** Document both flows side-by-side. Frame: "if you've already started planning your trip, link your shared days in. If not, accept here and we'll create a starter trip for you."
- **Implication for product:** Schema unchanged (segments and trip_segments cover both). Server change is one new code path in acceptInvite + maybe a new variant endpoint. Client change is one trip-picker affordance.

---

## Meta-observations from this session

Worth noting for guide-writing context:

- **Even the developer hits these on first contact.** That's signal: a new user (the partner, the other couple) will absolutely hit them too. The questions above aren't "edge cases" — they're "the most basic things you'd do in the first 5 minutes."
- **The user's questions were mostly about discoverability, not function.** Three of four observations were "where is X?" not "X is broken." That biases the guide toward visual-flow tutorials (screenshots, click-paths) rather than reference documentation.
- **The planned/unplanned split is the conceptual core.** If the guide explains nothing else well, it must explain this. The whole "research → research → research → schedule" workflow hinges on it.
- **Workflow-frequency-matters as a UX theme.** The Q5 photo-upload observation makes the broader point: features that are high-frequency *during* a trip (photo capture, journal jotting, expense logging, packing-list ticks) should be 1–2 taps from anywhere in the trip view. Features that are pre-trip and bursty (place research, day editing, reservation entry) can afford deeper navigation. The guide should structure around this — separate "Pre-trip planning" and "While you're travelling" sections rather than mixing them feature-by-feature.
- **Device-context shapes the right pattern.** Q7 surfaces a related-but-distinct theme: 460TP is genuinely a two-context app (laptop for planning, phone for trip-time recording), and the same UI element often wants different treatment in each. The audit work this implies — modal-vs-sheet, click-vs-tap, hover-vs-long-press, hidden-vs-visible — should be tracked separately from feature work. The guide will need parallel "On laptop" / "On your phone" call-outs in most workflows; the product needs a small standing backlog of responsive-design upgrades.

---

## Resolved

### 2026-05-30 — Q1 splash duration

- **Observation:** "The splash screen should stay on for a bit longer, maybe twice as long."
- **Fix shipped:** commit `4995e0f` — `HOLD_MS` 900 → 1800 in `client/src/components/shared/SplashScreen.tsx`. Total splash is now ~2.25 s (was ~1.35 s).
- **Behaviour note:** still shows once per browser session (sessionStorage gate). To see the new duration on a device that's already loaded the app, you need a fresh tab or to clear sessionStorage.

### 2026-05-31 — Q11 Open-ended trips + "+ Add day" affordance

- **Observation:** "Some trips may not have a defined end date... We need to define an open-ended trip and also be able to extend a trip with additional days"
- **Fix shipped:** commit `b22f446`.
  - Server: `generateDays` now distinguishes three modes — both dates missing → dateless placeholders, start set + end null → **open-ended** (single day at start_date), both set → dated range. Trip-create route no longer manufactures a 6-days-later `end_date` when only start_date is given.
  - New `addDayAtStart` / `addDayAtEnd` service helpers + `POST /api/trips/:id/days/at-start` and `/at-end` endpoints. Date inheritance: ±1 calendar day from the neighbour, or dateless if neighbour is dateless.
  - Client: `daysApi.addAtStart / addAtEnd`. Two small dashed-buttons bracket the day list in `DayPlanSidebar`. `TripFormModal` no longer auto-fills `end_date` when user types `start_date` if `end_date` was previously blank.
  - `remoteEventHandler` sorts the local days array by `day_number` on day:created/updated so an at-start renumbering renders in the right place.
  - 6 new server tests cover the matrix.

### 2026-05-31 — Q13 Segment invite with guided trip creation

- **Observation:** "What if they have not yet started putting their trip into 460 Planner when I put out the request?"
- **Fix shipped:** commit `d6dba09`.
  - Server: `segmentService.acceptInvite` now accepts `targetTripId` OR `newTripTitle`. When `newTripTitle` is set, server creates a stub trip on the segment's date range and adopts its id. Route validates that exactly one is provided.
  - Client: SegmentAcceptPage gains a "+ Create a new trip with this segment" radio option at the top of the trip picker, with an inline title input defaulting to "Shared trip with {inviter}". Accept handler branches on the choice.
  - 2 new server tests (guided creation + missing-input rejection).

### 2026-05-31 — Q12 Warn-before-data-loss on trip-date truncation

- **Observation:** "What provisions do we have for editing a planned trip? ...things change."
- **Fix shipped:** the same commit as the user reads this update from (current).
  - New `POST /api/trips/:id/dates-preview` endpoint: takes proposed `start_date` / `end_date`, returns which existing days would be deleted with content summary (assignments, photos, notes, journal, title) — without mutating state.
  - `TripFormModal.handleSubmit` calls dates-preview before the destructive PUT when editing an existing trip's dates. If any days would be deleted, shows a confirmation modal listing them. User must explicitly click "Delete those days and proceed" to commit.
  - 4 new server tests (truncate, clear-to-open-ended, no-op, shift).

### 2026-05-31 — Q10 Household supersedes 1-to-1 partner pairing (M11)

- **Observation:** "We should probably ensure that more than two people can be part of the 'partner' group ie kids etc"
- **Resolution:** Milestone 11 — full plan in `docs/ours-milestone-11-plan.md`. Five slices shipped in five commits:
  - **Slice 1** (`9f872d7`): schema for households + household_members + household_invites; users.household_id FK; migration that converts existing M3 partner pairs to 2-person households then drops users.partner_user_id and partner_invites; new householdService.ts with CRUD + autoAddHouseholdToTrip; replaced M3 partner reads in authService, tripService, routes/trips, routes/reservationImport, routes/auth; deleted partnerService.ts and M3 partner tests; 23 new service unit tests.
  - **Slice 2** (`b5d4cbd`): REST routes at `/api/household` (create / get / rename / leave + invites send/cancel/accept/decline + members CRUD); notification event type renamed partner_invite → household_invite; new in-app action handlers; 22 new integration tests.
  - **Slice 3** (`51dd4ea`): client UI panel `HouseholdSection.tsx` replaces `PartnerSection.tsx`; new household types + API client; DashboardPage "include on copy?" prompt switched to household; M3 partner stub endpoints removed entirely now that nothing calls them.
  - **Slice 4** (`384aea8`): two trip-creation tests verifying auto-add for multi-user households and no-op for solo users.
  - **Slice 5** (`384aea8`): passenger matcher returns `{ kind, id }` tagged results; reservationImport candidates now include named household_members; response splits into matched_user_ids[] + matched_member_ids[] (additive — old clients still work).
- **Both (A) family group accounts AND (B) named non-account members shipped** as per the user's "go for both" decision. Adult travel-companions get their own logins; kids/granny/pets are name-only.
- **Implication for guide:** Settings → Account → Household replaces the old Partner Pairing section. Document: create household → invite by email → either side accepts → new trips auto-add. Named members for kids/non-app-users via "+ Add member" in the same panel. Smart Import will recognise named members in passenger lists from reservation PDFs.

### 2026-05-31 — Q6 EXIF-timestamp warning for single-photo uploads

- **Observation:** "I uploaded a random photo into a day on a new trip I have created for testing. It did not flag that the photo was not actually taken on the day that is being assigned to it. I think there needs to be some sort of warning before proceeding..."
- **Fix shipped:** commit `694d911`.
  - New `utils/photoTimestampCheck.ts` extracts the photo's EXIF date via the existing `extractMetadata()` helper, encapsulates all "skip silently" cases (no EXIF, match, setting off), and finds matching days in the trip.
  - New `components/Photos/PhotoTimestampWarning.tsx` dialog with thumbnail + photo date vs selected day, three actions: "Add to selected day anyway" / "Use photo's date (→ matching day)" (only shown when a matching day exists in the trip) / "Cancel".
  - New `check_photo_timestamp` setting (default true), surfaced as a toggle in Settings → Display → "Warn when photo date doesn't match day" with hint text explaining the disable case (souvenirs, scans, placeholders).
  - Wired into both single-photo upload paths: `Journal/PhotoGrid.tsx` (only for single-file uploads — multi-file drops skip since batch-import already does smart matching), and `Planner/DayPlanSidebar.tsx` (Q5 day-header camera button, always single-file, always checks).
- **Behaviour:**
  - Default-on: every user gets the warning until they explicitly opt out.
  - Localised to photo's local calendar day, not UTC — a 11pm Sydney photo matches Sydney's current day, not next-day UTC.
  - "Use photo's date" only appears when there's actually a matching day in the trip to route to. If the photo was taken outside the trip's date range, that option is hidden and the user picks between Add Anyway or Cancel.
- **Implication for guide:** Document the safeguard, mention the toggle's location, explain when you'd want to turn it off (deliberate misassignment for souvenir-style photos).

### 2026-05-31 — Q2 quick category change via context menu

- **Observation:** "Might want to add this to the quick-add flow, as on any decent sized trip there will be a lot of places/activities and being able to view by category would be very useful straight up."
- **Reinterpretation that led to the fix:** There isn't actually a "quick-add bypass" path that skips the full PlaceFormModal — every add already goes through it and shows the category picker. The real friction is **changing/setting category on lots of places after the fact** (especially after bulk-imports like Google list or GPX, where everything lands uncategorised). So the fix targets that: a way to set category quickly without opening the full edit modal.
- **Fix shipped:** commit `b1f2772` — extended `shared/ContextMenu.tsx` with optional one-level `submenu` support on MenuItem (ChevronRight indicator + hover/click flyout), then added a "Set category →" entry to the right-click menu on each place in `Planner/PlacesSidebar.tsx`. Submenu lists all categories with their icons + "(no category)" to unset. Updates go through the existing `updatePlace` store action so real-time sync, mutation queue, and undo all work.
- **Cost:** one right-click → hover/click "Set category" → click a category. Three interactions per place.
- **Implication for guide:** Document the right-click context menu as the primary quick-action surface for places. Mention "Set category" as the natural follow-up after a Google-list / GPX import.

### 2026-05-31 — Q5 day-header camera button

- **Observation:** "Would be useful to have a quick access button to upload photos on the day header strip, rather than having to go into the day to then do it. Uploading photos is probably one of the most common things that will be done during a trip!"
- **Fix shipped:** commit `d0a5312` — added a `<Camera>` icon button to each day header in `DayPlanSidebar.tsx`, next to the existing `<FileText>` add-note button, gated by `canEditDays`. Click triggers a hidden `<input type="file" accept="image/*" capture="environment">` — on mobile pops the native camera UI; on desktop opens the file picker. Upload reuses the existing `uploadDayPhoto` store action so EXIF extraction, auto-caption via reverse-geocode, and photo-marker map rendering all kick in automatically.
- **Behaviour:** one-tap-to-camera from anywhere in the day list — no day-detail panel expansion, no modal. Per-day busy state shows a "wait" cursor while uploading. Toast on success/failure.
- **Out of scope (intentional):** multi-photo selection (use the existing batch-import or per-day grid), drag-drop onto day header (clashes with place-drag), long-press context menu (clashes with drag-to-reorder).
- **Implication for guide:** photo capture is now a first-class workflow with its own surface in the planner — document the day-header camera affordance as the primary path for in-trip recording, and the per-day photo grid as the path for reviewing/editing/captioning what's already uploaded.

### 2026-05-30 — Q3 time fields on place creation

- **Observation:** Time fields were only shown when editing an existing place, requiring a save-then-reopen workflow to assign timing.
- **Fix shipped:** commit `9717449` — dropped the `{place && ...}` gate around `<TimeSection>` in `PlaceFormModal.tsx`, and relaxed `hasTimeError` so it no longer requires edit-mode to flag end-before-start. Time fields now appear on creation; collision detection still no-ops until an assignment exists.
- **Implication for guide:** the "create-first-then-edit-to-set-time" workaround is no longer needed — document the simpler flow.
