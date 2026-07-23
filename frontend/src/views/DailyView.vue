<template>
  <div class="content-wrapper py-8">
    <div class="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <h1 class="heading-page">Daily review</h1>
        <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
          The full picture of a session — what you traded, what you made, what’s still open.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div class="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-gray-700 dark:bg-gray-800/80">
          <button
            v-for="p in PERIODS"
            :key="p.id"
            type="button"
            class="rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
            :class="periodTabClass(p)"
            :disabled="!p.enabled"
            :title="p.enabled ? `View by ${p.label.toLowerCase()}` : `${p.label} view coming soon`"
            @click="p.enabled && setQuery({ period: p.id })"
          >
            {{ p.label }}
          </button>
        </div>

        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          :class="showRValue
            ? 'bg-primary-600 text-white hover:bg-primary-700'
            : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
          @click="showRValue = !showRValue"
        >
          {{ showRValue ? `Show P&L (${currencySymbol})` : 'Show R-Value' }}
        </button>
      </div>
    </div>

    <!-- Date navigator -->
    <div class="card mb-6">
      <div class="card-body flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            aria-label="Previous"
            @click="shiftPeriod(-1)"
          >
            <ChevronLeftIcon class="h-5 w-5" />
          </button>
          <div class="min-w-[220px] text-center">
            <div class="text-lg font-semibold text-gray-900 dark:text-white">
              {{ headingLabel }}
            </div>
            <div class="text-xs text-gray-500 dark:text-gray-400">
              {{ rangeLabel }}
            </div>
          </div>
          <button
            type="button"
            class="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            aria-label="Next"
            @click="shiftPeriod(1)"
          >
            <ChevronRightIcon class="h-5 w-5" />
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <input
            type="date"
            class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            :value="dateKey"
            @change="onDateInput"
          />
          <button type="button" class="btn-secondary text-sm" @click="goToday">
            Today
          </button>
          <router-link
            :to="{ name: 'calendar', query: { year: String(anchorDate.getFullYear()) } }"
            class="btn-secondary text-sm"
          >
            Calendar
          </router-link>
        </div>
      </div>
    </div>

    <!-- Period not yet implemented -->
    <div
      v-if="period !== 'day'"
      class="card"
    >
      <div class="card-body py-16 text-center">
        <h2 class="heading-section">{{ periodLabel }} view coming soon</h2>
        <p class="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
          Same layout will roll up trades, P&amp;L, and open positions across the selected
          {{ period }}. Day view is ready now.
        </p>
        <button type="button" class="btn-primary mt-6" @click="setQuery({ period: 'day' })">
          Back to day view
        </button>
      </div>
    </div>

    <template v-else>
      <DailyAccountStrip
        :strip="accountStrip"
        :open-positions="openPositions"
        :equity-for-pct="equityForPct"
      />

      <!-- Stats strip -->
      <div class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div class="card card-mobile-safe">
          <div class="card-body">
            <dt class="text-data-secondary">Day P&amp;L</dt>
            <dd class="mt-1 text-2xl font-semibold tabular-nums" :class="pnlClass(dayTotalPnl)">
              {{ showRValue && dayTotalR != null ? formatR(dayTotalR) : formatCurrency(dayTotalPnl) }}
            </dd>
            <div
              v-if="dayPnlPct != null"
              class="mt-1 text-xs font-semibold tabular-nums"
              :class="pnlClass(dayPnlPct)"
            >
              {{ formatPnlPct(dayPnlPct) }} of equity
            </div>
          </div>
        </div>
        <div class="card card-mobile-safe">
          <div class="card-body">
            <dt class="text-data-secondary">Trades</dt>
            <dd class="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
              {{ contributions.length }}
            </dd>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ openedTrades.length }} opened · {{ winCount }}W / {{ lossCount }}L
            </div>
          </div>
        </div>
        <div class="card card-mobile-safe">
          <div class="card-body">
            <dt class="text-data-secondary">Win rate</dt>
            <dd class="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
              {{ winRate == null ? '—' : `${winRate.toFixed(0)}%` }}
            </dd>
          </div>
        </div>
        <div class="card card-mobile-safe">
          <div class="card-body">
            <dt class="text-data-secondary">Avg risk</dt>
            <dd class="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
              {{ avgRisk == null ? '—' : formatCurrency(avgRisk) }}
            </dd>
          </div>
        </div>
        <div class="card card-mobile-safe col-span-2 lg:col-span-1">
          <div class="card-body">
            <dt class="text-data-secondary">Open UPL</dt>
            <dd
              class="mt-1 text-2xl font-semibold tabular-nums"
              :class="unrealizedTotal == null ? 'text-gray-900 dark:text-white' : pnlClass(unrealizedTotal)"
            >
              {{ unrealizedTotal == null ? '—' : formatSigned(unrealizedTotal) }}
            </dd>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ openPositions.length }} live
            </div>
          </div>
        </div>
      </div>

      <div v-if="loading" class="mb-4 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary-600 border-t-transparent"></div>
        Loading session…
      </div>

      <DayActivityList
        :contributions="contributions"
        :opened-trades="openedTrades"
        :open-positions="openPositions"
        :equity-for-pct="equityForPct"
        :date-label="headingLabel"
        :show-r-value="showRValue"
        @select-trade="goToTrade"
      />

      <div class="mt-6 flex flex-wrap gap-3 text-sm">
        <router-link
          :to="{ path: '/trades', query: { startDate: dateKey, endDate: dateKey } }"
          class="text-primary-600 hover:text-primary-800 dark:text-primary-400"
        >
          Open in trades list →
        </router-link>
        <router-link
          to="/diary"
          class="text-primary-600 hover:text-primary-800 dark:text-primary-400"
        >
          Journal →
        </router-link>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { format } from 'date-fns'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/outline'
