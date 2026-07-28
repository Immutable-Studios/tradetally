import { ref } from 'vue'
import api from '@/services/api'

const INTERVAL_TO_RESOLUTION = {
  '1min': '1',
  '5min': '5',
  '15min': '15',
  '1hour': '60',
  daily: 'D'
}

/**
 * Lean trade chart-data loader shared by compact/inline chart previews
 * (e.g. the Daily Review page). Talks to the same `/trades/:id/chart-data`
 * endpoint used by TradeChartVisualization, without the click-to-load gate
 * or session-persisted resolution since previews always auto-load.
 *
 * @param {string} defaultResolution
 * @param {{ chartUrlForTrade?: (tradeId: string) => string }} [options]
 *   When `chartUrlForTrade` is set (shared Daily Review pages), chart requests
 *   go to that public URL instead of the authenticated `/trades/:id/chart-data`.
 */
export function useTradeChartData(defaultResolution = '5', options = {}) {
  const loading = ref(false)
  const error = ref(null)
  const requiresPro = ref(false)
  const isConfigured = ref(true)
  const chartData = ref(null)
  const selectedResolution = ref(defaultResolution)
  const chartUrlForTrade = typeof options.chartUrlForTrade === 'function'
    ? options.chartUrlForTrade
    : null

  async function fetchChartData(tradeId, resolution = selectedResolution.value) {
    if (!tradeId) return null

    loading.value = true
    error.value = null
    requiresPro.value = false
    isConfigured.value = true

    try {
      const url = chartUrlForTrade
        ? chartUrlForTrade(tradeId)
        : `/trades/${tradeId}/chart-data`
      const response = await api.get(url, {
        params: { resolution },
        // Public share pages must not bounce guests to /login on a 401.
        skipAuthRedirect: Boolean(chartUrlForTrade)
      })
      chartData.value = response.data
      selectedResolution.value = INTERVAL_TO_RESOLUTION[response.data?.interval] || resolution
      return response.data
    } catch (requestError) {
      const status = requestError.response?.status
      const responseError = requestError.response?.data?.error

      if (status === 403 && requestError.response?.data?.requiresPro) {
        requiresPro.value = true
        error.value = responseError || 'Trade charts require Pro access.'
      } else if (status === 503) {
        isConfigured.value = false
        error.value = responseError || 'Chart service not configured'
      } else if (status === 429) {
        error.value = responseError || 'Chart API limit reached'
      } else {
        error.value = responseError || 'Failed to load chart data'
      }
      return null
    } finally {
      loading.value = false
    }
  }

  return {
    loading,
    error,
    requiresPro,
    isConfigured,
    chartData,
    selectedResolution,
    fetchChartData
  }
}
