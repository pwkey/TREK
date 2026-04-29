# Pending manual tests

Tests that haven't been walked through yet by hand. Server-side integration tests pass for everything below; this doc tracks the click-through verification that's still owed.

Last updated: 2026-04-29

---

## M1 — PWA install polish: viewport-fit, A2HS hint, standalone polish (uncommitted)

**Goal:** put 460 Trip Planner on Peter's iPhone home screen as an app icon, with a clean standalone-mode launch experience and no notch/home-indicator clipping.

**Setup notes:**
- The dev server runs on `localhost:5173` by default. To install as a PWA on a phone you need the full HTTPS production-style build OR access via a real LAN hostname. For dev iteration a Vite preview build (`npm run build && npm run preview --host 0.0.0.0`) on the laptop's LAN IP is enough on Android Chrome; iOS Safari is fussier — install only works on a properly-served HTTPS origin (use `ngrok http 5173` or run the production server build with HTTPS for the actual install test).

**Steps (iOS — primary verification):**
1. Install Add-to-Home-Screen on an actual iPhone running iOS 16.4+. Open the trip planner URL in Safari. After ~1.5 seconds, a dark toast banner should appear at the bottom: "Install 460 Trip Planner — tap Share, then Add to Home Screen". Confirm it has the 460 white logo and an X to dismiss.
2. Tap the X → banner disappears, never returns (verify by reloading — should stay gone).
3. Clear localStorage (`localStorage.clear()` in dev tools) and reload — banner should come back.
4. Tap Safari's Share → Add to Home Screen → use default name, confirm. Open the new home-screen icon → should launch in standalone mode (no Safari URL bar).
5. Once launched standalone, the install hint should NOT appear.
6. Pull down at the top of the dashboard → no pull-to-refresh gesture (suppressed via `overscroll-behavior` in standalone mode). Browser tab version still has it.
7. Open a trip → confirm the navbar sits below the notch (no overlap), and the day-plan sidebar / mobile place-inspector don't get clipped by the home-indicator strip at the bottom.

**Steps (Android — secondary):**
8. Open the URL in Android Chrome. The install banner shouldn't appear (iOS only). Chrome's own URL-bar install prompt should still work.
9. Install via Chrome → home-screen icon → launch → standalone mode + no clipping.

**Steps (desktop):**
10. Open in desktop Chrome / Edge / Firefox → URL bar should show an install icon. Click it → installs as a windowed PWA. Same icon + name as configured in the manifest.

