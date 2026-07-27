<template>
  <div
    class="flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/40"
    role="note"
  >
    <InformationCircleIcon class="h-5 w-5 flex-shrink-0 text-blue-500 dark:text-blue-400" aria-hidden="true" />
    <div class="text-sm text-blue-800 dark:text-blue-200">
      <p>
        <span class="font-medium">Tracking starts {{ DATA_START_DATE_LABEL }}.</span>
        {{ detail }}
      </p>
      <p v-if="$slots.default" class="mt-1 text-blue-700 dark:text-blue-300">
        <slot />
      </p>
    </div>
  </div>
</template>

<script setup>
// Reminder that this instance keeps no trade history before DATA_START_DATE.
// Shown wherever a user could otherwise expect older data to appear: the
// dashboard, the CSV importer, and broker sync.
import { computed } from 'vue'
import { InformationCircleIcon } from '@heroicons/vue/24/outline'
import { DATA_START_DATE_LABEL } from '@/config/dataStart'

const props = defineProps({
  // Where the notice is shown, which decides the second sentence.
  context: {
    type: String,
    default: 'general',
    validator: (value) => ['general', 'import', 'sync'].includes(value)
  }
})

const detail = computed(() => {
  switch (props.context) {
    case 'import':
      return 'Rows dated earlier are skipped — they will show in the import summary but are not saved.'
    case 'sync':
      return 'Broker syncs are capped at this date, so earlier executions are never pulled in.'
    default:
      return 'Trades before this date were removed and are no longer recorded.'
  }
})
</script>
