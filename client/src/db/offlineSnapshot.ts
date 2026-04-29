// [460-fork] M1 follow-up — OPFS-backed defensive backup of the mutation queue.
//
// Why it exists:
//   Once installed as a home-screen PWA, iOS doesn't apply the 7-day
//   eviction policy that hits Safari tabs — but storage CAN still be
//   purged under storage pressure or after a manual site-data clear.
//   The only client-only data that's not recoverable from the server
//   is the mutation queue: pending writes the user made offline that
//   haven't synced yet.
//
//   This module mirrors the queue to OPFS (Origin Private File System)
//   on every change, debounced. OPFS lives in a separate browser-managed
//   storage area and is less prone to eviction than IndexedDB. On cold
//   start, if IndexedDB's queue is empty (or has been wiped) but OPFS
//   has a non-empty snapshot, we restore.
//
//   This is best-effort, not bulletproof — OPFS is also subject to
//   storage-pressure eviction. The bulletproof option (one-tap "Save
//   to Files" export) is a separate UI surface; this is the silent
//   auto-protection layer.
//
// What gets snapshotted:
//   The mutation queue rows themselves. Trip data isn't included
//   because the server is its source of truth — restored on next online
//   load. Photo blobs that haven't uploaded ARE in the queue payload
//   (FormData → axios → JSON-stringified by the request interceptor),
//   so they're covered.

import { getDb, type QueuedMutationRecord } from './localDb'

const SNAPSHOT_FILE = '460tp-queue-snapshot.json'
const DEBOUNCE_MS = 5_000

interface QueueSnapshot {
  /** Schema version so future shape changes can migrate or discard. */
  v: 1
  /** Epoch ms at write time — used to decide stale vs fresh on restore. */
  written_at: number
  /** Snapshot of every queued mutation at write time. */
  mutations: QueuedMutationRecord[]
}

function opfsAvailable(): boolean {
  if (typeof navigator === 'undefined') return false
  // `getDirectory` is the OPFS entry point. iOS Safari 15.2+, Chrome 86+,
  // Firefox 111+, Edge 86+. Older Safari returns undefined.
  return typeof (navigator.storage as StorageManager & { getDirectory?: () => Promise<unknown> })?.getDirectory === 'function'
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsAvailable()) return null
  try {
    return await navigator.storage.getDirectory()
  } catch {
    return null
  }
}

async function writeOpfsFile(name: string, contents: string): Promise<boolean> {
  const root = await getOpfsRoot()
  if (!root) return false
  try {
    const handle = await root.getFileHandle(name, { create: true })
    const writable = await (handle as FileSystemFileHandle & {
      createWritable: () => Promise<FileSystemWritableFileStream>
    }).createWritable()
    await writable.write(contents)
    await writable.close()
    return true
  } catch (err) {
    // Quota errors or transient OPFS failures — silent.
    console.warn('[offlineSnapshot] OPFS write failed:', err)
    return false
  }
}

async function readOpfsFile(name: string): Promise<string | null> {
  const root = await getOpfsRoot()
  if (!root) return null
  try {
    const handle = await root.getFileHandle(name)
    const file = await handle.getFile()
    return await file.text()
  } catch {
    // File doesn't exist or unreadable — equivalent to "no backup".
    return null
  }
}

async function deleteOpfsFile(name: string): Promise<void> {
  const root = await getOpfsRoot()
  if (!root) return
  try {
    await (root as FileSystemDirectoryHandle & {
      removeEntry: (name: string) => Promise<void>
    }).removeEntry(name)
  } catch {
    // Already gone — fine.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Write the current mutation queue to OPFS. Idempotent — overwrites. */
export async function writeSnapshotNow(): Promise<boolean> {
  if (!opfsAvailable()) return false
  const db = await getDb()
  const mutations = await db.getAll('mutations')
  // No queue → no point in keeping a snapshot. Clean up so we don't
  // restore stale data later.
  if (mutations.length === 0) {
    await deleteOpfsFile(SNAPSHOT_FILE)
    return true
  }
  const snapshot: QueueSnapshot = {
    v: 1,
    written_at: Date.now(),
    mutations,
  }
  return writeOpfsFile(SNAPSHOT_FILE, JSON.stringify(snapshot))
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null

/** Debounced writer — call freely from queue lifecycle hooks. */
export function scheduleSnapshot(): void {
  if (!opfsAvailable()) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void writeSnapshotNow().catch(() => {/* silent */})
  }, DEBOUNCE_MS)
}

/** Read the current snapshot, if any. Returns null when OPFS is
 *  unavailable, the file doesn't exist, or the contents are malformed. */
export async function readSnapshot(): Promise<QueueSnapshot | null> {
  const text = await readOpfsFile(SNAPSHOT_FILE)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as QueueSnapshot
    if (parsed.v !== 1 || !Array.isArray(parsed.mutations)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Cold-start restore. If IndexedDB's mutation queue is empty AND OPFS
 * has a non-empty snapshot, replay every queued mutation back into
 * IndexedDB. Returns the number of rows restored.
 *
 * Why "IndexedDB empty" as the trigger: a non-empty IndexedDB queue
 * IS the live state — replaying OPFS rows on top would create
 * duplicates if the queue has already moved on. The only scenario
 * we're protecting is the catastrophic "iOS purged our IndexedDB",
 * where the queue is empty because the storage area was wiped.
 */
export async function restoreFromSnapshot(): Promise<{ restored: number; reason?: string }> {
  if (!opfsAvailable()) return { restored: 0, reason: 'opfs-unsupported' }
  const snap = await readSnapshot()
  if (!snap) return { restored: 0, reason: 'no-snapshot' }
  if (snap.mutations.length === 0) return { restored: 0, reason: 'empty-snapshot' }

  const db = await getDb()
  const live = await db.getAll('mutations')
  if (live.length > 0) {
    return { restored: 0, reason: 'live-queue-not-empty' }
  }

  for (const m of snap.mutations) {
    await db.put('mutations', m)
  }
  return { restored: snap.mutations.length }
}

/** Clear the snapshot — used after a successful queue drain so we don't
 *  carry around mutations that have already synced. */
export async function clearSnapshot(): Promise<void> {
  await deleteOpfsFile(SNAPSHOT_FILE)
}

// Test-only — flush the debounce timer so unit tests don't have to
// fake-time the 5s wait.
export function _flushSnapshotDebounceForTests(): Promise<boolean> {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  return writeSnapshotNow()
}
