<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useSessionStore, type Me } from '../stores/session'
import { isMuted, setMuted, playModal } from '../../sounds'

// ---- props / emits ----
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// ---- session ----
const session = useSessionStore()

// ---- sounds toggle (mirrors old app.ts refreshSoundsToggle) ----
// Reactive ref so the template re-reads whenever it changes.
const muted = ref(isMuted())

function toggleSounds() {
  setMuted(!muted.value)
  muted.value = isMuted()
}

// ---- quota chip (mirrors old app.ts paintQuotaChip) ----
const quotaVisible = computed<boolean>(() => {
  const me = session.me
  if (!me) return false
  const plan = me.plan ?? 'free'
  const limit = resolvedLimit(me)
  if (plan === 'unlimited') return true
  if (plan === 'pro' && (limit === null || limit === 0)) return true
  if (limit === null || limit === 0) return false
  return true
})

function resolvedLimit(me: Me): number | null {
  if (me.usage?.monthly_limit !== undefined) return me.usage.monthly_limit ?? null
  const plan = me.plan ?? 'free'
  if (plan === 'free') return me.usage?.free_monthly_limit ?? null
  return null
}

const quotaPlanLabel = computed<string>(() => {
  const me = session.me
  if (!me) return ''
  const plan = me.plan ?? 'free'
  if (plan === 'unlimited') return 'Unlimited'
  if (plan === 'pro') return 'Pro plan'
  return 'Free plan'
})

const quotaMeta = computed<string>(() => {
  const me = session.me
  if (!me) return '— / —'
  const plan = me.plan ?? 'free'
  const used = me.usage?.clips_this_month ?? 0
  const limit = resolvedLimit(me)
  if (plan === 'unlimited') return 'No monthly cap'
  if (plan === 'pro' && (limit === null || limit === 0)) return 'Unlimited transcriptions'
  if (limit === null || limit === 0) return '— / —'
  return `${used} / ${limit} this month`
})

const quotaBarWidth = computed<string>(() => {
  const me = session.me
  if (!me) return '0%'
  const used = me.usage?.clips_this_month ?? 0
  const limit = resolvedLimit(me)
  if (!limit) return '0%'
  return `${Math.round(Math.min(1, used / limit) * 100)}%`
})

const quotaCtaText = computed<string>(() => {
  const me = session.me
  if (!me) return ''
  const plan = me.plan ?? 'free'
  const used = me.usage?.clips_this_month ?? 0
  const limit = resolvedLimit(me)
  if (plan === 'pro' || plan === 'unlimited') return ''
  if (limit !== null && limit > 0 && used >= limit) return 'Upgrade now'
  return 'Upgrade'
})

const isPro = computed<boolean>(() => {
  const plan = session.me?.plan ?? 'free'
  return plan === 'pro' || plan === 'unlimited'
})

const isExhausted = computed<boolean>(() => {
  const me = session.me
  if (!me) return false
  const plan = me.plan ?? 'free'
  if (plan === 'pro' || plan === 'unlimited') return false
  const used = me.usage?.clips_this_month ?? 0
  const limit = resolvedLimit(me)
  return limit !== null && limit > 0 && used >= limit
})

// ---- sign out ----
async function signOut() {
  if (!confirm('Sign out?')) return
  try {
    await fetch('/logout', { method: 'POST', credentials: 'same-origin' })
  } finally {
    window.location.href = '/login'
  }
}

// ---- close on backdrop click / Escape ----
function onBackdrop() {
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (props.open && e.key === 'Escape') emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

// Play swoosh when modal opens (mirrors old app.ts openProfile).
watch(
  () => props.open,
  (val) => {
    if (val) {
      muted.value = isMuted() // refresh from localStorage on each open
      playModal()
    }
  },
)
</script>

<template>
  <!-- Profile modal: bottom-sheet, same markup/classes as the old home.html
       .profile-modal so style.css styles it identically. -->
  <div class="profile-modal" :hidden="!open">
    <div class="profile-backdrop" @click="onBackdrop"></div>
    <div class="profile-sheet">
      <div class="profile-head">
        <button class="ghost-btn" type="button" @click="$emit('close')">Close</button>
        <h2>Profile</h2>
        <button class="ghost-btn danger" type="button" @click="signOut">Sign out</button>
      </div>
      <div class="profile-body">

        <!-- Quota chip — same markup as old home.html -->
        <a
          class="quota-chip"
          :class="{ 'is-pro': isPro, 'is-exhausted': isExhausted }"
          href="/pro"
          :hidden="!quotaVisible"
        >
          <span class="quota-chip-row">
            <span class="quota-chip-label">{{ quotaPlanLabel }}</span>
            <span class="quota-chip-cta">{{ quotaCtaText }}</span>
          </span>
          <span class="quota-bar">
            <span class="quota-bar-fill" :style="{ width: quotaBarWidth }"></span>
          </span>
          <span class="quota-chip-meta">{{ quotaMeta }}</span>
        </a>

        <!-- Sounds toggle -->
        <h3 class="profile-section-title">Sounds</h3>
        <button class="device-item" type="button" @click="toggleSounds">
          <div class="device-meta">
            <div class="device-label">UI sounds</div>
            <div class="device-seen">{{ muted ? 'Muted' : 'On' }}</div>
          </div>
          <div class="device-revoke">{{ muted ? 'Unmute' : 'Mute' }}</div>
        </button>

        <!-- Paired devices section — placeholder for #105 -->
        <h3 class="profile-section-title">Paired devices</h3>
        <div class="profile-devices">
          <!-- devices list is added in #105 -->
          <p class="profile-empty">No paired Macs yet</p>
        </div>

        <div class="profile-version">voice-clip</div>
      </div>
    </div>
  </div>
</template>
