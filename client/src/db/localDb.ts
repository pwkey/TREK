// [460-fork] Milestone 5 — IndexedDB mirror for offline-first reads.
//
// Tier 1 of the OQ-D storage model: trip data + journal thumbnails (~300 px),
// capped at ~50 MB total. Tiers 2 (Capacitor filesystem for full-res photos)
// and 3 (Workbox precache for laptop offline downloads) are documented in the
// M5 plan §3 and ship with M6.
//
// Slice 1 scope: read-side mirror only. The mutation queue and write-through
// optimism land in slice 2.

import { openDB, type IDBPDatabase, type DBSchema } from 'idb'

export const DB_NAME = '460tp-local'
export const DB_VERSION = 3

interface TripRecord {
  id: number
  name?: string
  start_date?: string | null
  end_date?: string | null
  /** Server's updated_at when we last synced, used as the snapshot for OQ-E
   *  conflict precondition. */
  _updated_at?: string
  /** When we last persisted from server. Drives LRU eviction on quota errors. */
  _cached_at: number
  [key: string]: unknown
}

interface DayRecord {
  id: number
  trip_id: number
  date?: string | null
  title?: string | null
  notes?: string | null
  segment_id?: string | null
  _updated_at?: string
  _cached_at: number
  [key: string]: unknown
}

interface IndexedRecord {
  id: number
  trip_id: number
  _cached_at: number
  [key: string]: unknown
}

interface MetaRecord {
  key: string
  value: unknown
}

// [460-fork] M14 slice 3 — photos held back from upload while Data-saver is on.
// The downscaled JPEG blob is stored so the upload can replay later from disk,
// surviving reloads and PWA restarts. Keyed by a client UUID.
export interface PendingPhotoRecord {
  id: string
  trip_id: number
  day_id: number
  blob: Blob
  filename: string
  caption?: string
  taken_at?: string | null
  lat?: number | null
  lng?: number | null
  altitude?: number | null
  camera?: string | null
  created_at: number
}

export interface QueuedMutationRecord {
  id: string
  endpoint: string
  method: 'POST' | 'PUT' | 'DELETE'
  payload: unknown
  /** Optional record-level updated_at observed at queue time, sent as the
   *  conflict precondition when the mutation eventually replays. */
  observed_updated_at?: string | null
  created_at: number
  attempts: number
  /** When the next retry is allowed (epoch ms). Used to back off failures. */
  next_attempt_at: number
  last_error: string | null
  /** 'pending' | 'failed' (max attempts reached) — UI surfaces 'failed' for
   *  user resolution. */
  status: 'pending' | 'failed'
}

interface LocalDb extends DBSchema {
  trips: { key: number; value: TripRecord }
  days: { key: number; value: DayRecord; indexes: { 'by-trip': number } }
  places: { key: number; value: IndexedRecord; indexes: { 'by-trip': number } }
  assignments: { key: number; value: IndexedRecord; indexes: { 'by-trip': number } }
  dayNotes: { key: number; value: IndexedRecord; indexes: { 'by-trip': number } }
  reservations: { key: number; value: IndexedRecord; indexes: { 'by-trip': number } }
  mutations: { key: string; value: QueuedMutationRecord }
  pendingPhotos: { key: string; value: PendingPhotoRecord; indexes: { 'by-trip': number } }
  _meta: { key: string; value: MetaRecord }
}

export type LocalDbHandle = IDBPDatabase<LocalDb>

let _dbPromise: Promise<LocalDbHandle> | null = null

export function getDb(): Promise<LocalDbHandle> {
  if (!_dbPromise) {
    _dbPromise = openDB<LocalDb>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Forward-only migration. The pattern matches the server-side
        // approach in db/migrations.ts: each version bumps the schema in
        // an additive way.
        if (oldVersion < 1) {
          db.createObjectStore('trips', { keyPath: 'id' })
          db.createObjectStore('days', { keyPath: 'id' }).createIndex('by-trip', 'trip_id')
          db.createObjectStore('places', { keyPath: 'id' }).createIndex('by-trip', 'trip_id')
          db.createObjectStore('assignments', { keyPath: 'id' }).createIndex('by-trip', 'trip_id')
          db.createObjectStore('dayNotes', { keyPath: 'id' }).createIndex('by-trip', 'trip_id')
          db.createObjectStore('reservations', { keyPath: 'id' }).createIndex('by-trip', 'trip_id')
          db.createObjectStore('_meta', { keyPath: 'key' })
        }
        if (oldVersion < 2) {
          // Slice 2 — persistent mutation queue.
          db.createObjectStore('mutations', { keyPath: 'id' })
        }
        if (oldVersion < 3) {
          // [460-fork] M14 slice 3 — photo uploads held for Wi-Fi.
          db.createObjectStore('pendingPhotos', { keyPath: 'id' }).createIndex('by-trip', 'trip_id')
        }
      },
    })
  }
  return _dbPromise
}

/**
 * Test-only reset. Closes the existing handle so the next getDb() call
 * reopens. Used by Vitest helpers to guarantee a clean slate per test.
 */
export async function _resetForTests(): Promise<void> {
  if (_dbPromise) {
    const db = await _dbPromise
    db.close()
    _dbPromise = null
  }
}

