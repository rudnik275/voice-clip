<script setup lang="ts">
// The big record button — visual shell only in this foundation slice. The
// record → upload → clipboard flow + voice-reactive halo land in RecordView
// (#102). The #rec id and .rec-inner / mic-icon / busy-dots markup are
// preserved 1:1 from home.html so style.css renders it identically.
</script>

<template>
  <button id="rec" type="button" aria-label="Tap to record">
    <span class="rec-inner">
      <svg class="mic-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <path d="M12 18v4" />
      </svg>
      <span id="rec-label">Tap to record</span>
    </span>
    <span id="rec-time"></span>
    <span class="busy-dots" aria-hidden="true"><i></i><i></i><i></i></span>
  </button>
</template>
