<template>
  <div class="card">
    <div class="card-body">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-medium text-gray-900 dark:text-white">Trade Visualization</h3>
        <div v-if="source" class="flex items-center space-x-2">
          <span v-if="isOptionTrade" class="text-xs px-2 py-1 rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
            Options Trade
          </span>
          <span class="text-xs px-2 py-1 rounded-full" :class="getSourceBadgeClass(source)">
            {{ getSourceLabel(source) }}
          </span>
        </div>
      </div>

      <!-- Pro upgrade prompt for free users when billing is enabled -->
      <ProUpgradePrompt
        v-if="requiresProUpgrade"
        variant="compact"
        description="Trade charts with high-precision candlestick data are available with a Pro subscription."
      />

      <!-- Show Charts Button -->
      <div v-else-if="!showCharts && !loading" class="text-center py-8">
        <div class="mb-4">
          <svg class="w-16 h-16 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <h4 class="text-lg font-medium text-gray-900 dark:text-white mb-2">
          View Trade Charts
        </h4>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
          See your entry and exit executions on daily and 5-minute candlestick charts
        </p>
        <button @click="loadCharts" class="btn-primary">
          <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          Load Charts
        </button>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-2">
          <span v-if="isBillingEnabled">Uses Finnhub API with high-precision intraday data</span>
          <span v-else>Uses Finnhub (if configured) or Alpha Vantage for chart data</span>
        </p>
      </div>

      <div v-if="loading" class="flex justify-center py-16">
        <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>

      <!-- Chart service not configured (no market-data API key) -->
      <div v-else-if="showCharts && notConfigured" class="text-center py-16">
        <div class="mb-4">
          <svg class="w-16 h-16 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <p class="text-gray-600 dark:text-gray-400 mb-2">Chart data provider not configured</p>
        <p class="text-sm text-gray-500 dark:text-gray-500 max-w-md mx-auto">
          Configure a market-data API key (Finnhub or Alpha Vantage) to load daily and
          5-minute charts. Contact your administrator to enable trade charts.
        </p>
      </div>

      <!-- Dual charts -->
      <div v-else-if="showCharts" class="space-y-6">
        <!-- Options trade explanation -->
        <div v-if="isOptionTrade" class="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <div class="flex items-start space-x-2">
            <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div class="text-sm text-blue-800 dark:text-blue-200">
              <strong>Options Trade Chart:</strong> These charts show the <strong>underlying stock</strong> price movement. Arrows indicate execution <strong>timing</strong> (when you entered/exited), not option contract prices.
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <!-- Daily chart -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">Daily</h4>
            </div>
            <div v-if="daily.error" class="flex flex-col items-center justify-center h-72 text-center px-4">
              <svg class="w-10 h-10 mb-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p class="text-sm text-gray-600 dark:text-gray-400">{{ daily.error }}</p>
            </div>
            <div v-show="!daily.error" ref="dailyContainer" class="w-full h-72"></div>
          </div>

          <!-- 5-minute chart -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">5-Minute</h4>
            </div>
            <div v-if="fiveMin.error" class="flex flex-col items-center justify-center h-72 text-center px-4">
              <svg class="w-10 h-10 mb-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p class="text-sm text-gray-600 dark:text-gray-400">{{ fiveMin.error }}</p>
              <p v-if="fiveMin.premiumHint" class="text-xs text-gray-500 dark:text-gray-500 mt-1">
                5-minute intraday history requires a premium market-data plan.
              </p>
            </div>
            <div v-show="!fiveMin.error" ref="fiveMinContainer" class="w-full h-72"></div>
          </div>
        </div>

        <!-- Trade summary -->
        <div v-if="tradeInfo" class="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm border-t border-gray-200 dark:border-gray-700 pt-4">
          <div>
            <dt class="text-gray-500 dark:text-gray-400">Entry</dt>
            <dd class="font-medium text-gray-900 dark:text-white">{{ formatCurrency(tradeInfo.entryPrice) }}</dd>
          </div>
          <div>
            <dt class="text-gray-500 dark:text-gray-400">Exit</dt>
            <dd class="font-medium text-gray-900 dark:text-white">{{ formatCurrency(tradeInfo.exitPrice) }}</dd>
          </div>
          <div>
            <dt class="text-gray-500 dark:text-gray-400">P&L</dt>
            <dd class="font-medium" :class="tradeInfo.pnl >= 0 ? 'text-green-600' : 'text-red-600'">
              {{ formatCurrency(tradeInfo.pnl) }}
            </dd>
          </div>
          <div>
            <dt class="text-gray-500 dark:text-gray-400">Return</dt>
            <dd class="font-medium" :class="tradeInfo.pnlPercent >= 0 ? 'text-green-600' : 'text-red-600'">
              {{ tradeInfo.pnlPercent >= 0 ? '+' : '' }}{{ formatNumber(tradeInfo.pnlPercent) }}%
            </dd>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, nextTick, onUnmounted, watch } from 'vue'