**Edge cases:**
- Open in iOS Safari with the previous build (before the viewport-fit change). Compare side-by-side: notch should clip the navbar in the old build, not the new one.
- Open in Chrome on iOS (CriOS UA). The install hint should NOT appear (Chrome on iOS can't install PWAs).
- Open in Facebook / Instagram in-app browser. Hint should NOT appear (UA filter excludes those webviews).

---

## M6 follow-up — GPX track upload + render (committed `d46da7e`)

**Why:** the highest-fidelity backfit option — upload the recorded GPS track from a phone / watch / Strava, render it as the actual path. Multiple tracks per trip; each renders as a purple polyline alongside the photo route.

**Steps:**
1. Open a trip on the Plan tab. Bottom-right of the map: a **Route** icon button (above the layers button). Click → popover opens.
2. Click **Upload .gpx file** → pick any `.gpx` file. The track parses, stores, and a purple polyline appears on the map. Hover the line → tooltip shows the track's name + point count + km.
3. Upload a second file. The popover lists both with eye-toggle, rename (✏️), delete (🗑) controls. The bottom-right button shows a small purple badge with the count.
4. Click the eye icon to hide a track → polyline disappears immediately. The hidden state persists in localStorage for this device only (verify by reloading).
5. Click the ✏️ icon → inline rename input appears. Type a new name + Enter → updates server-side.
6. Open the trip in a second tab → upload a track in tab A → tab B receives via WebSocket and renders within ~1s.
7. Delete a track in tab A → confirm dialog → polyline removed in both tabs.
8. Delete the trip → all its tracks cascade-delete server-side (verify via SQL: `SELECT * FROM gpx_tracks WHERE trip_id = X;`).
9. Edge cases:
   - Upload a non-GPX file → 400 with sensible error in the popover.
   - Upload an empty GPX (no `<trkpt>` and no `<rtept>`) → 400.
   - Upload a >5MB file → multer rejects.
10. Auto-fit: open a trip with NO photos and NO places, but ONE GPX track — the map should auto-frame the track's bounds (not stay at Sydney default).

**Server tests:** GPX-001 to GPX-010 in `tests/integration/gpxTracks.test.ts` cover trk + rte parsing, naming precedence, CRUD, permissions, and trip-cascade.

---

## M6 follow-up — Editable photo-route waypoints (committed `e77168c`)

**Backfit story:** override a road-snapped leg by inserting waypoints to force the route through the actual road taken (or to manually trace a hike/boat path that OSRM doesn't know about). Per-segment, persists per-account, syncs across devices via WebSocket, queues for offline replay via the existing M5 mutation queue.

**Steps:**
1. Open a trip with geotagged photos. Plan tab → toolbar → **Road**. Wait for legs to snap.
2. Pick a leg whose OSRM route doesn't match the road you actually took. **Right-click on the polyline** at the location you want the route to pass through → leg re-snaps via OSRM through that waypoint. Solid green, ✏️ icon appears at the photo-to-photo midpoint.
3. The new waypoint is a small green dot. **Drag it** to refine — on drop, the leg re-snaps.
4. Add a second waypoint with right-click — the insertion picks the leg sub-segment whose nearest endpoint is closest, so the order matches what you'd expect from a human reading the path.
5. **Right-click a waypoint** → it's removed; leg re-snaps. If you remove the last waypoint, the override is cleared (back to OSRM default — no ✏️).
6. Reload the page → overrides persist (server round-trip).
7. Open the same trip in a second tab → drag a waypoint in tab A → tab B updates within ~1s (WebSocket).
8. Block the network (DevTools → Network → Offline) → drag a waypoint → leg still updates locally; the request queues. Re-enable network → the queued PUT replays and the row appears server-side.
9. Delete a photo via day-detail → its overrides cascade-delete server-side (verify via SQL: `SELECT * FROM photo_route_overrides`).
10. Editing is gated to **Road mode only** — verify Straight mode shows no ✏️/waypoint dots even on legs that have overrides, and right-click on a Straight-mode polyline doesn't add waypoints (falls through to the map's "add place here" handler).

**Server tests:** PRO-001 to PRO-010 in `tests/integration/photoRouteOverrides.test.ts` cover the CRUD + cascade + idempotency + permissions paths.

---

## M6 follow-up — Per-segment road-snap with non-road fallback (committed `9aa9ae4`)

**Why:** Road mode previously snapped all photo waypoints in one OSRM call, which fails entirely if any single leg is non-routable (e.g. a flight to an island, a ferry crossing). Now each consecutive pair is snapped independently — snapped legs render solid green, non-routable legs render dashed amber straight (matching the Straight-mode style). Results are cached per-segment at module scope so toggling modes back and forth doesn't re-hit OSRM.

**Steps:**
1. Pick a trip whose photos span both road-connected places AND a non-road hop (flying to an island, ferry crossing, etc.). Or fake one by creating a poll/trip with a deliberately-spread Sydney + Tasmania set.
2. Plan tab → toolbar → click **Road**. Initially all segments render dashed amber as a placeholder, then progressively swap to solid green as OSRM responds.
3. The non-road leg should remain dashed amber even after snapping completes — with the same arrow at its midpoint as the road legs.
4. Toolbar shows "X non-road" in amber when there's at least one non-routable leg (hover for tooltip).
5. Toggle to **Straight** and back to **Road** — should be near-instant the second time (cache hit).

---

## M6 follow-up — Map layers switcher + OSM as default tile (committed `f8a7f19`)

**Why:** the upstream default `CartoDB Light` renders roads as very faint grey-on-white — at zoom 10 in Sydney the road system is almost invisible. Switched the default to standard OpenStreetMap (bold yellow/orange roads) and added a quick layer-switcher on the map so swapping styles doesn't require a trip to Settings.

**Steps:**
1. Open a trip on the Plan tab. Roads should be clearly visible by default (standard OSM look).
2. Bottom-right of the map: a small circular **layers** button. Click → popover lists OpenStreetMap, OpenStreetMap DE, CartoDB Light, CartoDB Dark, Stadia Smooth, with the active one highlighted + checkmark.
3. Click any preset → tiles swap immediately. Reload the page → the choice persists (it's saved via `settings.map_tile_url`).
4. Click outside the popover or press Escape → closes.
5. Open Settings → Map → the dropdown there reflects the same value as the map switcher.

---

## M6 follow-up — Chronological photo route on the trip map (committed `7eba3f7`)

**Idea:** with geotagged photos imported, the Plan tab now draws a route through them in `taken_at` order with directional arrows — useful as an at-a-glance reconstruction of the day's travel, even before places are added. Two modes:

- **Straight** (default) — dashed amber polyline, photo-to-photo straight lines. Honest about being approximate; useful for boats, hikes, flights where roads aren't relevant.
- **Road** — solid green polyline, snapped to roads via OSRM. Falls back to straight silently if OSRM has no answer (and the toolbar shows "no road match").
- **Off** — hide the route layer entirely.

Toolbar lives top-centre on the map, only renders when there are 2+ geotagged photos.

**Steps:**
1. Open a trip with geotagged photos already imported (or import them via the batch dialog first).
2. Plan tab map: should auto-show the dashed amber route between photos in capture order, with small ▶ arrows at each segment midpoint pointing in direction of travel.
3. Click the **Road** segment of the toolbar → the route should briefly say "snapping…" then redraw as a solid green road-snapped line. Arrows stay at photo midpoints (intentional).
4. If you have any waypoint OSRM can't resolve (e.g. a photo over water), expect the toolbar to flip to red "no road match" and the layer to fall back to straight.
5. Click **Off** → both polyline and arrows disappear.

---

## M6 follow-up — Photo-marker click opens day detail (committed `bdb0cdb`)

Clicking a red photo marker on the Plan map should now pop the day-detail panel (the photo grid for that day), instead of doing nothing visible.

---

## M6 follow-up — Map auto-fits to photos + Sydney default centre (committed `7fa9b30`)

**Bug observed:** opened a fresh trip after batch-importing photos with GPS, but the trip map stayed at the upstream Paris default — even though the red camera markers were rendering at the photo locations, the viewport never zoomed to them. Cause: `BoundsController` only considered `places` for the auto-fit, and `fitKey` only ticked on day-select (never on initial trip load).

**Fix:**
- `BoundsController` now folds photo coords into the bounds calculation alongside places.
- `TripPlannerPage` bumps `fitKey` once when the trip first has any geocoded data to show (places ∪ photos).
- The Paris fallback (48.8566, 2.3522) used in three places — `MapView` default prop, `TripPlannerPage` settings fallback, `MapSettingsTab` initial state — is now Sydney (-33.8688, 151.2093). Settings → Map still wins for users who set their own.

**Steps:**
1. New trip with no places yet → batch-import a few geotagged photos.
2. Trip map should auto-zoom to fit the photo locations on first load (was: stayed at Paris).
3. Add a place at a different location (or just observe an existing trip with both) → bounds should include both place pins and photo markers.
4. New install / unset settings → Settings → Map preview should default to Sydney instead of Paris.

---

## M6 follow-up — Cross-trip duplicate-flag bug + concurrent upload + progress bar (committed `ec50233`)

**Scenario that broke before:** delete a trip → create a new trip with new dates → batch-import the same photo set → every row was flagged "already imported · skip" even though the new trip had no photos. Cause: `dayPhotos` in the Zustand store is keyed by `dayId` (not `tripId`) and was never cleared when navigating to a different trip.

**Two-part fix:**
- `tripStore.loadTrip` now resets `dayPhotos: {}` and `dayJournals: {}` whenever a trip loads.
- `BatchPhotoImport` filters `existingPhotos` to only days belonging to the current trip — defence in depth.

**Steps:**
1. Open trip A → batch-import a few photos → confirm they import normally.
2. Delete trip A.
3. Create trip B with dates that match the photos' capture dates.
4. Open the batch import dialog on trip B → drop the same photos.
5. Preview rows should NOT show "already imported · skip" — they should show as importable with auto-assigned days.

**Concurrent upload + progress bar:**
6. With the same set selected for import, click **Import N photos**.
7. Footer should show a real progress bar (count of completed + percentage + filled bar) instead of a single line of small text.
8. Watch the per-row spinners — up to **three** rows should be in the "uploading" state at any time (was one before). For a 9-photo batch the wall-clock should drop noticeably.
9. The progress bar should advance as workers finish, not strictly in row order.

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

## M6 follow-up — Auto-caption + photo map markers (committed `059ee49`)

**Setup:** same `Testing/trip photos/` folder as above, but on a fresh trip OR after deleting the previously-imported photos so the dedupe doesn't skip them.

**Auto-caption from reverse geocode:**
1. Open the batch-import dialog and drop the photos.
2. As the preview rows render, each one's caption input shows **"Looking up location…"** as placeholder.
3. Within a few seconds (3 concurrent geocodes), captions fill in with the place name from Nominatim — e.g. *"Sydney Opera House"*, *"George Street"*, etc.
4. Edit any caption inline before clicking Import. Confirmed captions are stored on `day_photos.caption`.
5. After import, hover a photo's `figcaption` in the day grid → confirm the auto-caption is showing.

**Photo markers on the trip Map:**
6. After import, switch to the trip's **Plan** tab.
7. Geotagged photos render as small **red camera icons** on the map alongside the place markers.
8. Hover a marker → tooltip shows the caption (or original filename).
9. Click a marker → the day-plan sidebar should expand the photo's day. Scroll the sidebar to find the day if it's not visible — the photo grid should show the relevant photo.

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
