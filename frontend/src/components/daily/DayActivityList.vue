<template>
  <div class="card h-full">
    <div class="card-body">
      <div class="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 class="heading-card">Day's trades</h2>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Realized activity and entries from this session
          </p>
        </div>
        <span class="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
          {{ sortedRows.length }}
        </span>
      </div>

      <div v-if="!sortedRows.length" class="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center dark:border-gray-600">
        <p class="text-sm font-medium text-gray-900 dark:text-white">No trade activity this day</p>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Entries, exits, and partials for {{ dateLabel }} will show up here.
        </p>
      </div>

      <div v-else class="space-y-3">
        <div
          v-for="row in sortedRows"
          :key="row.key"
          class="group overflow-hidden rounded-lg border border-gray-200 bg-white text-left transition-colors hover:border-primary-300 dark:border-gray-700 dark:bg-gray-800/40 dark:hover:border-primary-700"
        >
          <button
            type="button"
            class="flex w-full items-start justify-between gap-4 p-4 text-left transition-colors hover:bg-primary-50/40 dark:hover:bg-primary-900/10"
            @click="$emit('select-trade', row.tradeId)"
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-semibold text-gray-900 dark:text-white">{{ row.symbol }}</span>
                <span
                  class="rounded-full px-2 py-0.5 text-xs font-semibold"
                  :class="sideClass(row.side, row.symbol)"
                >
                  {{ sideLabel(row.side, row.symbol) }}
                </span>
                <span
                  class="rounded-full px-2 py-0.5 text-xs font-semibold"
                  :class="row.status === 'open'
                    ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300'
                    : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'"
                >
                  {{ row.status === 'open' ? 'Open' : 'Closed' }}
                </span>
                <span
                  v-if="row.isPartial"
                  class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                >
                  {{ row.partialLabel }}
                </span>
              </div>
              <p v-if="row.subtitle" class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {{ row.subtitle }}
              </p>
              <p v-if="row.equityUsedPct != null" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {{ formatPct(row.equityUsedPct) }} of equity at open
              </p>
            </div>
            <div class="shrink-0 text-right">
              <template v-if="row.status === 'closed'">
                <p class="text-lg font-bold tabular-nums" :class="pnlClass(row.pnl)">
                  {{ showRValue && row.rValue != null ? formatR(row.rValue) : formatCurrency(row.pnl) }}
                </p>
                <p v-if="showRValue && row.rValue != null" class="text-xs font-bold" :class="pnlClass(row.pnl)">
                  {{ formatCurrency(row.pnl) }}
                </p>
                <p
                  v-if="row.equityPnlPct != null"
                  class="mt-0.5 text-xs font-bold tabular-nums"
                  :class="pnlClass(row.equityPnlPct)"
                >
                  {{ formatPct(row.equityPnlPct) }} equity
                </p>
              </template>
              <template v-else>
                <template v-if="row.unrealizedPnL != null">
                  <p class="text-lg font-bold tabular-nums" :class="pnlClass(row.unrealizedPnL)">
                    {{ formatSigned(row.unrealizedPnL) }}
                  </p>
                  <p
                    v-if="row.equityPnlPct != null"
                    class="mt-0.5 text-xs font-bold tabular-nums"
                    :class="pnlClass(row.equityPnlPct)"
                  >
                    {{ formatPct(row.equityPnlPct) }} equity
                  </p>
                  <p
                    v-else-if="row.unrealizedPnLPercent != null"
                    class="text-xs font-bold tabular-nums"
                    :class="pnlClass(row.unrealizedPnLPercent)"
                  >
                    {{ formatPercent(row.unrealizedPnLPercent) }}
                  </p>
                </template>
                <template v-else-if="row.unrealizedPnLPercent != null">
                  <p
                    class="text-xs font-bold tabular-nums"
                    :class="pnlClass(row.unrealizedPnLPercent)"
                  >
                    {{ formatPercent(row.unrealizedPnLPercent) }}
                  </p>
                </template>
              </template>
              <p class="mt-1 text-xs text-primary-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-primary-400">
                View trade →
              </p>
            </div>
          </button>
          <InlineTradeChart
            v-if="row.tradeId"
            :trade-id="row.tradeId"
            :share-token="shareToken"
            height="480px"
            class="border-t border-gray-100 dark:border-gray-700/60"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { format, parseISO, isValid } from 'date-fns'
import InlineTradeChart from '@/components/daily/InlineTradeChart.vue'
import { useCurrencyFormatter } from '@/composables/useCurrencyFormatter'
import { formatR } from '@/utils/rFormat'
import { economicSide, sideLabel } from '@/utils/inverseEtfs'
import { equityPnlPct, equityUsedPct, tradeNotional } from '@/utils/tradeNotional'

