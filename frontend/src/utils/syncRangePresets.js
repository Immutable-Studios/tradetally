import { DATA_START_DATE, clampToDataStart } from '@/config/dataStart'

function toIsoDate(date) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function daysAgo(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return toIsoDate(d)
}

function yearsAgo(years) {
  const d = new Date()
  d.setFullYear(d.getFullYear() - years)
  return toIsoDate(d)
}

function yearStart() {
  const d = new Date()
  return toIsoDate(new Date(d.getFullYear(), 0, 1))
}

export const syncRangePresets = [
  // 'all' still means "everything this instance holds" — which begins at
  // DATA_START_DATE, not at the account's first ever trade.
  { id: 'all', label: 'All Time' },
  { id: 'ytd', label: 'This Year' },
  { id: '30d', label: 'Last 30 Days' },
  { id: '90d', label: 'Last 90 Days' },
  { id: '1y', label: 'Last 1 Year' },
  { id: 'custom', label: 'Custom' }
]

export const todayIso = toIsoDate(new Date())

// Earliest date any sync window may start. The backend clamps to this too; doing
// it here keeps the picker honest about what a preset will actually fetch.
export const minSyncStartDate = DATA_START_DATE

export function applyPresetToForm(form, presetId) {
  switch (presetId) {
    case 'all':
      form.syncStartDate = DATA_START_DATE
      break
    case 'ytd':
      form.syncStartDate = clampToDataStart(yearStart())
      break
    case '30d':
      form.syncStartDate = clampToDataStart(daysAgo(30))
      break
    case '90d':
      form.syncStartDate = clampToDataStart(daysAgo(90))
      break
    case '1y':
      form.syncStartDate = clampToDataStart(yearsAgo(1))
      break
    case 'custom':
      // Keep whatever date is already set; otherwise seed with today.
      form.syncStartDate = clampToDataStart(form.syncStartDate || todayIso)
      break
  }
}

// Detect which preset a stored sync_start_date was generated from. Used to
// re-highlight the chip when opening an existing connection. Returns 'custom'
// for any date that doesn't match a preset boundary, 'all' when the date is
// null/empty or sits at the data start date.
//
// The data start date is checked first on purpose: while the cutoff is recent,
// every lookback preset clamps onto it, and "All Time" is the truthful label for
// a window that already reaches as far back as this instance goes.
export function resolveActivePreset(syncStartDate) {
  if (!syncStartDate) return 'all'
  const normalized = String(syncStartDate).slice(0, 10)
  if (normalized <= DATA_START_DATE) return 'all'
  if (normalized === yearStart()) return 'ytd'
  if (normalized === daysAgo(30)) return '30d'
  if (normalized === daysAgo(90)) return '90d'
  if (normalized === yearsAgo(1)) return '1y'
  return 'custom'
}
