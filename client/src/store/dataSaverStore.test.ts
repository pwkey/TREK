// [460-fork] M14 slice 1 — effective-state matrix for Data-saver mode.
import { describe, it, expect } from 'vitest'
import { computeDataSaverActive } from './dataSaverStore'

describe('computeDataSaverActive', () => {
  it("'on' is always active", () => {
    expect(computeDataSaverActive('on', false, false)).toBe(true)
    expect(computeDataSaverActive('on', true, true)).toBe(true)
  })

  it("'off' is never active", () => {
    expect(computeDataSaverActive('off', true, true)).toBe(false)
    expect(computeDataSaverActive('off', false, false)).toBe(false)
  })

  it("'auto' follows trip dates", () => {
    expect(computeDataSaverActive('auto', true, false)).toBe(true)
    expect(computeDataSaverActive('auto', false, false)).toBe(false)
  })

  it("'auto' also honours the metered/save-data hint (Android/desktop)", () => {
    expect(computeDataSaverActive('auto', false, true)).toBe(true)
  })
})
