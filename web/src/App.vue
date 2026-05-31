<script setup lang="ts">
import { onMounted } from 'vue'
import { useSessionStore } from './stores/session'
import Toolbar from './components/Toolbar.vue'
import RecordView from './views/RecordView.vue'

// On load, resolve the session via GET /me. A 401 redirects the browser to
// /login inside the store; otherwise the authorized shell renders.
const session = useSessionStore()

onMounted(() => {
  void session.load()
})
</script>

<template>
  <!-- Authorized shell: topbar (history + user pill) + record button.
       Rendered only once /me confirms a session; before that (and on a
       failed/redirecting load) nothing is shown — the page is plain cream
       background from style.css, and a 401 has already bounced to /login. -->
  <template v-if="session.isAuthenticated">
    <Toolbar />
    <RecordView />
  </template>
</template>
