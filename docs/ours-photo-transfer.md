# Getting photos off your phone with EXIF intact

460 Trip Planner reads EXIF metadata (capture date, GPS, altitude, camera) and uses it to:

- order photos chronologically in the memoir view,
- plot geotagged photos on the per-day mini-map,
- show a 📍 icon with coordinates / altitude / camera attribution on each photo.

EXIF gets stripped or replaced by **most** photo-sharing paths. This is a quick reference for the methods that actually preserve it.

---

## Samsung (Android)

### ✅ Preserves EXIF

- **USB cable + File Explorer.** Plug the phone in, open `This PC → Samsung … → Phone → DCIM → Camera`, copy the `.jpg` files directly. No re-encoding, full EXIF.
- **microSD card eject** (if your phone uses one) — same idea, drop card in laptop reader.

### ❌ Strips or replaces EXIF

- WhatsApp, Telegram, Signal media share (any messaging app — they all transcode).
- Email "share with reduced size" options.
- Google Photos web download of an album zip — *sometimes* re-encodes.

---

## iPhone

### ✅ Preserves EXIF

- **AirDrop to Mac** (only Apple-to-Apple). Both EXIF and HEIC arrive intact.
- **USB cable + Image Capture** (macOS). The "Import to" panel copies files directly without conversion.
- **USB cable + Windows Photos import.** Confirmed to keep EXIF.
- **iCloud Photos download** of the original (right-click an asset on iCloud.com → Download → Original).

### ❌ Strips or replaces EXIF

- iMessage and most social apps.
- Mail attachment with "Small / Medium / Large" sizing — only **Actual Size** keeps EXIF.
- Any "share" path that goes through a third-party app's compression.

---

## After transferring

1. Drop the photos into 460 Trip Planner via the **Upload** button or drag-and-drop on the day's Photo grid.
2. The 📍 chip on each photo means EXIF GPS was preserved. Hover for coordinates / altitude / camera. If a photo you expected to be geotagged shows no chip, the location was likely stripped during transfer — go back and try one of the methods above.
3. HEIC photos from iPhone are auto-converted to JPEG client-side (via `heic2any`) before upload, so you don't have to convert first. EXIF is read from the original HEIC before conversion.

---

## Future: cutting out the transfer step

Once Milestone 1 (Capacitor native wrapper) ships, the trip planner will be able to:

- Receive photos directly from the iOS / Android Share Sheet (no laptop intermediate step).
- Read the device's camera roll and offer "12 photos taken on this date — tap to add" prompts when you open a day.

Until then, the cable-or-AirDrop transfer is the cleanest path.
