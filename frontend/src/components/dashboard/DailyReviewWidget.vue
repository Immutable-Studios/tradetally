<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-2 min-w-0">
        <button
          type="button"
          class="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          aria-label="Previous day"
          @click="shiftPeriod(-1)"
        >
          <ChevronLeftIcon class="h-5 w-5" />
        </button>
        <div class="min-w-0 text-center sm:text-left">
          <h3 class="heading-card truncate">{{ headingLabel }}</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400">Daily review</p>
        </div>
        <button
          type="button"
          class="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          aria-label="Next day"
          @click="shiftPeriod(1)"
        >
          <ChevronRightIcon class="h-5 w-5" />
        </button>
        <button
          v-if="!isToday"
          type="button"
          class="btn-secondary text-xs py-1 px-2"
          @click="goToday"
        >
          Today
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
          :class="showRValue
            ? 'bg-primary-600 text-white hover:bg-primary-700'
            : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
          @click="showRValue = !showRValue"
        >
          {{ showRValue ? `P&L (${currencySymbol})` : 'R-Value' }}
        </button>
        <router-link
          :to="{ name: 'daily', query: { date: dateKey, period: 'day' } }"
          class="text-xs font-medium text-primary-600 hover:text-primary-800 dark:text-primary-400 dark:hover:text-primary-300"
        >
          Open full review →
        </router-link>
      </div>
    </div>

    <div v-if="loading && !hasLoadedOnce" class="flex items-center gap-2 py-10 text-sm text-gray-500 dark:text-gray-400">
      <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
      Loading session…
    </div>

    <template v-else>
      <DailyAccountStrip
        :strip="accountStrip"
        :open-positions="openPositions"
        :equity-for-pct="equityForPct"
      />

      <div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
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

      <div v-if="loading" class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        Updating…
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
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { format } from 'date-fns'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/outline'
import DayActivityList from '@/components/daily/DayActivityList.vue'
import DailyAccountStrip from '@/components/daily/DailyAccountStrip.vue'
import { useDailyReview } from '@/composables/useDailyReview'
import { useCurrencyFormatter } from '@/composables/useCurrencyFormatter'
import { formatR } from '@/utils/rFormat'
import { equityPnlPct } from '@/utils/tradeNotional'

const router = useRouter()
const { formatCurrency, currencySymbol } = useCurrencyFormatter()
const showRValue = ref(false)
const hasLoadedOnce = ref(false)

const {
  dateKey,
  anchorDate,
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
  shiftPeriod,
  goToday
} = useDailyReview({ standalone: true })

const dayPnlPct = computed(() => equityPnlPct(dayTotalPnl.value, equityForPct.value))

const headingLabel = computed(() => format(anchorDate.value, 'EEEE, MMMM d, yyyy'))

const isToday = computed(() => dateKey.value === format(new Date(), 'yyyy-MM-dd'))

watch(loading, (isLoading) => {
  if (!isLoading) hasLoadedOnce.value = true
})

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

function goToTrade(id) {
  if (id) router.push(`/trades/${id}`)
}
</script>
