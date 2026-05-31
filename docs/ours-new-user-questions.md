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

### 2026-05-30 — Q3 time fields on place creation

- **Observation:** Time fields were only shown when editing an existing place, requiring a save-then-reopen workflow to assign timing.
- **Fix shipped:** commit `9717449` — dropped the `{place && ...}` gate around `<TimeSection>` in `PlaceFormModal.tsx`, and relaxed `hasTimeError` so it no longer requires edit-mode to flag end-before-start. Time fields now appear on creation; collision detection still no-ops until an assignment exists.
- **Implication for guide:** the "create-first-then-edit-to-set-time" workaround is no longer needed — document the simpler flow.
