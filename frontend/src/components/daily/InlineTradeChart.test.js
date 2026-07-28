import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import InlineTradeChart from './InlineTradeChart.vue'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))

vi.mock('@/services/api', () => ({ default: { get: apiGet } }))
vi.mock('@/composables/useUserTimezone', () => ({
  useUserTimezone: () => ({ userTimezone: ref('America/New_York') })
}))

describe('InlineTradeChart share-token loading', () => {
  beforeEach(() => {
    apiGet.mockReset()
    // Component falls back to immediate load when IntersectionObserver is absent.
    delete globalThis.IntersectionObserver
  })

  it('requests the public daily-share chart endpoint when shareToken is set', async () => {
    apiGet.mockResolvedValue({
      data: {
        candles: [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5 }],
        interval: '5min',
        trade: { id: 'trade-1', symbol: 'SNOW' }
      }
    })

    mount(InlineTradeChart, {
      props: {
        tradeId: 'trade-1',
        shareToken: 'share-tok-abc'
      },
      global: {
        stubs: { KLineTradeChart: true }
      }
    })
    await flushPromises()

    expect(apiGet).toHaveBeenCalledWith(
      '/public/daily-review/share-tok-abc/trades/trade-1/chart-data',
      expect.objectContaining({
        params: { resolution: '5' },
        skipAuthRedirect: true
      })
    )
  })

  it('requests the authenticated chart endpoint when shareToken is absent', async () => {
    apiGet.mockResolvedValue({
      data: {
        candles: [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5 }],
        interval: '5min'
      }
    })

    mount(InlineTradeChart, {
      props: { tradeId: 'trade-2' },
      global: {
        stubs: { KLineTradeChart: true }
      }
    })
    await flushPromises()

    expect(apiGet).toHaveBeenCalledWith(
      '/trades/trade-2/chart-data',
      expect.objectContaining({
        params: { resolution: '5' },
        skipAuthRedirect: false
      })
    )
  })
})
