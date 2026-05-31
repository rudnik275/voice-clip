<script setup lang="ts">
import { useSessionStore } from '../stores/session'

// Topbar user pill — same markup/classes as the old home.html so style.css
// styles it identically. The profile menu (#104) wires the click later.
const session = useSessionStore()
</script>

<template>
  <button class="user-pill" id="user-pill" type="button" aria-label="Profile">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </svg>
    <span class="user-pill-name" id="user-pill-name">{{ session.me?.name ?? '' }}</span>
  </button>
</template>
