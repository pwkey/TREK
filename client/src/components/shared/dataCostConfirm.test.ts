// [460-fork] M14 slice 2 — data-cost warning thresholds.
import { describe, it, expect } from 'vitest'
import { shouldWarnDataCost, formatBytes, ACTIVE_WARN_FLOOR, ALWAYS_WARN_FLOOR } from './dataCostConfirm'

describe('shouldWarnDataCost', () => {
  describe('Data-saver active', () => {
    it('warns for transfers at/over the 1 MB metered floor', () => {
      expect(shouldWarnDataCost(ACTIVE_WARN_FLOOR, true)).toBe(true)
      expect(shouldWarnDataCost(5_000_000, true)).toBe(true)
    })
    it('stays quiet for tiny transfers', () => {
      expect(shouldWarnDataCost(100_000, true)).toBe(false)
    })
    it('warns when the size is unknown', () => {
      expect(shouldWarnDataCost(null, true)).toBe(true)
    })
    it('warns for inherently-large ops regardless of size', () => {
      expect(shouldWarnDataCost(0, true, true)).toBe(true)
    })
  })

  describe('Data-saver off', () => {
    it('only warns for genuinely large (>=25 MB) transfers', () => {
      expect(shouldWarnDataCost(ALWAYS_WARN_FLOOR, false)).toBe(true)
      expect(shouldWarnDataCost(5_000_000, false)).toBe(false)
    })
    it('does not warn for unknown size (avoids friction on Wi-Fi)', () => {
      expect(shouldWarnDataCost(null, false)).toBe(false)
    })
    it('does not warn for inherently-large ops when size is small/unknown', () => {
      expect(shouldWarnDataCost(null, false, true)).toBe(false)
      expect(shouldWarnDataCost(1_000, false, true)).toBe(false)
    })
  })
})

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(12_000)).toBe('12 KB')
    expect(formatBytes(2_500_000)).toBe('2.5 MB')
    expect(formatBytes(40_000_000)).toBe('40 MB')
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB')
  })
  it('returns empty for unknown/infinite so the caller picks no-size copy', () => {
    expect(formatBytes(null)).toBe('')
    expect(formatBytes(Infinity)).toBe('')
  })
})
