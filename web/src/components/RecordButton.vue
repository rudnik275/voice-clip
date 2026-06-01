<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { useRecorderStore } from '../stores/recorder'

// The big record button — now wired to the recorder store (#102). Markup, ids
// and classes are preserved 1:1 from home.html so style.css renders it (and the
// voice-reactive halo via --voice-level) identically. The capture logic itself
// lives in the framework-agnostic core (RecorderMachine + BrowserAudioAdapter);
// this component is purely the view + the tap/pause gestures.
const rec = useRecorderStore()

// #rec carries .recording while active (recording OR paused — matches the old
// app.ts which kept 'recording' on through a pause), .paused while paused, and
// .busy while finalizing/transcribing.
const recClasses = computed(() => ({
  recording: rec.isActive,
  paused: rec.isPaused,
  busy: rec.isBusy,
}))

const label = computed(() => {
  if (rec.isBusy) return ''
  if (rec.isActive) return 'Recording'
  return 'Tap to record'
})

const timeText = computed(() => (rec.isActive ? fmtElapsed(rec.elapsedMs) : ''))

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const pauseLabel = computed(() => (rec.isPaused ? 'Resume' : 'Pause'))

// Drive the voice halo exactly as the old app.ts did: write --voice-level on the
// #rec element. rec.level is already smoothed (alpha 0.16) inside the adapter.
const recEl = ref<HTMLButtonElement | null>(null)
watchEffect(() => {
  const el = recEl.value
  if (el) el.style.setProperty('--voice-level', rec.level.toFixed(3))
})

// Toast statuses (transcript preview / hints / errors) reuse the #status element
// and its .show/.error/.success classes from style.css. When the status carries
// a `preview` (e.g. the transcript), add .has-preview so style.css switches to
// the title + line-clamped-body layout — without it a long transcript wraps
// unbounded and covers the screen (the pre-Vue app.ts split title/preview too).
const statusClasses = computed(() => {
  const st = rec.status
  if (!st) return ''
  return [
    'show',
    st.kind === 'error' ? 'error' : '',
    st.kind === 'success' ? 'success' : '',
    st.preview ? 'has-preview' : '',
  ]
    .filter(Boolean)
    .join(' ')
})
</script>

<template>
  <button
    id="rec"
    ref="recEl"
    type="button"
    aria-label="Tap to record"
    :class="recClasses"
    @click="rec.tap()"
    @pointerdown="rec.prime()"
  >
    <span class="rec-inner">
      <svg class="mic-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <path d="M12 18v4" />
      </svg>
      <span id="rec-label">{{ label }}</span>
    </span>
    <span id="rec-time">{{ timeText }}</span>
    <span class="busy-dots" aria-hidden="true"><i></i><i></i><i></i></span>
  </button>

  <button
    id="rec-pause"
    type="button"
    aria-label="Pause recording"
    :hidden="!rec.isActive"
    :class="{ 'is-paused': rec.isPaused }"
    @click="rec.togglePause()"
  >
    <svg class="pause-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1.5" />
      <rect x="14" y="5" width="4" height="14" rx="1.5" />
    </svg>
    <svg class="resume-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4l13 8-13 8z" />
    </svg>
    <span id="rec-pause-label">{{ pauseLabel }}</span>
  </button>

  <p id="status" role="status" aria-live="polite" :class="statusClasses">
    <template v-if="rec.status?.preview">
      <span class="toast-title">{{ rec.status.text }}</span>
      <span class="toast-preview">{{ rec.status.preview }}</span>
    </template>
    <template v-else>{{ rec.status?.text ?? '' }}</template>
  </p>
</template>
