<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useSessionStore, type Me } from '../stores/session'
import { isMuted, setMuted, unlockAudio, playCopy } from '../../sounds'
import { IS_TAURI, tauriSignOut } from '../../tauri-runtime'
import { fetchDevices, revokeDevice, generateInvite, type DeviceRow } from '../api/devices'
import { armClipboardWrite } from '../lib/clipboard'

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
  // When unmuting, call unlockAudio() right here in the click handler so
  // iOS WebAudio is primed while we're still inside the user gesture — the
  // next play call (e.g. the success bell on upload) may fire outside a
  // gesture and would be silently dropped without this.
  if (!muted.value) unlockAudio()
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
  if (IS_TAURI) {
    // Tauri owns sign-out: the Rust `sign_out` command tears down the SSE
    // worker, revokes the device, wipes the Keychain, and emits `signed_out`.
    // The tauri-runtime `signed_out` listener clears the cached token and
    // flips the webview back to the pairing splash — no manual navigation here.
    emit('close')
    await tauriSignOut()
    return
  }
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

// Refresh state when the modal opens. The open swoosh is played by Toolbar's
// openProfile() inside the click gesture (iOS WebAudio needs the live gesture);
// this watch runs in a post-gesture microtask, so a playModal() here would be
// silent on iOS.
watch(
  () => props.open,
  (val) => {
    if (val) {
      muted.value = isMuted() // refresh from localStorage on each open
      void loadDevices()
      // Refresh the session so the quota chip shows current usage — not just
      // the values from app load. refresh() leaves status='authenticated'
      // (unlike load()), so the app shell stays mounted.
      void session.refresh()
    }
  },
)

// ---- paired devices ----

// Is this a Mac browser (not Tauri)? Drives download CTA visibility.
// Mirrors isMacBrowser() in old app.ts.
function isMacBrowser(): boolean {
  if (IS_TAURI) return false
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return false
  return /Mac/i.test(navigator.platform || ua)
}

const SHOW_MAC_CTA = isMacBrowser()

const devices = ref<DeviceRow[]>([])
const devicesLoaded = ref(false)
const devicesError = ref(false)

async function loadDevices(): Promise<void> {
  devicesLoaded.value = false
  devicesError.value = false
  try {
    devices.value = await fetchDevices()
    devicesLoaded.value = true
  } catch {
    devicesError.value = true
    devicesLoaded.value = true
  }
}

// Download CTA visibility mirrors updateDownloadCta() in old app.ts:
//   - Not Mac browser (Tauri / mobile / etc.) → both hidden
//   - Mac browser, load failed → both hidden (don't guess)
//   - Mac browser, 0 paired → card shown
//   - Mac browser, ≥1 paired → compact shown
const showDownloadCtaCard = computed<boolean>(() => {
  if (!SHOW_MAC_CTA || !devicesLoaded.value || devicesError.value) return false
  return devices.value.length === 0
})

const showDownloadCtaCompact = computed<boolean>(() => {
  if (!SHOW_MAC_CTA || !devicesLoaded.value || devicesError.value) return false
  return devices.value.length > 0
})

const revoking = ref<Set<string>>(new Set())

async function handleRevoke(d: DeviceRow): Promise<void> {
  if (!confirm(`Revoke "${d.label ?? 'Unnamed Mac'}"? It will stop receiving clips.`)) return
  if (revoking.value.has(d.id)) return
  revoking.value = new Set([...revoking.value, d.id])
  try {
    await revokeDevice(d.id)
    devices.value = devices.value.filter((x) => x.id !== d.id)
  } catch {
    // revoke failed — leave device in list
  } finally {
    const next = new Set(revoking.value)
    next.delete(d.id)
    revoking.value = next
  }
}

