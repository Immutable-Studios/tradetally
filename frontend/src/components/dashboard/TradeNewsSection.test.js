import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TradeNewsSection from './TradeNewsSection.vue'

const { api } = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    post: vi.fn()
  }
}))

vi.mock('@/services/api', () => ({
  default: api
}))

describe('TradeNewsSection', () => {
  beforeEach(() => {
    api.get.mockReset()
    api.post.mockReset()
  })

  it('does not render when the news service is not configured (503)', async () => {
    api.get.mockRejectedValueOnce({
      response: { status: 503, data: { error: 'News service not configured' } }
    })

    const wrapper = mount(TradeNewsSection, {
      props: { symbols: ['AAPL'] }
    })

    await flushPromises()

    expect(wrapper.find('.card').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('News service not configured')
    expect(wrapper.emitted('unavailable')).toBeTruthy()
  })

  it('keeps retry UI for real failures when the service is configured', async () => {
    api.get.mockRejectedValueOnce({
      response: { status: 500, data: { error: 'Upstream news provider failed' } }
    })

    const wrapper = mount(TradeNewsSection, {
      props: { symbols: ['AAPL'] }
    })

    await flushPromises()

    expect(wrapper.find('.card').exists()).toBe(true)
    expect(wrapper.text()).toContain('Upstream news provider failed')
    expect(wrapper.text()).toContain('Try again')
    expect(wrapper.emitted('unavailable')).toBeFalsy()
  })
})
