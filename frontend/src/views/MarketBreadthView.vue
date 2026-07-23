<template>
  <div class="content-wrapper py-5">
    <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
      <div>
        <h1 class="heading-page">Market Breadth</h1>
        <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
          jfsrev top-down RS board · RS vs {{ benchmark }} · ~25 sessions · Schwab · 60s refresh
        </p>
      </div>
      <div class="text-right text-xs text-gray-500 dark:text-gray-400">
        <div v-if="asOfLabel">{{ asOfLabel }}</div>
      </div>
    </div>

    <div v-if="initialLoading" class="flex justify-center py-16">
      <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
    </div>

    <div
      v-else-if="error && !sections.length"
      class="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
    >
      {{ error }}
      <router-link v-if="needsReauth" to="/broker-sync" class="ml-2 font-medium underline">
        Open Broker Sync
      </router-link>
    </div>

    <div v-else class="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900">
      <table class="min-w-[980px] w-full text-[12px] leading-tight">
        <thead>
          <tr class="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
            <th class="sticky left-0 z-10 bg-white dark:bg-gray-900 text-left px-2 py-2 font-semibold">Ticker</th>
            <th class="text-left px-2 py-2 font-semibold">Name</th>
            <th
              class="text-right px-1.5 py-2 font-semibold"
              title="Approx. 60/40 week/month RS_Strength + small 3-session momentum tweak (Jeff has not published the final formula)"
            >
              RS Thrust %
            </th>
            <th
              class="text-right px-1.5 py-2 font-semibold"
              title="Change in RS ratio vs SPY over ~25 sessions: (RS_last/RS_first − 1)"
            >
              1-Mth RS %
            </th>
            <th class="text-left px-1.5 py-2 font-semibold">1-Mth Chart</th>
            <th class="text-left px-1.5 py-2 font-semibold">1-Mth RS</th>
            <th class="text-right px-1.5 py-2 font-semibold bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
              % Intraday
            </th>
            <th class="text-right px-1.5 py-2 font-semibold">% 1D</th>
            <th class="text-right px-1.5 py-2 font-semibold">% 1-Mth</th>
            <th class="text-right px-2 py-2 font-semibold">% Off 52W H</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="section in sections" :key="section.id">
            <tr class="bg-gray-50 dark:bg-gray-800/60">
              <td
                colspan="10"
                class="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-600 dark:text-gray-300"
              >
                {{ section.label }}
              </td>
            </tr>
            <tr
              v-for="row in section.rows"
              :key="`${section.id}-${row.symbol}-${row.name}`"
              class="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50/80 dark:hover:bg-gray-800/40"
            >
              <td
                class="sticky left-0 z-10 px-2 py-1 font-semibold text-mono-num whitespace-nowrap"
                :class="tickerCellClass(row)"
              >
                {{ row.symbol }}
              </td>
              <td class="px-2 py-1 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                {{ row.name }}
                <span v-if="row.note" class="text-gray-400"> ({{ row.note }})</span>
              </td>
              <td class="px-1.5 py-1 text-right text-mono-num" :class="heatClass(row.rsThrust)">
                {{ fmtPct(row.rsThrust) }}
              </td>
              <td class="px-1.5 py-1 text-right text-mono-num" :class="heatClass(row.rs1m)">
                {{ fmtPct(row.rs1m) }}
              </td>
              <td class="px-1.5 py-1">
                <LineSpark :values="row.sparkline" />
              </td>
              <td class="px-1.5 py-1">
                <BarSpark :values="row.rsSparkline" />
              </td>
              <td
                class="px-1.5 py-1 text-right text-mono-num font-semibold bg-rose-50/70 dark:bg-rose-950/30"
                :class="heatClass(row.pctIntraday)"
              >
                {{ fmtPct(row.pctIntraday) }}
              </td>
              <td class="px-1.5 py-1 text-right text-mono-num" :class="heatClass(row.pct1d)">
                {{ fmtPct(row.pct1d) }}
              </td>
              <td class="px-1.5 py-1 text-right text-mono-num" :class="heatClass(row.pct1m)">
                {{ fmtPct(row.pct1m) }}
              </td>
              <td class="px-2 py-1 text-right">
                <div class="inline-flex items-center gap-1.5 justify-end">
                  <div class="h-1.5 w-14 rounded-sm bg-gray-200 dark:bg-gray-700 overflow-hidden">
                    <div class="h-full bg-red-500/85" :style="{ width: off52Width(row.pctOff52w) }" />
                  </div>
                  <span class="text-mono-num text-red-600 dark:text-red-400 w-11 text-right">
                    {{ fmtPct(row.pctOff52w) }}
                  </span>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <p class="mt-3 text-[11px] text-gray-400 dark:text-gray-500 max-w-4xl">
      Per jfsrev: RS ratios are vs {{ benchmark }} over ~25 sessions; sectors/groups sorted by 1-Mth RS then Thrust;
      segments keep small→large order. RS Thrust is an approximation of his described 60/40 week/month blend
      (exact calibration not public). % Intraday = live Schwab day %; % 1D = prior session return from daily history.
    </p>
  </div>
