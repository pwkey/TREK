// [460-fork] M14 slice 3 — photo hold-queue persistence.
import { describe, it, expect, beforeEach } from 'vitest'
import { _resetForTests } from './localDb'
import {
  enqueuePhoto,
  listPendingPhotos,
  countPendingPhotos,
  removePendingPhoto,
} from './photoUploadQueue'

beforeEach(async () => {
  await _resetForTests()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('460tp-local')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
})

function jpeg(): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' })
}

describe('photoUploadQueue', () => {
  it('starts empty, enqueues, and counts', async () => {
    expect(await countPendingPhotos()).toBe(0)
    await enqueuePhoto({ trip_id: 1, day_id: 2, blob: jpeg(), filename: 'a.jpg' })
    await enqueuePhoto({ trip_id: 1, day_id: 3, blob: jpeg(), filename: 'b.jpg' })
    expect(await countPendingPhotos()).toBe(2)
  })

  it('persists the blob + metadata and removes by id', async () => {
    const rec = await enqueuePhoto({
      trip_id: 7, day_id: 9, blob: jpeg(), filename: 'x.jpg',
      caption: 'sunset', taken_at: '2026-07-30T18:00:00Z', lat: 31.6, lng: -8.0, altitude: null, camera: 'iPhone',
    })
    const all = await listPendingPhotos()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(rec.id)
    expect(all[0].trip_id).toBe(7)
    expect(all[0].day_id).toBe(9)
    expect(all[0].filename).toBe('x.jpg')
    expect(all[0].caption).toBe('sunset')
    expect(all[0].lat).toBe(31.6)
    expect(all[0].blob).toBeInstanceOf(Blob)
    expect(all[0].blob.size).toBe(4)

    await removePendingPhoto(rec.id)
    expect(await countPendingPhotos()).toBe(0)
  })

  it('assigns a unique id per enqueue', async () => {
    const a = await enqueuePhoto({ trip_id: 1, day_id: 1, blob: jpeg(), filename: 'a.jpg' })
    const b = await enqueuePhoto({ trip_id: 1, day_id: 1, blob: jpeg(), filename: 'a.jpg' })
    expect(a.id).not.toBe(b.id)
    expect(await countPendingPhotos()).toBe(2)
  })
})
