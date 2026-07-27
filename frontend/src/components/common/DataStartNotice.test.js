import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DataStartNotice from './DataStartNotice.vue'
import { DATA_START_DATE_LABEL } from '@/config/dataStart'

const stubs = { InformationCircleIcon: true }

describe('DataStartNotice', () => {
  it('always states the cutoff date', () => {
    const wrapper = mount(DataStartNotice, { global: { stubs } })

    expect(wrapper.text()).toContain(DATA_START_DATE_LABEL)
  })

  it('explains the importer case', () => {
    const wrapper = mount(DataStartNotice, { props: { context: 'import' }, global: { stubs } })

    expect(wrapper.text()).toMatch(/skipped/i)
  })

  it('explains the broker sync case', () => {
    const wrapper = mount(DataStartNotice, { props: { context: 'sync' }, global: { stubs } })

    expect(wrapper.text()).toMatch(/capped/i)
  })

  it('falls back to the general wording', () => {
    const wrapper = mount(DataStartNotice, { props: { context: 'general' }, global: { stubs } })

    expect(wrapper.text()).toMatch(/removed and are no longer recorded/i)
  })

  it('gives each context distinct copy', () => {
    const text = (context) =>
      mount(DataStartNotice, { props: { context }, global: { stubs } }).text()

    const variants = new Set([text('general'), text('import'), text('sync')])
    expect(variants.size).toBe(3)
  })

  it('is announced as a note for screen readers', () => {
    const wrapper = mount(DataStartNotice, { global: { stubs } })

    expect(wrapper.attributes('role')).toBe('note')
  })

  it('rejects an unknown context via the prop validator', () => {
    const validator = DataStartNotice.props.context.validator

    expect(validator('import')).toBe(true)
    expect(validator('sync')).toBe(true)
    expect(validator('general')).toBe(true)
    expect(validator('nonsense')).toBe(false)
  })

  it('renders slot content as a second line when provided', () => {
    const wrapper = mount(DataStartNotice, {
      global: { stubs },
      slots: { default: 'Extra context here' }
    })

    expect(wrapper.text()).toContain('Extra context here')
  })
})
