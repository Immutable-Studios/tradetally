<template>
  <div
    v-if="authStore.isMentor"
    class="border-b border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100"
  >
    <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2 sm:px-6 lg:px-8">
      <span class="text-sm font-medium">
        Mentor mode — viewing
        {{ ownerLabel }}'s journal as {{ mentorEmail }}
      </span>
      <span class="text-sm text-sky-800/80 dark:text-sky-200/80">
        You can use the journal normally, but import settings stay locked.
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()

const ownerLabel = computed(() => {
  const owner = authStore.mentorAccess?.owner
  return owner?.fullName || owner?.username || owner?.email || 'this account'
})

const mentorEmail = computed(() => authStore.mentorAccess?.mentor?.email || 'mentor')
</script>
