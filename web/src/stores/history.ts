// Pinia store for the history modal.
// Holds a paginated list of clips sorted by recordedAt (the server returns
// them in that order). Exposes open/close state so App.vue can render the
// HistoryModal in the right place without vue-router.

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetchHistory, type HistoryClip } from '@/api/history'

const PAGE_LIMIT = 30 // match legacy app.ts constant

export const useHistoryStore = defineStore('history', () => {
  // Modal visibility — toggled by Toolbar and HistoryModal itself.
  const isOpen = ref(false)

  // The flat list of clips accumulated across pages.
  const clips = ref<HistoryClip[]>([])

  // nextSince cursor returned by the last page load. undefined = no more pages.
  const nextSince = ref<number | undefined>(undefined)

  // True while a fetch is in-flight (prevents double-loads).
  const loading = ref(false)

  // Non-null when the most recent fetch failed.
  const error = ref<string | null>(null)

  // Whether there are more pages available (i.e. last response sent a nextSince).
  function hasMore(): boolean {
    return nextSince.value !== undefined
  }

  /** Load the first page, replacing any existing list. */
  async function loadFirst(): Promise<void> {
    if (loading.value) return
    loading.value = true
    error.value = null
    clips.value = []
    nextSince.value = undefined
    try {
      const page = await fetchHistory({ limit: PAGE_LIMIT })
      clips.value = page.items
      nextSince.value = page.nextSince
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load history'
    } finally {
      loading.value = false
    }
  }

  /** Append the next page onto the existing list. */
  async function loadMore(): Promise<void> {
    if (loading.value || !hasMore()) return
    loading.value = true
    error.value = null
    try {
      const page = await fetchHistory({ limit: PAGE_LIMIT, since: nextSince.value })
      clips.value.push(...page.items)
      nextSince.value = page.nextSince
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load history'
    } finally {
      loading.value = false
    }
  }

  /** Open the modal and immediately kick off a fresh first-page load. */
  function open(): void {
    isOpen.value = true
    void loadFirst()
  }

  /** Close the modal (list is kept in memory so re-open is instant). */
  function close(): void {
    isOpen.value = false
  }

  return {
    isOpen,
    clips,
    nextSince,
    loading,
    error,
    hasMore,
    open,
    close,
    loadFirst,
    loadMore,
  }
})
