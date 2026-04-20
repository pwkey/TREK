# Milestone 4 — Browser test checklist

**Purpose:** Manual click-through to satisfy CLAUDE.md §9.5 for the shared-segments feature before declaring it done. Backend is already exercised by 33 supertest integration tests; this checklist is specifically for the UI + real WebSocket paths that those tests can't cover.

**Status:** written 2026-04-20, pending execution.

---

## Setup

```
# Terminal 1
cd server && npm run dev
# Terminal 2
cd client && npm run dev
```

Open `http://localhost:5173` in **two different browser profiles** (or Chrome regular + Chrome incognito). Call them **Alice** and **Bob**. Sign in with two different accounts — create via `/register` if needed. Give each a trip with overlapping dates:
- Alice: "Europe 2027" Jun 10-15
- Bob: "Bob's EU" Jun 11-14

---

## 1. Create-segment UI (Alice)

- On Alice's trip page, find the new 🔗 icon in the day-plan sidebar header (next to PDF / ICS / Undo).
- Click it → modal opens titled "Share days with another household".
- Enter title e.g. "Adventure with Bob", pick From Jun 11 To Jun 13 → preview reads "3 days will be shared: Jun 11, Jun 12, Jun 13".
- Click **Create + get invite link**.
- Success screen shows the invite URL + Copy button. Click Copy → toast says "Invite link copied". Note the URL.
- Click **Done**. Modal closes.
- The three shared days should now each show a green **🔗 Shared · Adventure with Bob** chip next to the day title.

## 2. Accept flow (Bob)

- In Bob's browser, paste the invite URL and hit enter.
- Accept page shows the segment card ("Adventure with Bob", Jun 11 → Jun 13), Bob's trip in the radio list.
- If Bob's trip has content on Jun 11-13, the orange "Your selected trip has content on N dates" warning appears.
- Select Bob's trip → Click **Attach to this trip**.
- Toast: "Segment linked to your trip". You land on Bob's trip page.
- Bob's Jun 11-13 rows should now be the same rows Alice created — chips visible.

## 3. Real-time sync (both windows visible)

- Arrange the two windows side by side, each showing the shared day Jun 12.
- On Alice's window, edit Jun 12's title (click the pencil icon, type "Bordeaux wine tour", Enter).
- **Bob's window should update within ~1s** (WebSocket fan-out). No reload needed.
- Repeat in reverse: Bob edits → Alice sees it.
- Drag a place from Alice's places sidebar onto Jun 12 → Bob's planner should show the same assignment appear within ~1s.

## 4. Manage + leave (Bob)

- On Bob's trip page, click the 🔗 icon again. Modal opens.
- Top section shows "Shared segments on this trip" with one row: "Adventure with Bob", range, **Leave** button (Bob is NOT home so it's active).
- Click **Leave** → button becomes Cancel + Confirm leave. Click **Confirm leave**.
- Toast: "Left shared segment — memento copy kept on your trip". Modal refreshes, segment is gone from the list.
- Bob's Jun 11-13 rows remain (plain rows now, no chip).
- In Alice's window, the chips should still be on her Jun 11-13.

## 5. Delete-block (Alice)

- Create a new segment on Alice, invite Bob, Bob accepts (as in steps 1-2 again).
- On Alice's dashboard, try to delete her trip.
- Expected: toast reads "This trip hosts shared segments used by other households. Leave or dissolve them before deleting." (not the generic delete-error).
- Have Bob leave the segment (step 4 repeat). Alice's delete should now succeed.

## 6. Unauth accept redirect

- Log Bob out. Paste a fresh invite URL. Should redirect to `/login?redirect=...` with the path preserved. Log in → lands back on the accept page.

---

## Reporting

When something doesn't work: copy the relevant browser console error + the server terminal output, note which step, and paste back. If everything passes, add a "manually verified 2026-MM-DD" line to `docs/ours-milestone-4-plan.md` status.
