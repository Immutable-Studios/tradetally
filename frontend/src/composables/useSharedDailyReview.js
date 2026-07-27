import { ref, computed } from 'vue'
import api from '@/services/api'

/**
 * Public, unauthenticated counterpart to useDailyReview.js - loads a single
 * day's review through the token-scoped /public/daily-review/:token/* routes
 * (see backend/src/routes/dailyReviewShare.routes.js) instead of the
 * authenticated /analytics and /trades endpoints. Shape mirrors
 * useDailyReview so DayActivityList can be reused as-is.
 */
export function useSharedDailyReview(token) {
  const loading = ref(true)
  const notFound = ref(false)
  const errorMessage = ref(null)

  const dateKey = ref(null)
  // Reviews are per account; null only on legacy all-accounts share links.
  const account = ref(null)
  const username = ref(null)
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

  const unrealizedTotal = computed(() => {
    const values = openPositions.value
      .map((p) => p.unrealizedPnL)
      .filter((v) => v != null && Number.isFinite(Number(v)))
    if (!values.length) return null
    return values.reduce((sum, v) => sum + Number(v), 0)
  })

  async function fetchMeta() {
    const res = await api.get(`/public/daily-review/${token}`)
    dateKey.value = res.data.date
    account.value = res.data.account || null
    username.value = res.data.username
    accountStrip.value = res.data.accountStrip || null
    equityForPct.value = res.data.equityForPct
      ?? res.data.accountStrip?.equityForPct
      ?? res.data.accountStrip?.sodNetLiq
      ?? res.data.accountStrip?.netLiq
      ?? null
  }

  async function fetchDayActivity() {
    const [dayRes, tradesRes] = await Promise.all([
      api.get(`/public/daily-review/${token}/day`),
      api.get(`/public/daily-review/${token}/trades`)
    ])

    contributions.value = dayRes.data.contributions || []
    if (!dateKey.value) dateKey.value = dayRes.data.date
    if (dayRes.data.accountStrip) accountStrip.value = dayRes.data.accountStrip
    if (dayRes.data.equityForPct != null) equityForPct.value = dayRes.data.equityForPct

    const trades = tradesRes.data.trades || []
    const contribIds = new Set(contributions.value.map((c) => c.trade_id))
    openedTrades.value = trades.filter((t) => {
      const entryDay = String(t.trade_date || t.entry_time || '').slice(0, 10)
      const isOpen = t.exit_price == null && t.exit_time == null
      return entryDay === dateKey.value && (isOpen || !contribIds.has(t.id))
    })
  }

  async function fetchOpenPositions() {
    quotesLoading.value = true
    quotesError.value = null
    try {
      const fast = await api.get(`/public/daily-review/${token}/positions`, {
        params: { skipQuotes: 'true' }
      })
      openPositions.value = fast.data.positions || []

      const full = await api.get(`/public/daily-review/${token}/positions`)
      if (full.data.error) quotesError.value = full.data.error
      openPositions.value = full.data.positions || []
    } catch (error) {
      console.error('Failed to load shared open positions:', error)
      quotesError.value = error.response?.data?.error || error.message
    } finally {
      quotesLoading.value = false
    }
  }

  async function load() {
    loading.value = true
    notFound.value = false
    errorMessage.value = null
    try {
      await fetchMeta()
      await Promise.all([fetchDayActivity(), fetchOpenPositions()])
    } catch (error) {
      if (error.response?.status === 404) {
        notFound.value = true
      } else {
        errorMessage.value = error.response?.data?.error || error.message || 'Failed to load this shared review'
      }
    } finally {
      loading.value = false
    }
  }

  return {
    loading,
    notFound,
    errorMessage,
    dateKey,
    account,
    username,
    accountStrip,
    equityForPct,
    contributions,
    openedTrades,
    openPositions,
    quotesLoading,
    quotesError,
    dayTotalPnl,
    winCount,
    lossCount,
    winRate,
    unrealizedTotal,
    load
  }
}
