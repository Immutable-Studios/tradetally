<template>
  <div class="card h-full">
    <div class="card-body">
      <div class="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 class="heading-card">Open positions</h2>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Live book right now — not filtered to this day
          </p>
        </div>
        <div class="flex items-center gap-2">
          <div
            v-if="loading"
            class="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400"
          >
            <div class="h-3 w-3 animate-spin rounded-full border-[1.5px] border-primary-600 border-t-transparent"></div>
            Updating
          </div>
          <span class="inline-flex items-center rounded-full bg-primary-100 px-2.5 py-0.5 text-xs font-medium text-primary-800 dark:bg-primary-900/20 dark:text-primary-400">
            {{ positions.length }} {{ positions.length === 1 ? 'position' : 'positions' }}
          </span>
        </div>
      </div>

      <p v-if="error" class="mb-3 text-xs text-amber-700 dark:text-amber-300">
        {{ error }}
      </p>

      <div v-if="!positions.length" class="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center dark:border-gray-600">
        <p class="text-sm font-medium text-gray-900 dark:text-white">No open positions</p>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Flat book — nothing marked open in the journal.
        </p>
      </div>

      <div v-else class="space-y-3">
        <button
          v-for="position in positions"
          :key="positionKey(position)"
          type="button"
          class="flex w-full items-start justify-between gap-3 rounded-lg border border-gray-200 p-4 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/40 dark:border-gray-700 dark:hover:border-primary-700 dark:hover:bg-primary-900/10"
          @click="openPosition(position)"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-gray-900 dark:text-white">{{ position.symbol }}</span>
              <span class="rounded-full px-2 py-0.5 text-xs font-semibold" :class="sideClass(position.side, position.symbol)">
                {{ sideLabel(position.side, position.symbol) }}
              </span>
            </div>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ formatQty(position.totalQuantity) }} held
              <span v-if="position.avgPrice != null"> · avg {{ formatCurrency(position.avgPrice) }}</span>
            </p>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Open {{ formatOpenDuration(position) }}
              <span v-if="position.trades?.length">
                · {{ position.trades.length }} {{ position.trades.length === 1 ? 'lot' : 'lots' }}
              </span>
            </p>
            <p v-if="equityUsed(position) != null" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ formatPct(equityUsed(position)) }} of equity at open
            </p>
          </div>
          <div class="shrink-0 text-right">
            <template v-if="position.unrealizedPnL != null">
              <p class="text-lg font-bold tabular-nums" :class="pnlClass(position.unrealizedPnL)">
                {{ formatSigned(position.unrealizedPnL) }}
              </p>
              <p
                v-if="equityReturn(position) != null"
                class="mt-0.5 text-xs font-bold tabular-nums"
                :class="pnlClass(equityReturn(position))"
              >
                {{ formatPct(equityReturn(position)) }} equity
              </p>
              <p
                v-else-if="position.unrealizedPnLPercent != null"
                class="text-xs font-bold"
                :class="pnlClass(position.unrealizedPnLPercent)"
              >
                {{ position.unrealizedPnLPercent >= 0 ? '+' : '' }}{{ Number(position.unrealizedPnLPercent).toFixed(2) }}%
              </p>
            </template>
            <template v-else-if="position.currentPrice != null">
              <p class="text-sm text-gray-700 dark:text-gray-300">{{ formatCurrency(position.currentPrice) }}</p>
              <p class="text-xs text-gray-400">Mark</p>
            </template>
            <p v-else class="text-xs text-gray-400">No quote</p>
          </div>
        </button>

        <div
          v-if="unrealizedTotal != null"
          class="flex items-center justify-between rounded-lg border-2 border-gray-300 bg-gray-50 px-4 py-3 dark:border-gray-600 dark:bg-gray-800/60"
        >
          <span class="text-sm font-semibold text-gray-900 dark:text-white">Total unrealized</span>
          <span class="text-base font-bold tabular-nums" :class="pnlClass(unrealizedTotal)">
            {{ formatSigned(unrealizedTotal) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { useCurrencyFormatter } from '@/composables/useCurrencyFormatter'
import { economicSide, sideLabel } from '@/utils/inverseEtfs'
import { equityPnlPct, equityUsedPct, positionNotional } from '@/utils/tradeNotional'

const props = defineProps({
  positions: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: null },
  unrealizedTotal: { type: Number, default: null },
  /** Account equity denominator for "% of equity". */
  equityForPct: { type: Number, default: null }
})

const router = useRouter()
const { formatCurrency } = useCurrencyFormatter()

function equityUsed(position) {
  const notional = positionNotional(position)
  const eq = Number(props.equityForPct)
  if (notional == null || !Number.isFinite(eq) || eq <= 0) {
    return equityUsedPct(position.trades?.[0], props.equityForPct)
  }
  return Math.round((notional / eq) * 10000) / 100
}

function equityReturn(position) {
  return equityPnlPct(position.unrealizedPnL, props.equityForPct)
}

function formatPct(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function positionKey(position) {
  return position.positionKey || `${position.symbol}-${position.side}-${position.trades?.[0]?.id || 'x'}`
}

function sideClass(side, symbol) {
  const econ = economicSide(side, symbol)
  if (econ === 'long') return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400'
  if (econ === 'short') return 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400'
  return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
}

function pnlClass(value) {
  return (Number(value) || 0) >= 0
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400'
}

function formatQty(qty) {
  const n = Number(qty)
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return 'Hedged'
  return n.toLocaleString()
}

function formatSigned(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const formatted = formatCurrency(Math.abs(n))
  return n >= 0 ? `+${formatted}` : `-${formatted}`
}

function earliestEntryTime(position) {
  const times = (position.trades || [])
    .map((t) => t.entry_time || t.entryTime || t.trade_date)
    .filter(Boolean)
    .map((t) => new Date(t).getTime())
    .filter(Number.isFinite)
  if (!times.length) return null
  return new Date(Math.min(...times))
}

function formatOpenDuration(position) {
  const start = earliestEntryTime(position)
  if (!start) return '—'

  const ms = Date.now() - start.getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'

  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  if (hours < 24) return remMin ? `${hours}h ${remMin}m` : `${hours}h`

  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours ? `${days}d ${remHours}h` : `${days}d`
}

function openPosition(position) {
  const tradeId = position.trades?.[0]?.id
  if (tradeId) router.push(`/trades/${tradeId}`)
}
</script>