import * as LightweightCharts from 'lightweight-charts'
import api from '@/services/api'
import { useCurrencyFormatter } from '@/composables/useCurrencyFormatter'
import { useAuthStore } from '@/stores/auth'
import ProUpgradePrompt from '@/components/ProUpgradePrompt.vue'

const props = defineProps({
  tradeId: {
    type: [String, Number],
    required: true
  }
})

const { formatCurrency, currencySymbol } = useCurrencyFormatter()
const authStore = useAuthStore()

const dailyContainer = ref(null)
const fiveMinContainer = ref(null)

const showCharts = ref(false)
const loading = ref(false)
const notConfigured = ref(false)
const source = ref(null)
const tradeInfo = ref(null)

const daily = reactive({ data: null, error: null, premiumHint: false })
const fiveMin = reactive({ data: null, error: null, premiumHint: false })

// Non-reactive chart instances (LightweightCharts objects must not be proxied)
let dailyChart = null
let fiveMinChart = null

const userTier = computed(() => authStore.user?.tier || 'free')
const isBillingEnabled = computed(() => authStore.user?.billingEnabled !== false)
const isAdmin = computed(() => authStore.user?.role === 'admin' || authStore.user?.role === 'owner')
const requiresProUpgrade = computed(() => isBillingEnabled.value && userTier.value !== 'pro' && !isAdmin.value)
const isOptionTrade = computed(() => tradeInfo.value?.instrumentType === 'option')

const getSourceLabel = (s) => {
  switch (s) {
    case 'finnhub': return 'Finnhub'
    case 'alphavantage': return 'Alpha Vantage'
    case 'alphavantage_cache': return 'Alpha Vantage (cached)'
    case 'coingecko': return 'CoinGecko'
    default: return 'Market data'
  }
}

const getSourceBadgeClass = (s) => {
  switch (s) {
    case 'finnhub': return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
    case 'alphavantage':
    case 'alphavantage_cache': return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
    default: return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200'
  }
}

const formatNumber = (num) => parseFloat(num || 0).toFixed(2)

// Parse a datetime string to a Unix timestamp (seconds) without timezone conversion,
// mirroring how the chart candles are keyed.
const parseDateTimeToTimestamp = (dateStr) => {
  if (!dateStr) return null
  try {
    const str = dateStr.toString()
    const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/)
    if (isoMatch) {
      const [, year, month, day, hour, minute, second] = isoMatch.map(Number)
      return Math.floor(new Date(year, month - 1, day, hour, minute, second).getTime() / 1000)
    }
    const dateObj = new Date(dateStr)
    if (isNaN(dateObj.getTime())) return null
    return Math.floor(dateObj.getTime() / 1000)
  } catch (err) {
    console.error('Error parsing datetime to timestamp:', err, 'for date:', dateStr)
    return null
  }
}

