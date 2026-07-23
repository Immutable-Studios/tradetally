<template>
  <div v-if="hasAny" class="card mb-6">
    <div class="card-body">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 class="heading-card">Account</h2>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Exposure vs equity at review time
            <span v-if="strip?.fetchedAt"> · {{ formatFetched(strip.fetchedAt) }}</span>
          </p>
        </div>
      </div>

      <dl class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div v-for="row in rows" :key="row.label">
          <dt class="text-data-secondary">{{ row.label }}</dt>
          <dd
            class="mt-1 text-base font-semibold tabular-nums"
            :class="row.forceTone
              || (row.tone ? pnlClass(row.raw) : 'text-gray-900 dark:text-white')"
          >
            {{ row.display }}
          </dd>
          <div
            v-if="row.subdisplay"
            class="mt-0.5 text-xs font-semibold tabular-nums"
            :class="row.forceTone
              || (row.tone ? pnlClass(row.subraw ?? row.raw) : 'text-gray-500 dark:text-gray-400')"
          >
            {{ row.subdisplay }}
          </div>
        </div>
      </dl>

      <div v-if="openRows.length" class="mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
        <div class="mb-2 flex items-baseline justify-between gap-3">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Open</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            {{ openRows.length }} {{ openRows.length === 1 ? 'position' : 'positions' }}
            · % of equity
          </p>
        </div>
        <ul class="flex flex-wrap gap-x-5 gap-y-1.5 text-sm tabular-nums">
          <li
            v-for="row in openRows"
            :key="row.symbol"
            class="inline-flex items-baseline gap-1.5 font-medium"
            :class="row.economicSide === 'short'
              ? 'text-red-700 dark:text-red-400'
              : 'text-green-700 dark:text-green-400'"
          >
            <span class="font-semibold">{{ row.symbol }}</span>
            <span class="opacity-80">{{ formatOpenPct(row.equityPct) }} of eq</span>
            <span
              v-if="row.inverse"
              class="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400"
            >inv</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { format, parseISO, isValid } from 'date-fns'
import { useCurrencyFormatter } from '@/composables/useCurrencyFormatter'
import { equityPnlPct, exposureEquityPercents, openPositionEquityRows } from '@/utils/tradeNotional'

const props = defineProps({
  strip: { type: Object, default: null },
  /** Live open book — used for long/short equity % and open ticker list. */
  openPositions: { type: Array, default: () => [] },
  /** Account equity denominator (usually SOD Net Liq). */
  equityForPct: { type: Number, default: null }
})

const { formatCurrency } = useCurrencyFormatter()

const equity = computed(() => {
  const fromProp = Number(props.equityForPct)
  if (Number.isFinite(fromProp) && fromProp > 0) return fromProp
  const fromStrip = Number(props.strip?.equityForPct ?? props.strip?.sodNetLiq ?? props.strip?.netLiq)
  return Number.isFinite(fromStrip) && fromStrip > 0 ? fromStrip : null
})

const dayPl = computed(() => {
  const n = Number(props.strip?.dayPl ?? props.strip?.dayPlApprox)
  return Number.isFinite(n) ? n : null
})

const exposure = computed(() => exposureEquityPercents(props.openPositions, equity.value))

const dayPlPct = computed(() => equityPnlPct(dayPl.value, equity.value))

const openHeat = computed(() => {
  const n = Number(props.strip?.openHeat)
  return Number.isFinite(n) ? n : null
})

const openHeatPct = computed(() => {
  const fromStrip = Number(props.strip?.openHeatPct)
  if (Number.isFinite(fromStrip)) return fromStrip
  return equityPnlPct(openHeat.value, equity.value)
})

const openRows = computed(() => openPositionEquityRows(props.openPositions, equity.value))

const rows = computed(() => {
  const s = props.strip || {}
  const list = [
    { label: 'Net Liq', display: formatMoney(s.netLiq), raw: s.netLiq },
    { label: 'P/L Day', display: formatMoney(dayPl.value), raw: dayPl.value, tone: true },
    {
      label: 'Open Heat',
      display: formatMoney(openHeat.value),
      raw: openHeat.value,
      // Heat is risk dollars — always red, not a P/L sign.
      forceTone: 'text-red-600 dark:text-red-400',
      subdisplay: openHeatPct.value != null ? `${formatPct(openHeatPct.value)} of equity` : null
    },
    {
      label: '% Equity Long',
      display: formatPct(exposure.value.longEquityPct),
      raw: exposure.value.longEquityPct
    },
    {
      label: '% Equity Short',
      display: formatPct(exposure.value.shortEquityPct),
      raw: exposure.value.shortEquityPct
    },
    {
      label: 'P/L % Day',
      display: formatPct(dayPlPct.value),
      raw: dayPlPct.value,
      tone: true
    }
  ]
  return list.filter((row) => row.raw != null && Number.isFinite(Number(row.raw)))
})

const hasAny = computed(() => rows.value.length > 0 || openRows.value.length > 0)

function formatMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  if (n < 0) return `(${formatCurrency(Math.abs(n))})`
  return formatCurrency(n)
}

function formatPct(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(2)}%`
}

function formatOpenPct(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  // Whole percent when ≥10, one decimal otherwise (e.g. SOXS 12% / MSCI 0.2%)
  if (Math.abs(n) >= 10) return `${Math.round(n)}%`
  return `${n.toFixed(1)}%`
}

function pnlClass(value) {
  return (Number(value) || 0) >= 0
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400'
}

function formatFetched(value) {
  try {
    const d = parseISO(value)
    return isValid(d) ? format(d, 'h:mm a') : ''
  } catch {
    return ''
  }
}
</script>
