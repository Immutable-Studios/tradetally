<template>
  <div class="content-wrapper py-8">
    <div class="mb-6 flex flex-col gap-2">
      <div class="inline-flex w-fit items-center gap-1.5 rounded-full bg-primary-50 px-3 py-1 text-xs font-medium text-primary-700 dark:bg-primary-900/20 dark:text-primary-400">
        <LinkIcon class="h-3.5 w-3.5" />
        Shared daily review · layout v2
      </div>
      <h1 class="heading-page">
        {{ headingLabel }}
      </h1>
      <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
        <!-- Naming the account matters: one review per account means several
             of these links can arrive the same afternoon. -->
        <span v-if="account" class="font-medium text-gray-700 dark:text-gray-300">Account {{ account }} · </span>
        Read-only session review — bold P&amp;L, open durations, and padded charts.
      </p>
    </div>

    <div v-if="loading" class="flex items-center gap-2 py-16 text-sm text-gray-500 dark:text-gray-400">
      <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary-600 border-t-transparent"></div>
      Loading shared review…
    </div>

    <div v-else-if="notFound" class="card">
      <div class="card-body py-16 text-center">
        <h2 class="heading-section">This link isn't available</h2>
        <p class="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
          The share link is invalid or has expired. Ask for a fresh link, or log in to view your own Daily Review.
        </p>
        <router-link to="/login" class="btn-primary mt-6 inline-flex">
          Log in
        </router-link>
      </div>
    </div>

    <div v-else-if="errorMessage" class="card">
      <div class="card-body py-16 text-center">
        <h2 class="heading-section">Something went wrong</h2>
        <p class="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">{{ errorMessage }}</p>
      </div>
    </div>

    <template v-else>
      <DailyAccountStrip
        :strip="accountStrip"
        :open-positions="openPositions"
        :equity-for-pct="equityForPct"
      />

      <!-- Stats strip -->
      <div class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="card card-mobile-safe">
          <div class="card-body">
            <dt class="text-data-secondary">Day P&amp;L</dt>
            <dd class="mt-1 text-2xl font-semibold tabular-nums" :class="pnlClass(dayTotalPnl)">
              {{ formatCurrency(dayTotalPnl) }}
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

      <DayActivityList
        :contributions="contributions"
        :opened-trades="openedTrades"
        :open-positions="openPositions"
        :equity-for-pct="equityForPct"
        :date-label="headingLabel"
        :share-token="String(route.params.token || '')"
      />
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { format, parseISO, isValid } from 'date-fns'
import { LinkIcon } from '@heroicons/vue/24/outline'
import DayActivityList from '@/components/daily/DayActivityList.vue'
import DailyAccountStrip from '@/components/daily/DailyAccountStrip.vue'
import { useSharedDailyReview } from '@/composables/useSharedDailyReview'
import { useCurrencyFormatter } from '@/composables/useCurrencyFormatter'
import { equityPnlPct } from '@/utils/tradeNotional'

const route = useRoute()
const { formatCurrency } = useCurrencyFormatter()

const {
  loading,
  notFound,
  errorMessage,
  dateKey,
  account,
  accountStrip,
  equityForPct,
  contributions,
  openedTrades,
  openPositions,
  dayTotalPnl,
  winCount,
  lossCount,
  winRate,
  unrealizedTotal,
  load
} = useSharedDailyReview(route.params.token)

const dayPnlPct = computed(() => equityPnlPct(dayTotalPnl.value, equityForPct.value))

const headingLabel = computed(() => {
  if (!dateKey.value) return 'Daily review'
  const parsed = parseISO(dateKey.value)
  return isValid(parsed) ? format(parsed, 'EEEE, MMMM d, yyyy') : dateKey.value
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

onMounted(load)
</script>