// Validate, dedupe and sort candles for LightweightCharts (which requires
// strictly increasing, unique timestamps).
const prepareCandles = (rawCandles) => {
  if (!Array.isArray(rawCandles)) return []
  const byTime = new Map()
  for (const candle of rawCandles) {
    const time = Number(candle.time)
    const open = Number(candle.open)
    const high = Number(candle.high)
    const low = Number(candle.low)
    const close = Number(candle.close)
    if ([time, open, high, low, close].some((v) => isNaN(v))) continue
    byTime.set(time, { time, open, high, low, close })
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time)
}

// Build entry/exit markers from the trade's executions (preferred) or, when
// no executions are available, from the entry/exit summary fields.
const buildMarkers = (trade, candles) => {
  if (!trade || candles.length === 0) return []
  const symbol = currencySymbol.value
  const isOption = trade.instrumentType === 'option'
  const nearestCandle = (ts) => candles.reduce((closest, c) =>
    Math.abs(c.time - ts) < Math.abs(closest.time - ts) ? c : closest
  )

  const markers = []
  const executions = Array.isArray(trade.executions) ? trade.executions : []

  if (executions.length > 0) {
    executions.forEach((ex) => {
      const ts = parseDateTimeToTimestamp(ex.datetime || ex.entryTime || ex.entry_time)
      if (!ts) return
      const action = (ex.action || ex.side || '').toString().toLowerCase()
      const isBuy = action.includes('buy')
      const price = parseFloat(ex.price)
      const qty = ex.quantity
      const candle = nearestCandle(ts)
      const priceLabel = isFinite(price) ? ` @ ${symbol}${formatNumber(price)}` : ''
      const text = isOption
        ? `${isBuy ? 'BUY' : 'SELL'}${qty ? ` ${qty}x` : ''}`
        : `${isBuy ? 'BUY' : 'SELL'}${priceLabel}`
      markers.push({
        time: candle.time,
        position: isBuy ? 'belowBar' : 'aboveBar',
        color: isBuy ? '#10b981' : '#ef4444',
        shape: isBuy ? 'arrowUp' : 'arrowDown',
        text,
        size: 2
      })
    })
  } else {
    const isShort = (trade.side || '').toLowerCase() === 'short'
    const entryTs = parseDateTimeToTimestamp(trade.entryTime || trade.entryDate)
    if (entryTs) {
      const candle = nearestCandle(entryTs)
      const price = parseFloat(trade.entryPrice)
      markers.push({
        time: candle.time,
        position: 'belowBar',
        color: '#10b981',
        shape: 'arrowUp',
        text: `${isShort ? 'SELL' : 'BUY'}${isFinite(price) ? ` @ ${symbol}${formatNumber(price)}` : ''}`,
        size: 2
      })
    }
    const exitTs = parseDateTimeToTimestamp(trade.exitTime)
    if (exitTs) {
      const candle = nearestCandle(exitTs)
      const price = parseFloat(trade.exitPrice)
      markers.push({
        time: candle.time,
        position: 'aboveBar',
        color: '#ef4444',
        shape: 'arrowDown',
        text: `${isShort ? 'BUY' : 'SELL'}${isFinite(price) ? ` @ ${symbol}${formatNumber(price)}` : ''}`,
        size: 2
      })
    }
  }

  // LightweightCharts requires markers in ascending time order
  return markers.sort((a, b) => a.time - b.time)
}

