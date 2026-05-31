# Backup & restore runbook

How 460 Trip Planner's data is protected, and exactly how to get it back.
Written before loading the flagship multi-month Europe trip. Referenced by
CLAUDE.md §8 (export/import) and §12 (durability notes).

---

## Where the data lives

| Data | Location (in container) | Backed by |
|---|---|---|
| Everything relational (trips, days, places, segments, households, journals, expenses…) | SQLite file `/app/data/travel.db` | Coolify **persistent volume** |
| Uploaded files (photos, reservation PDFs, covers, avatars) | `/app/uploads/…` | Coolify **persistent volume** |
| Auto-backup ZIPs + pre-migration snapshots | `/app/data/backups/` | same volume |
| Auto-backup schedule setting | `/app/data/backup-settings.json` | same volume |

**Deploys do not touch this data.** A deploy rebuilds the *container*; the
volumes persist. Proven empirically: ~20+ redeploys during the build-out
never reset the admin account or any trip. So "losing data due to updates"
is not a risk for ordinary deploys.

---

## The layers of protection

### Layer 1 — Persistent volumes (automatic)
Survive every redeploy. Covers: deploys, container restarts, image rebuilds.
Does **not** cover: bad migrations, accidental deletion, VM/disk loss.

### Layer 2 — Pre-migration snapshot (automatic, shipped 2026-06-01)
Migrations run at container startup and are forward-only; some are
destructive. Before applying ANY pending migration, the server copies the
raw DB aside to `/app/data/backups/pre-migration-vX-to-vY-<timestamp>.db`
(last 10 kept). So a bad migration in a future deploy is always
recoverable. See `server/src/db/migrations.ts` → `snapshotBeforeMigrations`.

### Layer 3 — Daily auto-backup (automatic, on by default 2026-06-01)
A consistent snapshot (DB + all uploads) zipped to `/app/data/backups/`
every night at 02:00 (server TZ), 14-day retention. Toggle/adjust in the
admin panel (Backups), or via `PUT /api/backup/auto-settings`. Covers:
accidental deletion, app-level mistakes, point-in-time recovery.

### Layer 4 — Off-VM copy (SET UP ON THE LAPTOP — see below)
Layers 1–3 all live on the **same Hetzner volume**. If the VM or its disk
dies, they die with it — and this host has **no Hetzner backups enabled**
(synthetic-data-era decision, host-infrastructure.md). So an off-VM copy is
the load-bearing layer for "total host loss." We pull the nightly ZIP to
the laptop (and into a cloud-synced folder for a third copy).

### Layer 5 — Per-trip export bundle (manual, M7)
After entering a significant trip, use the **Archive** button on the
day-plan sidebar to export a `.zip` (trip.json + photos + standalone
`viewer.html`). Store it in personal cloud. This is human-readable forever,
independent of the whole 460TP stack — the ultimate insurance for the
flagship trip specifically. Do this once the Europe trip is entered, and
again at major milestones.

---

## Off-VM pull to the laptop (Layer 4 setup)

A laptop can't be reliably *pushed* to (intermittent, behind NAT), so the
laptop **pulls** on a schedule whenever it's on. Uses the existing SSH key
(no app credentials needed).

### One-time: find the volume's host path

```powershell
# Find the running 460tp container name (changes per deploy, so we only use
# it to discover the STABLE volume path):
ssh root@178.105.244.67 "docker ps --format '{{.Names}}\t{{.Image}}' | findstr /i trek"

# Then print where /app/data is mounted on the host (the Source path is stable):
ssh root@178.105.244.67 "docker inspect <container-name> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}' | findstr /app/data"
```

The `Source` for `/app/data` is the host path; backups are in its
`/backups` subdirectory. Note it down (e.g.
`/var/lib/docker/volumes/<name>/_data/backups`).

### The pull script (`460tp-backup-pull.ps1`)

```powershell
$VM        = "root@178.105.244.67"
$RemoteDir = "/var/lib/docker/volumes/<NAME>/_data/backups"   # from discovery above
# Point the local dir at a cloud-synced folder → laptop copy AND cloud copy in one:
$LocalDir  = "$env:USERPROFILE\OneDrive\460tp-backups"

New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
$newest = ssh $VM "ls -t $RemoteDir/*.zip 2>/dev/null | head -1"
if (-not $newest) { Write-Error "No backups found on VM"; exit 1 }
scp "${VM}:$newest" $LocalDir
Write-Host "Pulled $(Split-Path $newest -Leaf) to $LocalDir"
```

### Schedule it (Windows Task Scheduler)
- Action: `powershell -ExecutionPolicy Bypass -File C:\path\460tp-backup-pull.ps1`
- Trigger: Daily (e.g. 09:00).
- Settings: tick **"Run task as soon as possible after a scheduled start is
  missed"** so it catches up when the laptop next comes online, and **"Run
  whether user is logged on or not."**

---

## How to RESTORE (when you need it)

### From a daily ZIP (most common)
1. Admin panel → Backups → pick a backup → **Restore**, OR
   `POST /api/backup/restore/:filename`, OR upload a ZIP you pulled to the
   laptop via `POST /api/backup/upload-restore`.
   The server integrity-checks the DB, verifies required tables, swaps it
   in, and re-initialises — no manual file surgery.

### From a pre-migration `.db` snapshot (after a bad migration)
These are raw DB files, not ZIPs. SSH to the VM and, with the app stopped:
```bash
# in the volume's backups dir
cp pre-migration-vX-to-vY-<stamp>.db ../travel.db
# remove stale WAL/SHM so the restored file is authoritative
rm -f ../travel.db-wal ../travel.db-shm
```
Then start the app. (Or wrap the .db in a ZIP with the current `uploads/`
and use upload-restore.)

### From a per-trip export bundle (last resort / selective)
Dashboard → **Import** → drop the `.zip`. Creates fresh records (safe
default) — see CLAUDE.md §8.4.

---

## Pre-flight checklist before entering the flagship trip

1. [ ] Confirm volumes are mounted (Coolify → app → Persistent Storage shows `/app/data` + `/app/uploads`).
2. [ ] After the next deploy, confirm the startup log shows `Auto-Backup scheduled: daily …` (not "disabled").
3. [ ] Trigger one manual backup (admin panel → Backups → Create) and confirm a ZIP appears.
4. [ ] Set up + run the laptop pull script once; confirm the ZIP lands in the cloud-synced folder.
5. [ ] (After data entry) Export the trip bundle and store in personal cloud.

---

## Log
- **2026-06-01** — Shipped auto-backup-on-by-default + pre-migration snapshot
  (commit `6f8a31c2`). Documented off-VM laptop-pull (Layer 4) and restore
  procedures. Off-VM pull + Hetzner-backup decision still to be actioned by
  the user.
