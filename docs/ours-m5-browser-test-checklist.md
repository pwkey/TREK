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
- **Expected:** the day row shows the new title immediately (optimistic apply) and within 2s a small "1" badge appears next to the navbar dot. Tooltip reads "Offline — 1 change queued". No error toast (the mutation is not lost — it's queued).
- Switch back to **No throttling**.
- Within 30s (or instantly on the 'online' event) the badge clears and the tooltip returns to green. The day's title remains the new value with no manual refresh — the server's WebSocket broadcast of the replayed mutation refreshes the local store.
- (Optional sanity:) refresh Alice's tab. The new title is still on the day row — the mutation reached the server and the IndexedDB mirror has been updated.

**Known nuance:** if you refresh Alice's tab WHILE STILL OFFLINE before reconnecting, the cold-start re-hydrates from IndexedDB (which only stores server-confirmed state), so the row reverts to the OLD title. The pending mutation in the queue still replays correctly on reconnect — no work is lost. Persisting optimistic-state to IndexedDB is a future polish.

## 3. Cold-start hydration (slice 1)

- With Alice still online, open one of her trips. Wait for it to load.
- Set DevTools to **Offline**.
- Hit **Ctrl+R** to reload the tab.
- **Expected:** the planner still renders the trip's days from IndexedDB instead of an error screen. The day rows are present, dates match. Read-only behaviour from this point — any save attempt would queue.
- Switch back to **No throttling**, hit Ctrl+R, normal load resumes.

## 4. Stale-write conflict (slice 4)

This is the showpiece. **CRITICAL setup detail:** the two tabs must be in genuinely independent browser sessions so they don't share IndexedDB — otherwise the online tab's sync-worker drains the offline tab's queued mutation before there's a chance for the conflict precondition to fire. Two tabs of the same Chrome window share storage and will NOT reproduce the conflict.

The right setup is **regular Chrome + Chrome incognito**, both signed in as the same user (e.g. both as Alice). Regular Chrome and an incognito window have separate IndexedDB origins, so each maintains its own mutation queue. (Two unrelated browsers — Chrome + Firefox — also work.)

- Sign Alice in on **regular Chrome (= "tab A")** and on **Chrome incognito (= "tab B")**. Open the same day in both. Verify both display the day's current title.
- In tab A, set DevTools to **Offline**. Edit the day title to "Alice's offline edit". Save → the new title appears optimistically in tab A; badge increments to "1" (queued). No error toast.
- In tab B (still online), edit the same day's title to "Server moved on". Save → succeeds; the day row in tab B shows "Server moved on".
- Switch tab A back to **No throttling**.
- Within ~30s tab A's sync-worker replays its queued mutation. Server detects the precondition mismatch (tab A's observed `updated_at` is older than the one tab B's edit just produced) and parks it as a conflict (returns 409, no overwrite).
- Within ~15s tab A's navbar dot turns **yellow** with a "1" badge. Tooltip: "1 pending conflict — click to review".
- Click the dot. It navigates to Settings → Account tab and scrolls to the "Pending sync conflicts" section showing one conflict row:
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

- **Day-title and day-notes edits now apply locally and suppress the toast when queued (fixed during M5 verification).** Other mutations (place-edit, reservation-edit, packing toggles, etc.) still surface the network error to the user. Their queued mutation does sync correctly on reconnect, so no work is lost; the UX is just rough until each callsite gets the same optimistic treatment.
- **Stale-write conflict precondition only fires on day-update right now.** Every other mutation route is still last-write-wins silently. The `parkAsConflict` helper is reusable and future slices will adopt it for places, reservations, etc.
- **Safari PWA only syncs while a tab is open.** Workbox-level Background Sync (queue inside the service worker) was deferred; we have an in-page 30s tick + window 'online' listener + Capacitor App.resume hook. Chromium and Capacitor cover well; Safari with the tab closed does not.
- **No proactive map-tile precache.** Workbox's existing runtime cache covers tiles you actually pan to. The "download map area for the trip's bounding box" feature is deferred.
- **Cross-tab queue sharing is intentional, not a bug.** Two tabs in the same browser profile share IndexedDB and therefore share the mutation queue: if tab A queues a mutation while offline and tab B is online, tab B's sync-worker tick drains the queue through its connection and the work syncs faster than waiting for tab A. Good for users (any online tab finishes the work) but it means the slice-4 conflict scenario can only be reproduced with browser sessions that have isolated storage (see step 4).
- **Successful PUT/POST/DELETE responses are not visible in the dev server log at the default `info` level** — only 4xx/5xx are logged at info; 2xx/3xx go to `debug`. To trace a queue replay reaching the server, query the SQLite database directly (e.g. `SELECT title, updated_at FROM days WHERE id = X`) or temporarily raise the log level.
