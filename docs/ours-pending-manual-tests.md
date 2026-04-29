# Pending manual tests

Tests that haven't been walked through yet by hand. Server-side integration tests pass for everything below; this doc tracks the click-through verification that's still owed.

Last updated: 2026-04-29

---

## M6 polish — Per-day photo map (committed `d9ad25e`)

**Blocker:** needs photos with EXIF GPS preserved. Refer to `docs/ours-photo-transfer.md` for transfer methods that don't strip the metadata.

**Steps:**
1. Bring at least 2 geotagged photos onto your laptop via USB-from-DCIM or AirDrop (iPhone).
2. Add them to a day via the photo grid in day-detail.
3. Confirm 📍 chips appear on the thumbnails.
4. Open the **Memoir** tab on the trip.
5. The day card should now have a small ~200 px tall map between the journal and the photo grid, with red dot markers at each photo's location, auto-fit-bounds, and tooltips with caption / filename.
6. Click a marker → opens the same lightbox as clicking the thumbnail.

---

## M6 follow-up — GPS extraction fix + batch photo import (committed `cc73b42`)

**Setup:** the `Testing/trip photos/` folder has 9 Samsung-shot JPEGs + 1 MP4. The trip you import them into needs days that cover at least some of the July-August 2022 capture dates so auto-assignment has something to match.

**GPS extraction:**
1. Upload a single photo via the per-day Photo grid Upload button (existing flow).
2. After upload, the 📍 chip should appear on the thumbnail. Hover → tooltip shows `Geotagged: -33.78xxx, 151.28xxx · Altitude: ~70m · Camera: samsung SM-G973F`.
3. Cross-check via DB:
   ```
   cd server
   node -e "const db=require('better-sqlite3')('data/travel.db'); console.log(db.prepare('SELECT id, lat, lng, altitude, camera FROM day_photos ORDER BY id DESC LIMIT 3').all());"
   ```
   `lat` and `lng` should be non-null.

**Batch import:**
4. In the day-plan sidebar header, click the new **Images** icon (sits between the existing icons and Export buttons).
5. Drop the whole `Testing/trip photos/` folder OR multi-select all files.
6. Preview should show:
   - 9 JPEGs with thumbnails, capture timestamps, and auto-assigned days.
   - The MP4 with status "video files not yet supported · skip".
   - Photos already in the trip from the GPS-extraction test above with status "already imported · skip".
7. Override a day-assignment via the dropdown on one row — confirm it sticks.
8. Click **Import N photos** → progress indicator advances per-file → photos appear in their assigned days' grids when done.

---

## M7 round-trip end-to-end (export + import)

You verified slice 7.5 (the standalone viewer) but the full `export → import` round-trip and the `/polls` deep-link weren't manually walked through.

**Steps:**
1. Pick a trip with several days, 1+ journal entries, and a few photos.
2. Click the **Archive** button on the day-plan sidebar header → save the bundle.
3. **Verify the bundle** — unzip it. You should see:
   - `trip.json` with `format: "bundle"` and `attachment_path` on each photo.
   - `attachments/photos/<id>-<filename>` with the binaries.
   - `viewer.html` at the root.
4. Double-click `viewer.html` (no server) → pick the same `.zip` → trip renders with photos.
5. Hit **Print / Save as PDF** → confirm the print stylesheet looks clean.
6. Back in the app: dashboard → **Import** button → drop the same `.zip` → dry-run preview shows expected counts → confirm.
7. New trip appears in your list; open it; verify days, places, journals, photos all came through.

---

## M8 polish — Settle-up open by default + count badge (committed `620d17b`)

**Blocker:** needs a trip with two or more members AND budget items with `paid` flags set on at least one member per item.

**Steps:**
1. Make a trip with at least one collaborator added as member.
2. Add a budget item, click into the per-person split, mark someone (not yourself) as the payer.
3. Open the **Finanzplan** tab.
4. The total card now shows the **Settlement** section **expanded by default** — with the recommended cash flows ("Alice → $X → Bob") visible immediately.
5. Click the chevron to collapse → confirm the collapsed label shows a small count pill (`Settlement [N]`) so you still see how many transactions are pending.

---

## M9 slices 1+2 — Pre-trip availability polls (committed `eab3d6b`)

### Owner creates a poll

1. Click **Polls** in the navbar (next to "My trips").
2. Click **+ New poll** → enter title + description + 2-3 candidate date ranges → **Create poll**.
3. Poll appears in the left list; details panel on the right shows the share URL.
4. Click **Copy** → URL is on your clipboard.

### Voter submits choices

5. Open the share URL in an incognito window (so you're not authenticated).
6. Form: enter a name, optionally an email, tap Yes / Maybe / No on each option, click **Submit**.
7. "saved" appears next to the button.
8. Reload the same URL in the same incognito window → previous choices are pre-filled, button reads "Update my answers".

### Multiple voters

9. Open the share URL in a *different* incognito window. Vote with a different name. Submit.
10. Owner side: refresh the poll detail panel → both voters appear in the per-option Yes/Maybe/No columns and chips.

---

## M9 slice 3 — Convert poll to trip (committed `c8eb41a`)

**Setup:** finish at least one round of voting (above). Have at least one voter whose email *matches* an existing user account on this instance.

**Steps:**
1. On the poll detail panel, each option row now has a **"Make trip →"** button on the right.
2. Click it on one option → confirm dialog → trip is created with those dates → toast shows "X auto-invited; Y need manual invite" → page navigates into the new trip's planner.
3. Verify the new trip's `start_date` / `end_date` match the chosen option.
4. Verify trip members include the voter whose email matched a user account.
5. Go back to /polls → the poll's detail panel now shows a **"Trip created from this poll"** banner with an **Open trip** button; per-option "Make trip" buttons no longer render.
6. Try to convert again — should be blocked (409 from server).

---

## M9 slice 4 — Vacay pre-fill (committed `c8eb41a`)

**Setup:** mark some vacation days in your **Vacay** tab — at least a week's worth, ideally including dates that overlap with your poll options' ranges.

**Steps (logged in):**
1. Open a poll's share URL while logged in.
2. A new sparkles-iconed **"Pre-fill from my Vacay"** button appears between the name/email panel and the option cards.
3. Click it → choices are auto-set per option:
   - Option fully covered by your vacation days → **Yes**
   - Partial overlap → **Maybe**
   - No overlap → **No**
4. Status note below the button reads "Pre-filled — N yes, N maybe, N no. Adjust before submitting."
5. Adjust if needed, hit **Submit** → vote saves as normal.

**Steps (anonymous):**
6. Open the same URL in an incognito window. The pre-fill button should be **absent**. The auth probe failure should NOT bounce you to /login (we exempt /poll/ paths from the redirect).

---

## Once everything checks out

Add a "manually verified YYYY-MM-DD" line under each section above as a small commit. Then this doc shrinks to "no pending tests" status until the next milestone.
