import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  addDays,
  addWeeks,
  addMonths,
  addYears,
  format,
  parseISO,
  isValid,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear
} from 'date-fns'
import api from '@/services/api'
import { useGlobalAccountFilter } from '@/composables/useGlobalAccountFilter'

export const PERIODS = [
  { id: 'day', label: 'Day', enabled: true },
  { id: 'week', label: 'Week', enabled: false },
  { id: 'month', label: 'Month', enabled: false },
  { id: 'year', label: 'Year', enabled: false }
]

function todayKey() {
  return format(new Date(), 'yyyy-MM-dd')
}

function parseDateKey(value) {
  if (!value || typeof value !== 'string') return null
  const parsed = parseISO(value)
  return isValid(parsed) ? format(parsed, 'yyyy-MM-dd') : null
}

/**
 * Period-aware daily review data loader.
 * Day is fully wired; week/month/year keep the same shape for later expansion.
 */
export function useDailyReview() {
  const route = useRoute()
  const router = useRouter()
  const { selectedAccount } = useGlobalAccountFilter()

  const period = computed(() => {
    const raw = String(route.query.period || 'day')
    return PERIODS.some((p) => p.id === raw && p.enabled) ? raw : 'day'
  })

  const dateKey = computed(() => parseDateKey(route.query.date) || todayKey())

  const anchorDate = computed(() => parseISO(dateKey.value))

  const range = computed(() => {
    const d = anchorDate.value
    if (period.value === 'week') {
      return {
        start: format(startOfWeek(d, { weekStartsOn: 0 }), 'yyyy-MM-dd'),
        end: format(endOfWeek(d, { weekStartsOn: 0 }), 'yyyy-MM-dd')
      }
    }
    if (period.value === 'month') {
      return {
        start: format(startOfMonth(d), 'yyyy-MM-dd'),
        end: format(endOfMonth(d), 'yyyy-MM-dd')
      }
    }
    if (period.value === 'year') {
      return {
        start: format(startOfYear(d), 'yyyy-MM-dd'),
        end: format(endOfYear(d), 'yyyy-MM-dd')
      }
    }
    return { start: dateKey.value, end: dateKey.value }
  })

  const loading = ref(false)
  const accountStrip = ref(null)
  const equityForPct = ref(null)
  const contributions = ref([])
  const openedTrades = ref([])
  const openPositions = ref([])
  const quotesLoading = ref(false)
  const quotesError = ref(null)

  const dayTotalPnl = computed(() =>
    contributions.value.reduce((sum, c) => sum + (Number(c.pnl) || 0), 0)
  )

  const dayTotalR = computed(() => {
    const withR = contributions.value.filter((c) => c.r_value != null)
    if (!withR.length) return null
    return withR.reduce((sum, c) => sum + (Number(c.r_value) || 0), 0)
  })

  const winCount = computed(() =>
    contributions.value.filter((c) => (Number(c.pnl) || 0) > 0).length
  )

  const lossCount = computed(() =>
    contributions.value.filter((c) => (Number(c.pnl) || 0) < 0).length
  )

  const winRate = computed(() => {
    const decided = winCount.value + lossCount.value
    if (!decided) return null
    return (winCount.value / decided) * 100
  })

  const riskTrades = computed(() =>
    contributions.value.filter((c) => c.risk_amount != null)
  )

  const avgRisk = computed(() => {
    if (!riskTrades.value.length) return null
    const total = riskTrades.value.reduce((sum, c) => sum + (Number(c.risk_amount) || 0), 0)
    return total / riskTrades.value.length
  })

  const unrealizedTotal = computed(() => {
    const values = openPositions.value
      .map((p) => p.unrealizedPnL)
      .filter((v) => v != null && Number.isFinite(Number(v)))
    if (!values.length) return null
    return values.reduce((sum, v) => sum + Number(v), 0)
  })

  function setQuery({ date, period: nextPeriod } = {}) {
    const query = {
      ...route.query,
      date: date || dateKey.value,
      period: nextPeriod || period.value
    }
    router.replace({ name: 'daily', query })
  }

  function shiftPeriod(direction) {
    const d = anchorDate.value
    let next
    if (period.value === 'week') next = addWeeks(d, direction)
    else if (period.value === 'month') next = addMonths(d, direction)
    else if (period.value === 'year') next = addYears(d, direction)
    else next = addDays(d, direction)
    setQuery({ date: format(next, 'yyyy-MM-dd') })
  }

  function goToday() {
    setQuery({ date: todayKey() })
  }

  function accountParams(extra = {}) {
    const params = { ...extra }
    if (selectedAccount.value) params.accounts = selectedAccount.value
    return params
  }

  async function fetchDayActivity() {
    if (period.value !== 'day') {
      contributions.value = []
      openedTrades.value = []
      return
    }

    loading.value = true
    try {
      const [dayRes, tradesRes] = await Promise.all([
        api.get('/analytics/calendar/day', {
          params: accountParams({ date: dateKey.value })
        }),
        api.get('/trades', {
          params: accountParams({
            startDate: range.value.start,
            endDate: range.value.end,
            limit: 200
          })
        })
      ])

      contributions.value = dayRes.data.contributions || []
      accountStrip.value = dayRes.data.accountStrip || null
      equityForPct.value = dayRes.data.equityForPct
        ?? dayRes.data.accountStrip?.equityForPct
        ?? dayRes.data.accountStrip?.sodNetLiq
        ?? dayRes.data.accountStrip?.netLiq
        ?? null

      const trades = tradesRes.data.trades || tradesRes.data || []
      const contribIds = new Set(contributions.value.map((c) => c.trade_id))
      openedTrades.value = trades.filter((t) => {
        const entryDay = String(t.trade_date || t.entry_time || '').slice(0, 10)
        const isOpen = t.exit_price == null && t.exit_time == null
        return entryDay === dateKey.value && (isOpen || !contribIds.has(t.id))
      })
    } catch (error) {
      console.error('Failed to load daily activity:', error)
      contributions.value = []
      openedTrades.value = []
      accountStrip.value = null
      equityForPct.value = null
    } finally {
      loading.value = false
    }
  }

  async function fetchOpenPositions() {
    quotesLoading.value = true
    quotesError.value = null
    try {
      const fast = await api.get('/trades/open-positions-quotes', {
        params: accountParams({ skipQuotes: 'true' })
      })
      openPositions.value = fast.data.positions || []

      const full = await api.get('/trades/open-positions-quotes', {
        params: accountParams()
      })
      if (full.data.error) quotesError.value = full.data.error
      openPositions.value = full.data.positions || []
    } catch (error) {
      console.error('Failed to load open positions:', error)
      quotesError.value = error.response?.data?.error || error.message
    } finally {
      quotesLoading.value = false
    }
  }

  async function refresh() {
    await Promise.all([fetchDayActivity(), fetchOpenPositions()])
  }

  watch(
    [dateKey, period, selectedAccount],
    () => {
      refresh()
    },
    { immediate: true }
  )

  return {
    PERIODS,
    period,
    dateKey,
    anchorDate,
    range,
    loading,
    accountStrip,
    equityForPct,
    contributions,
    openedTrades,
    openPositions,
    quotesLoading,
    quotesError,
    dayTotalPnl,
    dayTotalR,
    winCount,
    lossCount,
    winRate,
    avgRisk,
    unrealizedTotal,
    setQuery,
    shiftPeriod,
    goToday,
    refresh
  }
}
