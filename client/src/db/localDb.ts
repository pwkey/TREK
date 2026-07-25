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
export const DB_VERSION = 4

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
  // [460-fork] M5 follow-up — the three list surfaces, mirrored so a trip is
  // fully usable offline (not just its itinerary). Photos stay opt-in.
  packing: { key: number; value: IndexedRecord; indexes: { 'by-trip': number } }
  todo: { key: number; value: IndexedRecord; indexes: { 'by-trip': number } }
  budget: { key: number; value: IndexedRecord; indexes: { 'by-trip': number } }
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
        if (oldVersion < 4) {
          // [460-fork] M5 follow-up — mirror bookings + the three lists so a
          // trip opened online is fully usable offline, not just its itinerary.
          db.createObjectStore('packing', { keyPath: 'id' }).createIndex('by-trip', 'trip_id')
          db.createObjectStore('todo', { keyPath: 'id' }).createIndex('by-trip', 'trip_id')
          db.createObjectStore('budget', { keyPath: 'id' }).createIndex('by-trip', 'trip_id')
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

type SnapshotList = Array<Omit<IndexedRecord, '_cached_at'> & { trip_id?: number }>

export interface TripSnapshot {
  trip: TripRecord
  days?: Array<Omit<DayRecord, '_cached_at'>>
  places?: SnapshotList
  assignments?: SnapshotList
  dayNotes?: SnapshotList
  reservations?: SnapshotList
  packing?: SnapshotList
  todo?: SnapshotList
  budget?: SnapshotList
}

/** The trip-scoped list stores, in one place so write/read/mirror agree. */
const LIST_STORES = ['days', 'places', 'assignments', 'dayNotes', 'reservations', 'packing', 'todo', 'budget'] as const
type ListStore = (typeof LIST_STORES)[number]

/**
 * Replace a trip's cached rows in one store: delete everything for the trip,
 * then write the supplied rows (stamped with trip_id + _cached_at). Shared by
 * writeTripSnapshot and mirrorTripLists so the delete-then-write is identical.
 */
async function replaceStoreRows(
  tx: Awaited<ReturnType<LocalDbHandle['transaction']>>,
  storeName: ListStore,
  tripId: number,
  rows: SnapshotList,
  now: number,
): Promise<void> {
  const store = tx.objectStore(storeName)
  let cursor = await store.index('by-trip').openCursor(IDBKeyRange.only(tripId))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  for (const row of rows) await store.put({ ...row, trip_id: tripId, _cached_at: now } as never)
}

/**
 * Bulk-replace a trip's cached records. Called from tripStore whenever the
 * planner has just pulled fresh data from the server.
 *
 * A store is only touched when its array is **provided**. A missing key leaves
 * that store's cached rows alone — so a partial snapshot (e.g. itinerary only,
 * before the Book/Budget tabs have loaded) can't silently wipe the bookings or
 * budget cached from a previous session.
 */
export async function writeTripSnapshot(snapshot: TripSnapshot): Promise<void> {
  const db = await getDb()
  const now = Date.now()
  const tripId = snapshot.trip.id
  const tx = db.transaction(['trips', ...LIST_STORES], 'readwrite')

  await tx.objectStore('trips').put({ ...snapshot.trip, _cached_at: now })

  const provided: Record<ListStore, SnapshotList | undefined> = {
    days: snapshot.days as SnapshotList | undefined,
    places: snapshot.places,
    assignments: snapshot.assignments,
    dayNotes: snapshot.dayNotes,
    reservations: snapshot.reservations,
    packing: snapshot.packing,
    todo: snapshot.todo,
    budget: snapshot.budget,
  }
  for (const storeName of LIST_STORES) {
    const rows = provided[storeName]
    if (rows === undefined) continue // not provided → leave cached rows intact
    await replaceStoreRows(tx, storeName, tripId, rows, now)
  }

  await tx.done
}

/**
 * Update just the list stores for a trip (bookings / packing / to-do / budget),
 * without touching the cached trip row. Called from the slices that load those
 * lists on their own (they arrive after the main planner fetch). Only provided
 * lists are replaced; the rest are left alone.
 */
export async function mirrorTripLists(
  tripId: number,
  lists: { reservations?: SnapshotList; packing?: SnapshotList; todo?: SnapshotList; budget?: SnapshotList },
): Promise<void> {
  const entries = (Object.entries(lists) as [ListStore, SnapshotList | undefined][]).filter(
    ([, v]) => v !== undefined,
  ) as [ListStore, SnapshotList][]
  if (entries.length === 0) return
  const db = await getDb()
  const now = Date.now()
  const tx = db.transaction(entries.map(([s]) => s), 'readwrite')
  for (const [storeName, rows] of entries) await replaceStoreRows(tx, storeName, tripId, rows, now)
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
  const [days, places, assignments, dayNotes, reservations, packing, todo, budget] = await Promise.all([
    db.getAllFromIndex('days', 'by-trip', tripId),
    db.getAllFromIndex('places', 'by-trip', tripId),
    db.getAllFromIndex('assignments', 'by-trip', tripId),
    db.getAllFromIndex('dayNotes', 'by-trip', tripId),
    db.getAllFromIndex('reservations', 'by-trip', tripId),
    db.getAllFromIndex('packing', 'by-trip', tripId),
    db.getAllFromIndex('todo', 'by-trip', tripId),
    db.getAllFromIndex('budget', 'by-trip', tripId),
  ])
  return { trip, days, places, assignments, dayNotes, reservations, packing, todo, budget }
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
