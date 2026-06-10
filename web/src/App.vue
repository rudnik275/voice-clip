<script setup lang="ts">
import { onMounted } from 'vue'
import { useSessionStore } from './stores/session'
import Toolbar from './components/Toolbar.vue'
import RecordView from './views/RecordView.vue'
// #103: history modal — rendered inside the authenticated shell.
import HistoryModal from './components/HistoryModal.vue'

// On load, resolve the session via GET /me. A clean 401 funnels into the
// login/sign-out path inside the store; a transient transport/5xx failure
// lands in the 'error' state (auto-retries with backoff) and renders the
// visible retry surface below instead of a permanent blank page (#136).
const session = useSessionStore()

onMounted(() => {
  void session.load()
})
</script>

<template>
  <!-- Authorized shell: topbar (history + user pill) + record button.
       Rendered only once /me confirms a session. -->
  <template v-if="session.isAuthenticated">
    <Toolbar />
    <RecordView />
    <!-- #103: history bottom-sheet modal. Visibility driven by useHistoryStore().isOpen. -->
    <HistoryModal />
  </template>

  <!-- Boot is in-flight: a lightweight loading hint so the page isn't a bare
       cream void while /me resolves (distinct from the blank pre-rewrite bug). -->
  <div v-else-if="session.status === 'loading'" class="boot-screen">
    <p class="boot-loading">Загрузка…</p>
  </div>

  <!-- Transient /me failure (network blip, Cloudflare 5xx during a deploy):
       a VISIBLE, retryable card instead of a permanent blank page (#136).
       A clean 401 never reaches here — it redirects/signs out in the store. -->
  <div v-else-if="session.status === 'error'" class="boot-screen">
    <div class="boot-error">
      <p class="boot-error-title">Не удалось загрузить</p>
      <p class="boot-error-sub">Проверь соединение и попробуй снова.</p>
      <button type="button" class="boot-retry" @click="session.retry()">
        Повторить
      </button>
    </div>
  </div>
</template>

<style scoped>
.boot-screen {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.boot-loading {
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}

/* Neo-Brutalism card: thick border + hard offset shadow, no blur. */
.boot-error {
  background: var(--white);
  border: var(--border-strong);
  box-shadow: var(--shadow-md);
  border-radius: 0;
  padding: 28px 24px;
  max-width: 360px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.boot-error-title {
  font-weight: 700;
  font-size: 1.25rem;
}

.boot-error-sub {
  color: var(--muted);
  font-weight: 500;
}

/* Mechanical press: translate to meet the shadow offset, drop the shadow. */
.boot-retry {
  margin-top: 8px;
  align-self: center;
  font: inherit;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  padding: 12px 24px;
  background: var(--red);
  color: var(--fg);
  border: var(--border);
  box-shadow: var(--shadow-sm);
  transition:
    transform var(--press),
    box-shadow var(--press);
}

.boot-retry:hover {
  background: var(--yellow);
}

.boot-retry:active {
  transform: translate(4px, 4px);
  box-shadow: 0 0 0 var(--fg);
}
</style>
