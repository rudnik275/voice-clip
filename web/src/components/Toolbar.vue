<script setup lang="ts">
import { ref } from 'vue'
import UserPill from './UserPill.vue'
import ProfileModal from './ProfileModal.vue'
import { useHistoryStore } from '@/stores/history'
import { playModal } from '../../sounds'

// Topbar: history button + user pill. History button opens the history
// bottom-sheet (#103); the user pill opens the profile modal (#104). Profile
// modal state lives here so UserPill and ProfileModal are siblings.

const history = useHistoryStore()

function openHistory(): void {
  playModal()
  history.open()
}

// ---- profile modal state (#104) ----
const profileOpen = ref(false)
function openProfile() {
  // Play the swoosh HERE, synchronously inside the user-pill click gesture —
  // not in a ProfileModal watch(props.open), which fires in a microtask after
  // the gesture and is silent on iOS (WebAudio needs the live gesture). Matches
  // the old app.ts openProfile().
  playModal()
  profileOpen.value = true
}
function closeProfile() { profileOpen.value = false }
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
    <UserPill @open-profile="openProfile" />
  </div>

  <!-- Profile modal — rendered outside the topbar flex context but still
       inside Toolbar so the open/close state stays local to this component.
       (#104) -->
  <ProfileModal :open="profileOpen" @close="closeProfile" />
</template>
