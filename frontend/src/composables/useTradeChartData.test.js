import { describe, expect, it, vi, beforeEach } from 'vitest'

const { api } = vi.hoisted(() => ({
  api: {
    get: vi.fn()
  }
}))

vi.mock('@/services/api', () => ({
  default: api
}))

async function loadComposable() {
  vi.resetModules()
  return import('./useTradeChartData')
}

describe('useTradeChartData', () => {
  beforeEach(() => {
    api.get.mockReset()
  })

  it('loads chart data from the authenticated trades endpoint by default', async () => {
    api.get.mockResolvedValue({
      data: { candles: [{ t: 1 }], interval: '5min' }
    })

    const { useTradeChartData } = await loadComposable()
    const { fetchChartData, chartData } = useTradeChartData('5')
    await fetchChartData('trade-1', '5')

    expect(api.get).toHaveBeenCalledWith('/trades/trade-1/chart-data', {
      params: { resolution: '5' },
      skipAuthRedirect: false
    })
    expect(chartData.value.candles).toHaveLength(1)
  })

  it('uses chartUrlForTrade for public daily-share pages', async () => {
    api.get.mockResolvedValue({
      data: { candles: [{ t: 1 }], interval: '5min' }
    })

    const { useTradeChartData } = await loadComposable()
    const token = 'abc123'
    const { fetchChartData } = useTradeChartData('5', {
      chartUrlForTrade: (tradeId) => `/public/daily-review/${token}/trades/${tradeId}/chart-data`
    })
    await fetchChartData('trade-9', '5')

    expect(api.get).toHaveBeenCalledWith(
      '/public/daily-review/abc123/trades/trade-9/chart-data',
      {
        params: { resolution: '5' },
        skipAuthRedirect: true
      }
    )
  })

  it('does not request when tradeId is missing', async () => {
    const { useTradeChartData } = await loadComposable()
    const { fetchChartData, loading } = useTradeChartData('5')

    await expect(fetchChartData(null)).resolves.toBeNull()
    expect(api.get).not.toHaveBeenCalled()
    expect(loading.value).toBe(false)
  })

  it('maps Pro-gated 403 responses onto requiresPro', async () => {
    api.get.mockRejectedValue({
      response: {
        status: 403,
        data: { error: 'Trade charts require Pro access.', requiresPro: true }
      }
    })

    const { useTradeChartData } = await loadComposable()
    const { fetchChartData, requiresPro, error } = useTradeChartData('5')
    await fetchChartData('trade-1')

    expect(requiresPro.value).toBe(true)
    expect(error.value).toBe('Trade charts require Pro access.')
  })

  it('surfaces chart service and rate-limit failures', async () => {
    const { useTradeChartData } = await loadComposable()

    api.get.mockRejectedValueOnce({
      response: { status: 503, data: { error: 'Chart service not configured' } }
    })
    const first = useTradeChartData('5')
    await first.fetchChartData('trade-1')
    expect(first.isConfigured.value).toBe(false)
    expect(first.error.value).toBe('Chart service not configured')

    api.get.mockRejectedValueOnce({
      response: { status: 429, data: { error: 'Chart API limit reached' } }
    })
    const second = useTradeChartData('5')
    await second.fetchChartData('trade-1')
    expect(second.error.value).toBe('Chart API limit reached')
  })
})
