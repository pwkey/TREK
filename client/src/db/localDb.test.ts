// [460-fork] Milestone 5 — minimal smoke test for the local mirror.
import { describe, it, expect, beforeEach } from 'vitest'
import { _resetForTests, getDb, readTripSnapshot, writeTripSnapshot, mirrorTripLists } from './localDb'

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
    expect(stores).toEqual(['_meta', 'assignments', 'budget', 'dayNotes', 'days', 'mutations', 'packing', 'pendingPhotos', 'places', 'reservations', 'todo', 'trips'])
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

  it('replaces a PROVIDED store, but leaves an OMITTED store intact', async () => {
    await writeTripSnapshot({
      trip: { id: 1, _cached_at: 0, name: 't1' },
      days: [{ id: 10, trip_id: 1, date: '2027-06-10', _cached_at: 0 } as any],
      places: [{ id: 100, trip_id: 1, _cached_at: 0 } as any],
    })
    await writeTripSnapshot({
      trip: { id: 1, _cached_at: 0, name: 't1-fresh' },
      days: [{ id: 99, trip_id: 1, date: '2027-06-12', _cached_at: 0 } as any],
      // places OMITTED — the earlier cached place must survive (a partial,
      // itinerary-only snapshot must never wipe another store's cache).
    })
    const snap = await readTripSnapshot(1)
    expect(snap!.trip.name).toBe('t1-fresh')
    expect(snap!.days!.map(d => d.id)).toEqual([99]) // provided → replaced
    expect(snap!.places!.map(p => p.id)).toEqual([100]) // omitted → kept
  })

  it('an explicitly empty array DOES wipe (server says zero rows)', async () => {
    await writeTripSnapshot({
      trip: { id: 1, _cached_at: 0, name: 't1' },
      places: [{ id: 100, trip_id: 1, _cached_at: 0 } as any],
    })
    await writeTripSnapshot({ trip: { id: 1, _cached_at: 0, name: 't1' }, places: [] })
    const snap = await readTripSnapshot(1)
    expect(snap!.places).toEqual([])
  })

  it('round-trips bookings + the three lists', async () => {
    await writeTripSnapshot({
      trip: { id: 1, _cached_at: 0, name: 'Morocco' },
      reservations: [{ id: 5, trip_id: 1, _cached_at: 0, title: 'Intrepid tour' } as any],
      packing: [{ id: 6, trip_id: 1, _cached_at: 0, name: 'Headscarf' } as any],
      todo: [{ id: 7, trip_id: 1, _cached_at: 0, name: 'Book Majorelle' } as any],
      budget: [{ id: 8, trip_id: 1, _cached_at: 0, name: 'Camel ride' } as any],
    })
    const snap = await readTripSnapshot(1)
    expect(snap!.reservations!.map(r => (r as any).title)).toEqual(['Intrepid tour'])
    expect(snap!.packing!.map(p => (p as any).name)).toEqual(['Headscarf'])
    expect(snap!.todo!.map(t => (t as any).name)).toEqual(['Book Majorelle'])
    expect(snap!.budget!.map(b => (b as any).name)).toEqual(['Camel ride'])
  })

  it('mirrorTripLists updates a single list without touching trip/days', async () => {
    await writeTripSnapshot({
      trip: { id: 1, _cached_at: 0, name: 'Morocco' },
      days: [{ id: 10, trip_id: 1, _cached_at: 0 } as any],
      reservations: [{ id: 5, trip_id: 1, _cached_at: 0, title: 'old' } as any],
    })
    await mirrorTripLists(1, { reservations: [{ id: 5, trip_id: 1, title: 'updated' } as any] })
    const snap = await readTripSnapshot(1)
    expect(snap!.trip.name).toBe('Morocco')        // trip untouched
    expect(snap!.days!.map(d => d.id)).toEqual([10]) // days untouched
    expect((snap!.reservations![0] as any).title).toBe('updated')
  })

  it('mirrorTripLists leaves un-listed stores alone', async () => {
    await writeTripSnapshot({
      trip: { id: 1, _cached_at: 0, name: 'Morocco' },
      packing: [{ id: 6, trip_id: 1, _cached_at: 0, name: 'Headscarf' } as any],
    })
    await mirrorTripLists(1, { budget: [{ id: 8, trip_id: 1, name: 'Camel' } as any] })
    const snap = await readTripSnapshot(1)
    expect(snap!.packing!.map(p => (p as any).name)).toEqual(['Headscarf']) // not wiped
    expect(snap!.budget!.map(b => (b as any).name)).toEqual(['Camel'])
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