const props = defineProps({
  contributions: { type: Array, default: () => [] },
  openedTrades: { type: Array, default: () => [] },
  /** Live open book — used to attach unrealized % to still-open day entries. */
  openPositions: { type: Array, default: () => [] },
  /** Account equity denominator for "% of equity" (usually SOD Net Liq). */
  equityForPct: { type: Number, default: null },
  dateLabel: { type: String, default: '' },
  showRValue: { type: Boolean, default: false },
  /** Public share token — enables chart loads without login on shared pages. */
  shareToken: { type: String, default: null }
})

defineEmits(['select-trade'])

const { formatCurrency } = useCurrencyFormatter()

const sortedRows = computed(() => {
  const closed = props.contributions.map((contrib, index) => {
    const pnl = Number(contrib.pnl) || 0
    const equity = Number(props.equityForPct)
    const fallbackUsed = equityUsedPct(contrib, props.equityForPct)
    const fallbackPnl = Number.isFinite(equity) && equity > 0
      ? Math.round((pnl / equity) * 10000) / 100
      : null
    return {
      key: `closed-${contrib.trade_id}-${index}`,
      tradeId: contrib.trade_id,
      symbol: contrib.symbol,
      side: contrib.side,
      status: 'closed',
      isPartial: !!contrib.is_partial,
      partialLabel: (contrib.exit_count || 1) > 1 ? `Partial (${contrib.exit_count})` : 'Partial',
      subtitle: contrib.risk_amount != null ? `Risk ${formatCurrency(contrib.risk_amount)}` : '',
      pnl,
      rValue: contrib.r_value,
      equityUsedPct: contrib.equity_used_pct ?? fallbackUsed,
      equityPnlPct: contrib.equity_pnl_pct ?? fallbackPnl,
      dollarSize: Math.abs(pnl)
    }
  })

  const opened = props.openedTrades.map((trade) => {
    const metrics = openMetrics(trade)
    const qty = Number(trade.quantity)
    const entry = Number(trade.entry_price)
    const notional = tradeNotional(trade) || (
      Number.isFinite(qty) && Number.isFinite(entry) ? Math.abs(qty * entry) : 0
    )
    const unrealized = metrics.unrealizedPnL != null ? Math.abs(Number(metrics.unrealizedPnL) || 0) : 0
    return {
      key: `open-${trade.id}`,
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      status: 'open',
      isPartial: false,
      partialLabel: '',
      subtitle: [
        Number.isFinite(qty) && Number.isFinite(entry)
          ? `${formatQty(qty)} @ ${formatCurrency(entry)}`
          : null,
        trade.entry_time ? formatTime(trade.entry_time) : null
      ].filter(Boolean).join(' · '),
      unrealizedPnL: metrics.unrealizedPnL,
      unrealizedPnLPercent: metrics.unrealizedPnLPercent,
      equityUsedPct: equityUsedPct(trade, props.equityForPct),
      equityPnlPct: equityPnlPct(metrics.unrealizedPnL, props.equityForPct),
      dollarSize: unrealized || notional
    }
  })

  return [...closed, ...opened].sort((a, b) => b.dollarSize - a.dollarSize)
})

function sideClass(side, symbol) {
  // Color by economic exposure: long inverse ETF → short-biased (red).
  return economicSide(side, symbol) === 'long'
    ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400'
    : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400'
}

function pnlClass(value) {
  return (Number(value) || 0) >= 0
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400'
}

function formatQty(qty) {
  const n = Number(qty)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString()
}

function formatTime(value) {
  try {
    const d = typeof value === 'string' ? parseISO(value) : new Date(value)
    if (!isValid(d)) return ''
    return format(d, 'h:mm a')
  } catch {
    return ''
  }
}

function formatSigned(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const formatted = formatCurrency(Math.abs(n))
  return n >= 0 ? `+${formatted}` : `-${formatted}`
}

function formatPercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function formatPct(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function openMetrics(trade) {
  const byId = props.openPositions.find((pos) =>
    (pos.trades || []).some((t) => t.id === trade.id)
  )
  if (byId) {
    return {
      unrealizedPnL: byId.unrealizedPnL,
      unrealizedPnLPercent: byId.unrealizedPnLPercent
    }
  }

  const bySymbol = props.openPositions.find((pos) =>
    pos.symbol === trade.symbol && pos.side === trade.side
  )
  if (bySymbol) {
    return {
      unrealizedPnL: bySymbol.unrealizedPnL,
      unrealizedPnLPercent: bySymbol.unrealizedPnLPercent
    }
  }

  if (trade.pnl_percent != null || trade.pnlPercent != null) {
    return {
      unrealizedPnL: trade.pnl ?? trade.unrealizedPnL ?? null,
      unrealizedPnLPercent: trade.pnl_percent ?? trade.pnlPercent ?? null
    }
  }

  return { unrealizedPnL: null, unrealizedPnLPercent: null }
}
</script>