</template>

<script setup>
import { computed, defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import api from '@/services/api'

const LineSpark = defineComponent({
  name: 'LineSpark',
  props: { values: { type: Array, default: () => [] } },
  setup(props) {
    return () => {
      const values = (props.values || []).filter((v) => typeof v === 'number')
      if (values.length < 2) return h('span', { class: 'text-gray-300' }, '—')
      const min = Math.min(...values)
      const max = Math.max(...values)
      const span = max - min || 1
      const w = 72
      const ht = 18
      const pts = values
        .map((v, i) => {
          const x = (i / (values.length - 1)) * w
          const y = ht - ((v - min) / span) * (ht - 2) - 1
          return `${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')
      const up = values[values.length - 1] >= values[0]
      return h('svg', { viewBox: `0 0 ${w} ${ht}`, class: 'w-[72px] h-[18px]' }, [
        h('polyline', {
          fill: 'none',
          stroke: up ? '#16a34a' : '#dc2626',
          'stroke-width': 1.4,
          points: pts
        })
      ])
    }
  }
})

const BarSpark = defineComponent({
  name: 'BarSpark',
  props: { values: { type: Array, default: () => [] } },
  setup(props) {
    return () => {
      const values = (props.values || []).filter((v) => typeof v === 'number')
      if (values.length < 2) return h('span', { class: 'text-gray-300' }, '—')
      const w = 72
      const ht = 18
      const mid = ht / 2
      const maxDev = Math.max(...values.map((v) => Math.abs(v - 1)), 0.01)
      const barW = Math.max(1.5, w / values.length - 0.5)
      const bars = values.map((v, i) => {
        const x = (i / values.length) * w
        const dev = (v - 1) / maxDev
        const bh = Math.abs(dev) * (mid - 1)
        const y = dev >= 0 ? mid - bh : mid
        return h('rect', {
          x: x.toFixed(1),
          y: y.toFixed(1),
          width: barW.toFixed(1),
          height: Math.max(0.5, bh).toFixed(1),
          fill: v >= 1 ? '#16a34a' : '#dc2626'
        })
      })
      return h('svg', { viewBox: `0 0 ${w} ${ht}`, class: 'w-[72px] h-[18px]' }, [
        h('line', { x1: 0, x2: w, y1: mid, y2: mid, stroke: '#d1d5db', 'stroke-width': 0.5 }),
        ...bars
      ])
    }
  }
})

const initialLoading = ref(true)
const error = ref(null)
const needsReauth = ref(false)
const sections = ref([])
const asOf = ref(null)
const benchmark = ref('SPY')
let timer = null

const asOfLabel = computed(() => {
  if (!asOf.value) return ''
  const d = new Date(asOf.value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
})

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

function heatClass(n) {
  if (n == null || Number.isNaN(n)) return 'text-gray-400'
  if (n > 0) return 'text-emerald-700 dark:text-emerald-400 bg-emerald-50/80 dark:bg-emerald-950/30'
  if (n < 0) return 'text-red-700 dark:text-red-400 bg-red-50/80 dark:bg-red-950/30'
  return 'text-gray-600 dark:text-gray-300'
}

function tickerCellClass(row) {
  if (row.highlight) return 'bg-yellow-200 dark:bg-yellow-700/50 text-gray-900 dark:text-white'
  if (row.note === 'rs reference' || row.note === 'reference') {
    return 'bg-white dark:bg-gray-900 text-emerald-600 dark:text-emerald-400'
  }
  return 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100'
}

function off52Width(n) {
  if (n == null || n >= 0) return '0%'
  return `${Math.min(100, Math.abs(n) * 2)}%`
}

async function load() {
  try {
    const { data } = await api.get('/market-breadth')
    sections.value = data.sections || []
    asOf.value = data.asOf || null
    benchmark.value = data.benchmark || 'SPY'
    needsReauth.value = Boolean(data.needsReauth)
    error.value = data.ok === false ? data.error || 'Unavailable' : null
  } catch (e) {
    const payload = e.response?.data
    sections.value = payload?.sections || sections.value
    needsReauth.value = Boolean(payload?.needsReauth)
    error.value = payload?.error || e.message || 'Failed to load board'
  } finally {
    initialLoading.value = false
  }
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 60_000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>