const renderChart = (container, data) => {
  if (!container || !data) return null
  const candles = prepareCandles(data.candles)
  if (candles.length === 0) return null

  const isDark = document.documentElement.classList.contains('dark')
  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 288,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: isDark ? '#e5e7eb' : '#111827'
    },
    grid: {
      vertLines: { color: isDark ? '#374151' : '#e5e7eb' },
      horzLines: { color: isDark ? '#374151' : '#e5e7eb' }
    },
    timeScale: {
      borderColor: isDark ? '#4b5563' : '#d1d5db',
      timeVisible: data.resolution !== 'D',
      secondsVisible: false
    },
    rightPriceScale: {
      borderColor: isDark ? '#4b5563' : '#d1d5db'
    }
  })

  const series = chart.addCandlestickSeries({
    upColor: '#10b981',
    downColor: '#ef4444',
    borderUpColor: '#10b981',
    borderDownColor: '#ef4444',
    wickUpColor: '#10b981',
    wickDownColor: '#ef4444'
  })

  series.setData(candles)

  const markers = buildMarkers(data.trade, candles)
  if (markers.length > 0) {
    try {
      series.setMarkers(markers)
    } catch (err) {
      console.warn('Failed to set chart markers:', err)
    }
  }

  chart.timeScale().fitContent()

  const handleResize = () => {
    if (container) chart.applyOptions({ width: container.clientWidth })
  }
  window.addEventListener('resize', handleResize)
  chart._resizeHandler = handleResize

  return chart
}

const destroyChart = (chart) => {
  if (!chart) return
  try {
    if (chart._resizeHandler) window.removeEventListener('resize', chart._resizeHandler)
    chart.remove()
  } catch (err) {
    console.warn('Error cleaning up chart:', err)
  }
}

// Map an API error to a user-facing per-chart message; flags global states.
const describeError = (err, panel) => {
  const status = err.response?.status
  const apiError = err.response?.data?.error
  if (status === 503) {
    notConfigured.value = true
    return apiError || 'Chart service not configured'
  }
  if (status === 429) {
    return 'Market-data rate limit reached. Try again shortly.'
  }
  if (status === 404) {
    return apiError || 'No chart data available for this symbol.'
  }
  // Alpha Vantage premium gating surfaces as a generic failure for intraday
  if (panel === '5min') {
    fiveMin.premiumHint = true
  }
  return apiError || 'Unable to load chart data.'
}

const fetchResolution = async (resolution) => {
  try {
    const res = await api.get(`/trades/${props.tradeId}/chart-data`, { params: { resolution } })
    return { ok: true, data: res.data }
  } catch (err) {
    return { ok: false, err }
  }
}

const applyResult = (panel, result, key) => {
  if (result.ok) {
    panel.data = result.data
    panel.error = null
    if (result.data?.source) source.value = result.data.source
    if (result.data?.trade) tradeInfo.value = result.data.trade
    if (!result.data?.candles || result.data.candles.length === 0) {
      panel.error = 'No candles returned for this symbol/timeframe.'
    }
  } else {
    panel.error = describeError(result.err, key)
  }
}

const loadCharts = async () => {
  showCharts.value = true
  loading.value = true
  notConfigured.value = false
  daily.error = null
  fiveMin.error = null
  fiveMin.premiumHint = false

  const [dailyRes, fiveMinRes] = await Promise.all([
    fetchResolution('daily'),
    fetchResolution('5min')
  ])

  applyResult(daily, dailyRes, 'daily')
  applyResult(fiveMin, fiveMinRes, '5min')

  loading.value = false

  if (notConfigured.value) return

  await nextTick()
  if (!daily.error) dailyChart = renderChart(dailyContainer.value, daily.data)
  if (!fiveMin.error) fiveMinChart = renderChart(fiveMinContainer.value, fiveMin.data)
}

// Re-render on theme change so colors match light/dark mode
watch(() => document.documentElement.classList.contains('dark'), async () => {
  if (!showCharts.value || notConfigured.value) return
  await nextTick()
  destroyChart(dailyChart); dailyChart = null
  destroyChart(fiveMinChart); fiveMinChart = null
  if (!daily.error) dailyChart = renderChart(dailyContainer.value, daily.data)
  if (!fiveMin.error) fiveMinChart = renderChart(fiveMinContainer.value, fiveMin.data)
})

onUnmounted(() => {
  destroyChart(dailyChart)
  destroyChart(fiveMinChart)
})
</script>