// ---- relative time (mirrors fmtRelative in old app.ts) ----
function fmtRelative(ms: number): string {
  const diff = Date.now() - ms
  if (!Number.isFinite(diff) || diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 45) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ---- owner invite generation ----

const isOwner = computed<boolean>(() => session.me?.is_owner ?? false)

const INVITE_HINT_DEFAULT = 'One-time, copied to clipboard'
const inviteHint = ref(INVITE_HINT_DEFAULT)
const inviteGenerating = ref(false)
const _inviteResetTimer = ref<ReturnType<typeof setTimeout> | null>(null)

async function handleGenerateInvite(): Promise<void> {
  if (inviteGenerating.value) return
  inviteGenerating.value = true

  // Arm the clipboard write synchronously inside the gesture so iOS Safari
  // accepts it. The pending ClipboardItem resolves when generateInvite() returns.
  const clipWrite = armClipboardWrite()

  inviteHint.value = 'Generating…'
  if (_inviteResetTimer.value !== null) {
    clearTimeout(_inviteResetTimer.value)
    _inviteResetTimer.value = null
  }
  try {
    const result = await generateInvite()
    const copied = await clipWrite.finish(result.url)
    if (copied) {
      playCopy()
      inviteHint.value = 'Copied to clipboard'
    } else {
      // Clipboard API blocked — show URL so the user can long-press copy.
      inviteHint.value = result.url
    }
  } catch {
    inviteHint.value = 'Failed — check your connection'
  } finally {
    inviteGenerating.value = false
    // Bug #3 fix: always reset to the constant baseline, not to whatever
    // inviteHint happened to hold at click time (which may be a transient value
    // from a previous generation within the 4s window).
    _inviteResetTimer.value = setTimeout(() => {
      inviteHint.value = INVITE_HINT_DEFAULT
      _inviteResetTimer.value = null
    }, 4000)
  }
}

// ---- Tauri pairing splash (consumed from tauri-runtime.ts) ----
// IS_TAURI is already handled by tauri-runtime.ts on boot (it wires the
// #tauri-pair overlay and the `paired` event listener). We expose it here
// only so the template can hide the download CTA inside Tauri.
const isTauri = IS_TAURI
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

        <!-- Paired devices section (#105) -->
        <h3 class="profile-section-title">Paired devices</h3>
        <div class="profile-devices">
          <!-- Loading / error state -->
          <p v-if="!devicesLoaded" class="profile-empty">Loading…</p>
          <p v-else-if="devicesError" class="profile-empty">Failed to load devices</p>

          <!-- Empty state -->
          <p v-else-if="devices.length === 0" class="profile-empty">No paired Macs yet</p>

          <!-- Device rows — same class/structure as old app.ts renderDevice() -->
          <template v-else>
            <div
              v-for="d in devices"
              :key="d.id"
              class="device-item"
              :data-id="d.id"
            >
              <div class="device-meta">
                <div class="device-label">{{ d.label ?? 'Unnamed Mac' }}</div>
                <div class="device-seen">Last seen {{ fmtRelative(d.last_seen_at) }}</div>
              </div>
              <button
                type="button"
                class="device-revoke"
                :disabled="revoking.has(d.id)"
                @click="handleRevoke(d)"
              >
                {{ revoking.has(d.id) ? '…' : 'Revoke' }}
              </button>
            </div>
          </template>
        </div>

        <!-- Download macOS app CTA (ADR 0005). Hidden by default.
             - Non-Mac or Tauri → both hidden
             - Mac browser, 0 paired → card (with blurb)
             - Mac browser, ≥1 paired → compact (one-liner)
        -->
        <a
          class="download-cta-card"
          href="/download/latest"
          :hidden="!showDownloadCtaCard"
        >
          <span class="download-cta-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </span>
          <span class="download-cta-title">Download Voice Clip for macOS</span>
          <span class="download-cta-sub">Receive clips from any device even when your browser is closed.</span>
        </a>
        <a
          class="download-cta-compact"
          href="/download/latest"
          :hidden="!showDownloadCtaCompact"
        >
          Install on another Mac →
        </a>

        <!-- Owner-only invite generator (#105).
             Hidden for non-owners; visible only when is_owner=true from /me. -->
        <template v-if="isOwner">
          <h3 class="profile-section-title">Invite a friend</h3>
          <button
            class="device-item"
            type="button"
            :disabled="inviteGenerating"
            @click="handleGenerateInvite"
          >
            <div class="device-meta">
              <div class="device-label">Generate invite link</div>
              <div class="device-seen">{{ inviteHint }}</div>
            </div>
            <div class="device-revoke">Generate</div>
          </button>
        </template>

        <div class="profile-version">voice-clip</div>
      </div>
    </div>
  </div>
</template>
