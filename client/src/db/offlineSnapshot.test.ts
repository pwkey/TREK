// [460-fork] M1 follow-up — tests for the OPFS snapshot module.
//
// fake-indexeddb gives us IndexedDB; OPFS we mock here with a tiny
// in-memory FileSystemDirectoryHandle shim so the module under test
// can write/read/delete files without a real browser.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { _resetForTests } from './localDb'
import { enqueue, peek, clear } from './mutationQueue'
import {
  writeSnapshotNow,
  readSnapshot,
  restoreFromSnapshot,
  clearSnapshot,
  _flushSnapshotDebounceForTests,
} from './offlineSnapshot'

// ---------------------------------------------------------------------------
// In-memory OPFS shim
// ---------------------------------------------------------------------------

interface FakeFile {
  contents: string
}

class FakeWritableStream {
  constructor(private file: FakeFile) {}
  // OPFS createWritable returns a fresh stream that overwrites on close.
  // Track buffered writes so multiple write()s before close() concat.
  private buf = ''
  async write(chunk: string | ArrayBuffer | Blob): Promise<void> {
    if (typeof chunk === 'string') this.buf += chunk
    else if (chunk instanceof ArrayBuffer) this.buf += new TextDecoder().decode(chunk)
    else this.buf += await chunk.text()
  }
  async close(): Promise<void> { this.file.contents = this.buf }
}

class FakeFileHandle {
  constructor(private fileRef: FakeFile) {}
  async getFile(): Promise<{ text(): Promise<string> }> {
    return { text: async () => this.fileRef.contents }
  }
  async createWritable(): Promise<FakeWritableStream> {
    return new FakeWritableStream(this.fileRef)
  }
}

class FakeDirectory {
  files = new Map<string, FakeFile>()
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let f = this.files.get(name)
    if (!f) {
      if (!opts?.create) throw new Error(`NotFoundError: ${name}`)
      f = { contents: '' }
      this.files.set(name, f)
    }
    return new FakeFileHandle(f)
  }
  async removeEntry(name: string): Promise<void> {
    this.files.delete(name)
  }
}

let fakeRoot: FakeDirectory

function installFakeOpfs() {
  fakeRoot = new FakeDirectory()
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => fakeRoot,
      persist: async () => true,
      estimate: async () => ({ usage: 0, quota: 1024 * 1024 * 1024 }),
    },
  })
}

function uninstallOpfs() {
  vi.stubGlobal('navigator', { storage: undefined })
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

beforeEach(async () => {
  installFakeOpfs()
  await _resetForTests()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('460tp-local')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('offlineSnapshot', () => {
  it('SNAP-001 — writeSnapshotNow with empty queue removes any existing snapshot', async () => {
    await enqueue({ endpoint: '/foo', method: 'POST' })
    await writeSnapshotNow()
    expect(fakeRoot.files.has('460tp-queue-snapshot.json')).toBe(true)

    await clear()
    await writeSnapshotNow()
    expect(fakeRoot.files.has('460tp-queue-snapshot.json')).toBe(false)
  })

  it('SNAP-002 — writeSnapshotNow stores every queued mutation', async () => {
    await enqueue({ endpoint: '/a', method: 'POST', payload: { x: 1 } })
    await enqueue({ endpoint: '/b', method: 'PUT', payload: { y: 2 } })
    await writeSnapshotNow()

    const snap = await readSnapshot()
    expect(snap).not.toBeNull()
    expect(snap!.v).toBe(1)
    expect(snap!.mutations).toHaveLength(2)
    const endpoints = snap!.mutations.map(m => m.endpoint).sort()
    expect(endpoints).toEqual(['/a', '/b'])
  })

  it('SNAP-003 — restoreFromSnapshot replays mutations when live queue is empty', async () => {
    await enqueue({ endpoint: '/lost-edit', method: 'PUT', payload: { content: 'offline' } })
    await writeSnapshotNow()

    // Simulate iOS evicting our IndexedDB by clearing the queue store.
    await clear()
    expect(await peek()).toHaveLength(0)

    const result = await restoreFromSnapshot()
    expect(result.restored).toBe(1)
    const restored = await peek()
    expect(restored).toHaveLength(1)
    expect(restored[0].endpoint).toBe('/lost-edit')
    expect(restored[0].payload).toEqual({ content: 'offline' })
  })

  it('SNAP-004 — restoreFromSnapshot is a no-op when live queue is non-empty', async () => {
    await enqueue({ endpoint: '/a', method: 'POST' })
    await writeSnapshotNow()

    // Live queue still has a row — don't overwrite / duplicate.
    const result = await restoreFromSnapshot()
    expect(result.restored).toBe(0)
    expect(result.reason).toBe('live-queue-not-empty')
    expect(await peek()).toHaveLength(1)
  })

  it('SNAP-005 — restoreFromSnapshot is a no-op when there is no snapshot', async () => {
    const result = await restoreFromSnapshot()
    expect(result.restored).toBe(0)
    expect(result.reason).toBe('no-snapshot')
  })

  it('SNAP-006 — clearSnapshot removes the OPFS file', async () => {
    await enqueue({ endpoint: '/x', method: 'POST' })
    await writeSnapshotNow()
    expect(fakeRoot.files.has('460tp-queue-snapshot.json')).toBe(true)
    await clearSnapshot()
    expect(fakeRoot.files.has('460tp-queue-snapshot.json')).toBe(false)
  })

  it('SNAP-007 — writeSnapshotNow returns false on browsers without OPFS', async () => {
    uninstallOpfs()
    await enqueue({ endpoint: '/x', method: 'POST' })
    const ok = await writeSnapshotNow()
    expect(ok).toBe(false)
  })

  it('SNAP-008 — restoreFromSnapshot returns opfs-unsupported reason without OPFS', async () => {
    uninstallOpfs()
    const result = await restoreFromSnapshot()
    expect(result.restored).toBe(0)
    expect(result.reason).toBe('opfs-unsupported')
  })

  it('SNAP-009 — debounced scheduleSnapshot writes via _flushSnapshotDebounceForTests', async () => {
    await enqueue({ endpoint: '/queued', method: 'POST' })
    // enqueue() already calls scheduleSnapshot internally; flush it.
    await _flushSnapshotDebounceForTests()
    const snap = await readSnapshot()
    expect(snap).not.toBeNull()
    expect(snap!.mutations).toHaveLength(1)
  })

  it('SNAP-010 — corrupt snapshot returns null', async () => {
    fakeRoot.files.set('460tp-queue-snapshot.json', { contents: '{not valid json' })
    const snap = await readSnapshot()
    expect(snap).toBeNull()
    const result = await restoreFromSnapshot()
    expect(result.restored).toBe(0)
    expect(result.reason).toBe('no-snapshot')
  })
})
