import { describe, it, expect } from 'vitest'
import { applyPresetToForm, resolveActivePreset, minSyncStartDate, todayIso } from './syncRangePresets'
import { DATA_START_DATE } from '@/config/dataStart'

describe('syncRangePresets — data start date floor', () => {
  it('exposes the data start date as the picker minimum', () => {
    expect(minSyncStartDate).toBe(DATA_START_DATE)
  })

  it('resolves "All Time" to the data start date rather than null', () => {
    // null previously meant "everything the broker has"; that would now pull
    // years of executions the backend discards on arrival.
    const form = { syncStartDate: '2020-01-01' }
    applyPresetToForm(form, 'all')
    expect(form.syncStartDate).toBe(DATA_START_DATE)
  })

  it('never lets a lookback preset start before the data start date', () => {
    for (const preset of ['ytd', '30d', '90d', '1y']) {
      const form = { syncStartDate: null }
      applyPresetToForm(form, preset)
      expect(form.syncStartDate >= DATA_START_DATE).toBe(true)
    }
  })

  it('clamps a custom date that predates the floor, and keeps a later one', () => {
    const earlier = { syncStartDate: '2019-06-01' }
    applyPresetToForm(earlier, 'custom')
    expect(earlier.syncStartDate).toBe(DATA_START_DATE)

    const later = { syncStartDate: '2099-01-01' }
    applyPresetToForm(later, 'custom')
    expect(later.syncStartDate).toBe('2099-01-01')
  })

  it('seeds an empty custom range with today, floored at the data start date', () => {
    const form = { syncStartDate: null }
    applyPresetToForm(form, 'custom')
    expect(form.syncStartDate).toBe(todayIso > DATA_START_DATE ? todayIso : DATA_START_DATE)
  })

  it('labels a window reaching the floor as "All Time"', () => {
    expect(resolveActivePreset(null)).toBe('all')
    expect(resolveActivePreset(DATA_START_DATE)).toBe('all')
    expect(resolveActivePreset('2019-01-01')).toBe('all')
  })

  it('still reports a genuinely narrower window as custom', () => {
    expect(resolveActivePreset('2099-04-17')).toBe('custom')
  })
})
