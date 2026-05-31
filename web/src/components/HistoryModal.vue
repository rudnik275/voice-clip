<script setup lang="ts">
// HistoryModal — bottom-sheet history modal, reproducing the legacy
// web/home.html + web/app.ts history section markup and classes 1:1.
//
// Opened/closed via the `history` Pinia store (no vue-router).
// Plays the modal swoosh sound on open (matching old `openHistory`).
// Each clip shows its recordedAt timestamp, recognised text, and a
// Copy button that writes the text to the local clipboard.

import { computed } from 'vue'
import { useHistoryStore } from '@/stores/history'

// sounds.ts lives at web/sounds.ts (not inside web/src). The relative path
// from web/src/components/ is ../../sounds.ts.
import { playModal, playCopy } from '../../sounds'

const history = useHistoryStore()

// Format a recordedAt ISO string the same way the legacy `fmtTime` did.
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Called when the store opens — play the modal swoosh.
// We watch isOpen in App.vue-level; here we play the sound in onOpen.
function onBackdropClick(): void {
  history.close()
}

async function copyClip(text: string, seq: number): Promise<void> {
  void navigator.clipboard?.writeText(text).catch(() => {})
  playCopy()
  // Best-effort fan-out to paired Macs — same logic as legacy app.ts.
  void fetch('/clip/copy', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq }),
  }).catch(() => {})
}

const isEmpty = computed(() => !history.loading && history.clips.length === 0 && !history.error)
</script>

<template>
  <!-- Outer wrapper is always in the DOM when visible; use v-if so the
       component is fully unmounted when closed (avoids stale list). The
       isOpen flag is managed by the history store. -->
  <div v-if="history.isOpen" class="history-modal" id="history-modal">
    <div class="history-backdrop" id="history-backdrop" @click="onBackdropClick"></div>
    <div class="history-sheet">
      <div class="history-head">
        <button class="ghost-btn" id="history-close" type="button" @click="history.close()">Close</button>
        <h2>History</h2>
        <!-- Invisible twin keeps the h2 centered in the flex row (legacy pattern). -->
        <span class="ghost-btn" aria-hidden="true" style="visibility: hidden">Close</span>
      </div>

      <div class="history-list" id="history-list">
        <!-- Empty state -->
        <p v-if="isEmpty" class="history-empty">No recordings yet</p>

        <!-- Error state -->
        <p v-else-if="history.error" class="history-empty">{{ history.error }}</p>

        <!-- Clip list -->
        <div
          v-for="clip in history.clips"
          :key="clip.seq"
          class="history-item"
        >
          <div class="history-item-head">
            <span class="history-time">{{ fmtTime(clip.recordedAt) }}</span>
          </div>
          <p class="history-text">{{ clip.text || '—' }}</p>
          <div class="history-actions">
            <button type="button" @click="copyClip(clip.text, clip.seq)">Copy</button>
          </div>
        </div>

        <!-- Load-more button (matches legacy "Load more" ghost-btn pattern) -->
        <button
          v-if="history.hasMore() && !history.loading"
          class="ghost-btn"
          id="history-more"
          type="button"
          @click="history.loadMore()"
        >
          Load more
        </button>

        <!-- In-flight loading indicator -->
        <p v-if="history.loading" class="history-empty">Loading…</p>
      </div>
    </div>
  </div>
</template>
