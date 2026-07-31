<template>
  <div
    v-if="authStore.isMentor"
    class="border-b border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100"
  >
    <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-2 sm:px-6 lg:px-8">
      <div class="min-w-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        <span class="font-medium">
          Viewing
          <span class="font-semibold">{{ ownerLabel }}</span>'s journal
        </span>
        <span class="text-sky-700/70 dark:text-sky-200/70" aria-hidden="true">·</span>
        <span class="text-sky-800 dark:text-sky-200">
          signed in as
          <span class="font-semibold text-sky-950 dark:text-sky-50">{{ mentorLabel }}</span>
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <router-link
          to="/daily"
          class="font-medium text-sky-800 underline-offset-2 hover:underline dark:text-sky-200"
        >
          Mentee's daily
        </router-link>
        <span class="hidden text-sky-700/80 sm:inline dark:text-sky-200/70">
          Journal is open; import settings stay locked.
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()

const ownerLabel = computed(() => authStore.menteeDisplayName || 'this account')

const mentorLabel = computed(() => {
  const mentor = authStore.mentorAccess?.mentor
  return (
    mentor?.email ||
    mentor?.full_name ||
    mentor?.fullName ||
    mentor?.username ||
    authStore.sessionEmail ||
    'mentor'
  )
})
</script>
