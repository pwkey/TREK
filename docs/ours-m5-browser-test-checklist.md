# Milestone 5 — Browser test checklist

**Purpose:** end-to-end click-through for offline-first writes. Backend is exercised by 109 supertest cases; this fills the UI + IndexedDB + WebSocket gap CLAUDE.md §9.5 asks for.

**Status:** written 2026-04-27, pending execution.

---

## Setup

If servers aren't already running, ask Claude to start them. Otherwise:
```
# Terminal 1
cd server && npm run dev
# Terminal 2
cd client && npm run dev
```

Open `http://localhost:5173` in **two browser windows**: regular Chrome (Alice) and Chrome incognito (Bob). Sign in with two existing accounts. The pair you used during the M4 test is fine — they're already members of overlapping trips.

You'll spend most of the test in Chrome DevTools (F12) → Network tab → the **"No throttling"** dropdown, which lets you switch to **"Offline"** to simulate connectivity loss without disconnecting your laptop.

---

## 1. Online indicator (slice 1)

- Look at the navbar on either window. There should be a small **green dot** next to the user menu.
- Hover the dot. Tooltip reads "Online — changes sync live".
- Open DevTools → Network → set throttling to **Offline**.
- Within ~1s the dot turns **red**. Tooltip switches to "Offline — 0 changes queued, will sync when you reconnect".
- Switch back to **No throttling** → dot returns to green.

## 2. Offline mutation queues (slices 2 + 3)

- On Alice's planner, pick a day and edit its title. Save. Verify it saved (online — green dot, no badge).
- Set Alice to **Offline**. The dot goes red.
- Edit the same day's title to something different. Save.
- **Expected:** an error toast appears ("Error updating day name") because the network call fails — that's the existing behavior. **But:** within 2s a small "1" badge appears next to the navbar dot, and the tooltip now reads "Offline — 1 change queued".
- Switch back to **No throttling**.
- Within 30s (or instantly on the 'online' event) the badge clears and the tooltip returns to green.
- Refresh Alice's tab. The new title is on the day row — confirming the mutation replayed against the server.

## 3. Cold-start hydration (slice 1)

- With Alice still online, open one of her trips. Wait for it to load.
- Set DevTools to **Offline**.
- Hit **Ctrl+R** to reload the tab.
- **Expected:** the planner still renders the trip's days from IndexedDB instead of an error screen. The day rows are present, dates match. Read-only behaviour from this point — any save attempt would queue.
- Switch back to **No throttling**, hit Ctrl+R, normal load resumes.

## 4. Stale-write conflict (slice 4)

This is the showpiece. Two windows, deliberate stale-write, conflict appears in Settings.

- On Alice (regular Chrome), open the same day in two different tabs of the same window. Both display the day's current title.
- In tab A, set DevTools to **Offline**. Edit the day title to "Alice's offline edit". Save → error toast + badge appears (queued).
- In tab B (still online), edit the same day's title to "Server moved on". Save → succeeds.
- Switch tab A back to **No throttling**.
- Within ~30s the queue tries to replay tab A's mutation. Server detects the precondition mismatch and parks it as a conflict (returns 409, no overwrite).
- Within ~15s the navbar dot turns **yellow** with a "1" badge. Tooltip: "1 pending conflict — click to review".
- Click the dot. It navigates to Settings.
- Open the **Account** tab. A new section called "Pending sync conflicts" appears at the bottom showing one conflict row:
  - record type "day", record id, timestamps for "yours" and "theirs".
  - side-by-side diff showing your title ("Alice's offline edit") vs the server's ("Server moved on").
  - three buttons: **Take theirs**, **Combine**, **Keep mine**.

### 4a. Take theirs

- Click **Take theirs**. Toast: "Server's version kept". Section disappears (no more pending). Yellow dot reverts to green.
- Refresh the tab. The day's title is "Server moved on". Tab A's queued mutation discarded.

### 4b. Keep mine

- Repeat the offline-edit setup (tab A offline, tab B online edits the same field, tab A reconnects).
- Click **Keep mine**. Toast: "Your version applied".
- Refresh. The day's title is "Alice's offline edit" — the server has been overridden.

### 4c. Combine

- Repeat the offline-edit setup but on **notes**, not title (the Combine button only appears for text fields). Make Alice's offline notes a paragraph; make tab B's online notes a different paragraph.
- After the conflict appears, expand the **Combine: edit a merged version** section. The textarea is pre-seeded with your text, a `---` separator, then the server's text.
- Edit the merged text however you like. Click **Combine**. Toast: "Combined version applied".
- Refresh. The day's notes contain your edited combined version.

## 5. Download for offline (slice 5)

- On any trip's planner, look at the day-plan sidebar header (where PDF, ICS, Share live).
- A **Download** icon (cloud) is next to them.
- Click it. Toast: "Trip downloaded for offline use".
- (Behind the scenes: the trip's full payload is now in your local IndexedDB.)
- Set DevTools to **Offline**. Hit Ctrl+R. The planner still shows the trip exactly as it was when you clicked Download — including any places, reservations, etc.

## 6. Capacitor lifecycle (defer to mobile build)

Untestable in a desktop browser — only fires when running inside Capacitor's iOS/Android shell. Document for the eventual M1 phase B test pass: install the native app, edit something offline, background the app, reconnect, foreground it → mutation should replay within seconds (faster than the 30s in-page tick).

---

## Reporting

When something doesn't work: copy the relevant browser console error + the server terminal output, note which step (e.g. "step 4a"), and paste back. If everything passes, add a "manually verified 2026-MM-DD" line to `docs/ours-milestone-5-plan.md` status.

## Honest gaps (documented, NOT bugs)

These are deliberate scope cuts; they'll feel like missing features, not failures:

- **Most mutations still throw + show an error toast on offline.** Only the queue-and-replay mechanism survives the offline window — per-callsite optimistic UX (suppress toast, apply locally, indicate "queued") is per-component work and was deferred. Day-edit, place-edit, etc. still surface the network error to the user. Their queued mutation does sync correctly on reconnect, so no work is lost; the UX is just rough.
- **Stale-write conflict precondition only fires on day-update right now.** Every other mutation route is still last-write-wins silently. The `parkAsConflict` helper is reusable and future slices will adopt it for places, reservations, etc.
- **Safari PWA only syncs while a tab is open.** Workbox-level Background Sync (queue inside the service worker) was deferred; we have an in-page 30s tick + window 'online' listener + Capacitor App.resume hook. Chromium and Capacitor cover well; Safari with the tab closed does not.
- **No proactive map-tile precache.** Workbox's existing runtime cache covers tiles you actually pan to. The "download map area for the trip's bounding box" feature is deferred.
