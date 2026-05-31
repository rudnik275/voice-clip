<script setup lang="ts">
import UserPill from './UserPill.vue'
import { useHistoryStore } from '@/stores/history'
import { playModal } from '../../sounds'

// Topbar: history button + user pill. Same markup/classes as the old
// home.html .topbar. History button opens the history bottom-sheet (#103).
// User pill handler wired in #104 (profile modal).

const history = useHistoryStore()

function openHistory(): void {
  playModal()
  history.open()
}
</script>

<template>
  <div class="topbar">
    <button class="topbar-btn" id="history-btn" type="button" aria-label="History"
            @click="openHistory">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5" />
        <path d="M12 7v5l3 2" />
      </svg>
    </button>
    <UserPill />
  </div>
</template>
