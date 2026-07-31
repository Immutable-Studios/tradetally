import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import UpcomingEarningsSection from './UpcomingEarningsSection.vue'

const { api } = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    post: vi.fn()
  }
}))

vi.mock('@/services/api', () => ({
  default: api
}))

describe('UpcomingEarningsSection', () => {
  beforeEach(() => {
    api.get.mockReset()
    api.post.mockReset()
  })

  it('does not render when the earnings service is not configured (503)', async () => {
    api.get.mockRejectedValueOnce({
      response: { status: 503, data: { error: 'Earnings service not configured' } }
    })

    const wrapper = mount(UpcomingEarningsSection, {
      props: { symbols: ['AAPL'] }
    })

    await flushPromises()

    expect(wrapper.find('.card').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Earnings service not configured')
    expect(wrapper.emitted('unavailable')).toBeTruthy()
  })

  it('keeps retry UI for real failures when the service is configured', async () => {
    api.get.mockRejectedValueOnce({
      response: { status: 500, data: { error: 'Upstream earnings provider failed' } }
    })

    const wrapper = mount(UpcomingEarningsSection, {
      props: { symbols: ['AAPL'] }
    })

    await flushPromises()

    expect(wrapper.find('.card').exists()).toBe(true)
    expect(wrapper.text()).toContain('Upstream earnings provider failed')
    expect(wrapper.text()).toContain('Try again')
    expect(wrapper.emitted('unavailable')).toBeFalsy()
  })
})
