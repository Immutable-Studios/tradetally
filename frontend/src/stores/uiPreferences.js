import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/services/api'

// Keys whose values live inside the user_settings.ui_preferences JSONB blob.
// The same key is also used as the localStorage key so callers can keep
// referencing the existing storage keys without renaming.
export const SYNCED_KEYS = Object.freeze([
  'darkMode',
  'tradeListColumns',
  'tradeListFullWidth',
  'tradeFilters',
  'tradeFiltersPeriod',
  'tradetally_global_account',
  'dashboardTimeRange',
  'dashboardCustomStartDate',
  'dashboardCustomEndDate',
  'dashboardRMode',
  'analyticsFilters',
  'behavioralAnalyticsFilters',
  'gamificationFilters',
  'gamificationTab',
  'marketsFilters',
  'marketsTab',
  'diaryFilters',
  'diaryView',
  'diarySearchQuery',
  'priceAlertsFilters',
  'monthlyPerformanceYear',
  'lastSelectedBroker',
  'passkey_prompt_dismissed',
  'hiddenStrategies',
  'hiddenSetups',
  'strategyOrder',
  'setupOrder',
  'tagOrder'
])

// Sticky filters that can hide the (small) post-purge trade set. Mentors must
// not inherit the owner's account/date selections or write them back.
export const MENTOR_SESSION_FILTER_KEYS = Object.freeze([
  'tradetally_global_account',
  'tradeFilters',
  'tradeFiltersPeriod',
  'dashboardTimeRange',
  'dashboardCustomStartDate',
  'dashboardCustomEndDate',
  'analyticsFilters',
  'behavioralAnalyticsFilters',
  'gamificationFilters',
  'monthlyPerformanceYear'
])

const SYNCED_KEY_SET = new Set(SYNCED_KEYS)
const MENTOR_FILTER_KEY_SET = new Set(MENTOR_SESSION_FILTER_KEYS)
const SYNC_DEBOUNCE_MS = 800

// Set by auth store — avoids a circular import with ./auth.
let mentorSessionActive = false

export function setMentorSessionActive(active) {
  mentorSessionActive = Boolean(active)
}

function readLocal(key) {
  const raw = localStorage.getItem(key)
  if (raw === null) return undefined
  // Try JSON; fall back to raw string for legacy plain values like '12345678'.
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function writeLocal(key, value) {
  if (value === undefined || value === null) {
    localStorage.removeItem(key)
    return
  }
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  localStorage.setItem(key, serialized)
}

export const useUiPreferencesStore = defineStore('uiPreferences', () => {
  const initialized = ref(false)
  const pending = ref({})
  let flushTimer = null
  let flushInFlight = null
  let initInFlight = null

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush()
    }, SYNC_DEBOUNCE_MS)
  }

  async function flush() {
    if (!initialized.value) return
    if (Object.keys(pending.value).length === 0) return
    // Mentors view the owner's journal; never persist their local filter tweaks
    // into the owner's synced preferences.
    if (mentorSessionActive) {
      pending.value = {}
      return
    }

    // Wait for any in-flight flush to settle so we send a coherent snapshot.
    if (flushInFlight) {
      try { await flushInFlight } catch (_) {}
    }

    const snapshot = pending.value
    pending.value = {}

    const payload = {}
    for (const key of SYNCED_KEYS) {
      const local = readLocal(key)
      if (local !== undefined) payload[key] = local
    }
    // Ensure deletions show up as explicit nulls in the payload.
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === undefined && payload[key] === undefined) {
        payload[key] = null
      }
    }

    flushInFlight = api.put('/settings', { uiPreferences: payload })
      .catch(err => {
        console.warn('[UI PREFS] Failed to sync to server, will retry on next change:', err?.response?.status || err?.message)
        // Re-queue the snapshot so the next change picks it up.
        pending.value = { ...snapshot, ...pending.value }
      })
      .finally(() => {
        flushInFlight = null
      })

    await flushInFlight
  }

  async function init({ mentorSession = false } = {}) {
    if (initialized.value) return
    if (initInFlight) return initInFlight

    initInFlight = (async () => {
      try {
        const response = await api.get('/settings')
        const remote = response.data?.settings?.uiPreferences || {}

        // Server wins: hydrate localStorage from server values.
        for (const key of SYNCED_KEYS) {
          if (mentorSession && MENTOR_FILTER_KEY_SET.has(key)) {
            // Mentors start from an unfiltered view of the mentee's journal.
            localStorage.removeItem(key)
            continue
          }
          if (Object.prototype.hasOwnProperty.call(remote, key)) {
            const value = remote[key]
            if (value === null || value === undefined) {
              localStorage.removeItem(key)
            } else {
              writeLocal(key, value)
            }
          }
        }

        // Apply dark mode immediately so the DOM matches before NavBar mounts.
        applyDarkModeFromStorage()

        initialized.value = true
      } catch (err) {
        console.warn('[UI PREFS] Failed to load remote preferences, continuing with local values:', err?.response?.status || err?.message)
        if (mentorSession) {
          for (const key of MENTOR_SESSION_FILTER_KEYS) {
            localStorage.removeItem(key)
          }
        }
        // Still mark as initialized so subsequent writes attempt to sync.
        initialized.value = true
      }
    })().finally(() => {
      initInFlight = null
    })

    await initInFlight
  }

  function applyDarkModeFromStorage() {
    const isDark = localStorage.getItem('darkMode') === 'true'
    document.documentElement.classList.toggle('dark', isDark)
  }

  // Called by refactored sites whenever they persist a preference locally.
  // The local write still happens at the call site so reads stay synchronous.
  function notifyChanged(key, value) {
    if (!SYNCED_KEY_SET.has(key)) return
    if (mentorSessionActive) return
    pending.value = { ...pending.value, [key]: value }
    scheduleFlush()
  }

  function reset() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pending.value = {}
    initialized.value = false
    initInFlight = null
    for (const key of SYNCED_KEYS) {
      localStorage.removeItem(key)
    }
    document.documentElement.classList.remove('dark')
  }

  /** Allow a subsequent init({ mentorSession: true }) without wiping theme prefs. */
  function invalidateForMentorSession() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pending.value = {}
    initialized.value = false
    initInFlight = null
    for (const key of MENTOR_SESSION_FILTER_KEYS) {
      localStorage.removeItem(key)
    }
  }

  return {
    initialized,
    init,
    notifyChanged,
    flush,
    reset,
    invalidateForMentorSession,
    applyDarkModeFromStorage
  }
})