import DayActivityList from '@/components/daily/DayActivityList.vue'
import DailyAccountStrip from '@/components/daily/DailyAccountStrip.vue'
import { useDailyReview, PERIODS } from '@/composables/useDailyReview'
import { useCurrencyFormatter } from '@/composables/useCurrencyFormatter'
import { formatR } from '@/utils/rFormat'
import { equityPnlPct } from '@/utils/tradeNotional'

const router = useRouter()
const { formatCurrency, currencySymbol } = useCurrencyFormatter()
const showRValue = ref(false)

const {
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
  dayTotalPnl,
  dayTotalR,
  winCount,
  lossCount,
  winRate,
  avgRisk,
  unrealizedTotal,
  setQuery,
  shiftPeriod,
  goToday
} = useDailyReview()

const dayPnlPct = computed(() => equityPnlPct(dayTotalPnl.value, equityForPct.value))

const periodLabel = computed(() =>
  PERIODS.find((p) => p.id === period.value)?.label || 'Period'
)

const headingLabel = computed(() => {
  if (period.value === 'day') return format(anchorDate.value, 'EEEE, MMMM d, yyyy')
  if (period.value === 'week') return `Week of ${format(anchorDate.value, 'MMM d, yyyy')}`
  if (period.value === 'month') return format(anchorDate.value, 'MMMM yyyy')
  if (period.value === 'year') return format(anchorDate.value, 'yyyy')
  return format(anchorDate.value, 'MMMM d, yyyy')
})

const rangeLabel = computed(() => {
  if (range.value.start === range.value.end) return 'Single session'
  return `${range.value.start} → ${range.value.end}`
})

function periodTabClass(p) {
  if (!p.enabled) {
    return 'cursor-not-allowed text-gray-400 dark:text-gray-500'
  }
  if (period.value === p.id) {
    return 'bg-white text-primary-700 shadow-sm dark:bg-gray-700 dark:text-primary-300'
  }
  return 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
}

function pnlClass(value) {
  return (Number(value) || 0) >= 0
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400'
}

function formatSigned(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const formatted = formatCurrency(Math.abs(n))
  return n >= 0 ? `+${formatted}` : `-${formatted}`
}

function formatPnlPct(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function onDateInput(event) {
  const value = event.target?.value
  if (value) setQuery({ date: value })
}

function goToTrade(id) {
  if (id) router.push(`/trades/${id}`)
}
</script>
