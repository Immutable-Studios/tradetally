<template>
  <div ref="rootEl" class="bg-gray-50/60 dark:bg-gray-900/30">
    <div v-if="!visible" class="flex items-center justify-center" :style="{ height }">
      <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <div v-if="requiresPro" class="flex flex-col items-center justify-center gap-1 px-3 text-center" :style="{ height }">
        <p class="text-xs text-gray-500 dark:text-gray-400">Chart preview requires Pro access.</p>
      </div>

      <div v-else-if="loading" class="flex items-center justify-center" :style="{ height }">
        <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"></div>
      </div>

      <div v-else-if="error" class="flex flex-col items-center justify-center gap-1 px-3 text-center" :style="{ height }">
        <p class="text-xs text-gray-500 dark:text-gray-400">{{ error }}</p>
        <button
          type="button"
          class="text-xs font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400"
          @click="load"
        >
          Retry
        </button>
      </div>

      <div
        v-else-if="!chartData?.candles?.length"
        class="flex items-center justify-center"
        :style="{ height }"
      >
        <p class="text-xs text-gray-400 dark:text-gray-500">No chart data available</p>
      </div>

      <KLineTradeChart
        v-else
        compact
        :height="height"
        :chart-data="chartData"
        :timezone="userTimezone"
        :right-padding-bars="20"
      />
    </template>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import KLineTradeChart from '@/components/trades/KLineTradeChart.vue'
import { useTradeChartData } from '@/composables/useTradeChartData'
import { useUserTimezone } from '@/composables/useUserTimezone'

const props = defineProps({
  tradeId: {
    type: String,
    required: true
  },
  resolution: {
    type: String,
    default: '5'
  },
  height: {
    type: String,
    default: '480px'
  },
  /** When set, load charts via the public daily-share endpoint (no login). */
  shareToken: {
    type: String,
    default: null
  }
})

const { userTimezone } = useUserTimezone()
const { loading, error, requiresPro, chartData, fetchChartData } = useTradeChartData(
  props.resolution,
  {
    chartUrlForTrade: props.shareToken
      ? (tradeId) => `/public/daily-review/${props.shareToken}/trades/${tradeId}/chart-data`
      : undefined
  }
)

const rootEl = ref(null)
const visible = ref(false)
let observer = null

function load() {
  fetchChartData(props.tradeId, props.resolution)
}

function observeVisibility() {
  if (typeof IntersectionObserver === 'undefined') {
    visible.value = true
    load()
    return
  }

  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      visible.value = true
      load()
      observer?.disconnect()
      observer = null
    }
  }, { rootMargin: '300px 0px', threshold: 0.01 })

  if (rootEl.value) observer.observe(rootEl.value)
}

onMounted(observeVisibility)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

watch(() => props.tradeId, () => {
  if (visible.value) load()
})
</script>