// ---------------------------------------------------------------------------
// Write-through helpers — bulk-replace a trip's mirrored data
// ---------------------------------------------------------------------------

export interface TripSnapshot {
  trip: TripRecord
  days?: Array<Omit<DayRecord, '_cached_at'>>
  places?: Array<Omit<IndexedRecord, '_cached_at'> & { trip_id: number }>
  assignments?: Array<Omit<IndexedRecord, '_cached_at'> & { trip_id: number }>
  dayNotes?: Array<Omit<IndexedRecord, '_cached_at'> & { trip_id: number }>
  reservations?: Array<Omit<IndexedRecord, '_cached_at'> & { trip_id: number }>
}

/**
 * Bulk-replace a trip's cached records. Called from tripStore whenever the
 * planner has just pulled fresh data from the server. Existing records for
 * the trip in the listed stores are deleted first so the local mirror can't
 * silently retain rows the server has since deleted.
 */
export async function writeTripSnapshot(snapshot: TripSnapshot): Promise<void> {
  const db = await getDb()
  const now = Date.now()
  const tripId = snapshot.trip.id
  const stores = ['trips', 'days', 'places', 'assignments', 'dayNotes', 'reservations'] as const
  const tx = db.transaction(stores, 'readwrite')

  await tx.objectStore('trips').put({ ...snapshot.trip, _cached_at: now })

  for (const storeName of ['days', 'places', 'assignments', 'dayNotes', 'reservations'] as const) {
    const store = tx.objectStore(storeName)
    // Delete existing rows for this trip via the index.
    const idx = store.index('by-trip')
    let cursor = await idx.openCursor(IDBKeyRange.only(tripId))
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }
  }

  if (snapshot.days) {
    const store = tx.objectStore('days')
    for (const d of snapshot.days) await store.put({ ...d, _cached_at: now } as DayRecord)
  }
  if (snapshot.places) {
    const store = tx.objectStore('places')
    for (const p of snapshot.places) await store.put({ ...p, _cached_at: now } as IndexedRecord)
  }
  if (snapshot.assignments) {
    const store = tx.objectStore('assignments')
    for (const a of snapshot.assignments) await store.put({ ...a, _cached_at: now } as IndexedRecord)
  }
  if (snapshot.dayNotes) {
    const store = tx.objectStore('dayNotes')
    for (const n of snapshot.dayNotes) await store.put({ ...n, _cached_at: now } as IndexedRecord)
  }
  if (snapshot.reservations) {
    const store = tx.objectStore('reservations')
    for (const r of snapshot.reservations) await store.put({ ...r, _cached_at: now } as IndexedRecord)
  }

  await tx.done
}

/**
 * Read a previously-cached trip snapshot. Returns null if the trip isn't in
 * the local mirror. Used at cold-start so a refresh while offline still
 * shows the planner with whatever was last seen.
 */
export async function readTripSnapshot(tripId: number): Promise<TripSnapshot | null> {
  const db = await getDb()
  const trip = await db.get('trips', tripId)
  if (!trip) return null
  const [days, places, assignments, dayNotes, reservations] = await Promise.all([
    db.getAllFromIndex('days', 'by-trip', tripId),
    db.getAllFromIndex('places', 'by-trip', tripId),
    db.getAllFromIndex('assignments', 'by-trip', tripId),
    db.getAllFromIndex('dayNotes', 'by-trip', tripId),
    db.getAllFromIndex('reservations', 'by-trip', tripId),
  ])
  return { trip, days, places, assignments, dayNotes, reservations }
}

// ---------------------------------------------------------------------------
// Tier-1 quota guard
// ---------------------------------------------------------------------------

/**
 * Approximate Tier 1 budget — 50 MB. Browsers expose total quota, not
 * per-DB, so we use this as a logical hint plus on-quota-error eviction.
 */
export const TIER_1_BUDGET_BYTES = 50 * 1024 * 1024

/**
 * LRU eviction on quota errors. Removes the oldest non-active trip's
 * mirror until the call to `tryAgain` succeeds OR there's nothing left
 * to evict. `activeTripId` is whatever the user is currently looking at.
 */
export async function evictUntilFits(activeTripId: number, tryAgain: () => Promise<void>): Promise<boolean> {
  const db = await getDb()
  // Sort cached trips by _cached_at ascending; skip the active one.
  const trips = (await db.getAll('trips'))
    .filter(t => t.id !== activeTripId)
    .sort((a, b) => a._cached_at - b._cached_at)
  for (const oldest of trips) {
    await deleteTripFromMirror(oldest.id)
    try {
      await tryAgain()
      return true
    } catch {
      // Still over quota — keep evicting.
    }
  }
  return false
}

async function deleteTripFromMirror(tripId: number): Promise<void> {
  const db = await getDb()
  const stores = ['days', 'places', 'assignments', 'dayNotes', 'reservations'] as const
  const tx = db.transaction(['trips', ...stores], 'readwrite')
  await tx.objectStore('trips').delete(tripId)
  for (const storeName of stores) {
    const store = tx.objectStore(storeName)
    const idx = store.index('by-trip')
    let cursor = await idx.openCursor(IDBKeyRange.only(tripId))
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }
  }
  await tx.done
}
