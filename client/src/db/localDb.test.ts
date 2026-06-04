// [460-fork] Milestone 5 — minimal smoke test for the local mirror.
import { describe, it, expect, beforeEach } from 'vitest'
import { _resetForTests, getDb, readTripSnapshot, writeTripSnapshot } from './localDb'

beforeEach(async () => {
  await _resetForTests()
  // fake-indexeddb persists between tests in the same module; reset by
  // deleting the database explicitly.
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('460tp-local')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
})

describe('localDb', () => {
  it('opens, creates the expected object stores', async () => {
    const db = await getDb()
    const stores = Array.from(db.objectStoreNames).sort()
    expect(stores).toEqual(['_meta', 'assignments', 'dayNotes', 'days', 'mutations', 'pendingPhotos', 'places', 'reservations', 'trips'])
  })

  it('round-trips a trip snapshot', async () => {
    await writeTripSnapshot({
      trip: { id: 1, _cached_at: 0, name: 'Europe 2027' },
      days: [
        { id: 10, trip_id: 1, date: '2027-06-10', _cached_at: 0 } as any,
        { id: 11, trip_id: 1, date: '2027-06-11', _cached_at: 0 } as any,
      ],
      places: [
        { id: 100, trip_id: 1, _cached_at: 0, name: 'Café de Flore' } as any,
      ],
    })
    const snap = await readTripSnapshot(1)
    expect(snap).not.toBeNull()
    expect(snap!.trip.name).toBe('Europe 2027')
    expect(snap!.days).toHaveLength(2)
    expect(snap!.places).toHaveLength(1)
    expect(snap!.places![0].name).toBe('Café de Flore')
  })

  it('returns null for an un-cached trip', async () => {
    expect(await readTripSnapshot(999)).toBeNull()
  })

  it('replaces — a second writeTripSnapshot wipes the trip\'s previous rows', async () => {
    await writeTripSnapshot({
      trip: { id: 1, _cached_at: 0, name: 't1' },
      days: [{ id: 10, trip_id: 1, date: '2027-06-10', _cached_at: 0 } as any],
      places: [{ id: 100, trip_id: 1, _cached_at: 0 } as any],
    })
    await writeTripSnapshot({
      trip: { id: 1, _cached_at: 0, name: 't1-fresh' },
      days: [{ id: 99, trip_id: 1, date: '2027-06-12', _cached_at: 0 } as any],
      // No places this time — old place should be evicted.
    })
    const snap = await readTripSnapshot(1)
    expect(snap!.trip.name).toBe('t1-fresh')
    expect(snap!.days!.map(d => d.id)).toEqual([99])
    expect(snap!.places).toEqual([])
  })

  it('isolates trips — writing trip 1 does not delete trip 2\'s rows', async () => {
    await writeTripSnapshot({
      trip: { id: 1, _cached_at: 0, name: 't1' },
      days: [{ id: 10, trip_id: 1, date: '2027-06-10', _cached_at: 0 } as any],
    })
    await writeTripSnapshot({
      trip: { id: 2, _cached_at: 0, name: 't2' },
      days: [{ id: 20, trip_id: 2, date: '2027-07-10', _cached_at: 0 } as any],
    })
    const t1 = await readTripSnapshot(1)
    const t2 = await readTripSnapshot(2)
    expect(t1!.days!.map(d => d.id)).toEqual([10])
    expect(t2!.days!.map(d => d.id)).toEqual([20])
  })
})
