<script setup lang="ts">
// src/admin-shell.vue
//
// Root component of the standalone admin SPA (mounted on #admin-app
// from admin.html). It is intentionally MINIMAL:
//
//   - No AppShell, no topbar, no operator sidebar, no bottom tabs.
//   - Just a <router-view /> for the active admin page.
//   - A small global "Vissza a dashboardhoz" floating link in the
//     top-left corner that the user can use to leave the admin
//     surface and go back to the operator SPA. The link does a hard
//     window.location navigation to /dashboard/v2/ask so the
//     operator SPA fully reloads.
//
// The "disconnected from the main app" feel is enforced by:
//   1. The admin SPA loads from a SEPARATE HTML document
//      (admin.html) at /dashboard/admin/ — not from /dashboard/v2/.
//   2. It has its own router, its own Pinia, its own VueQuery client.
//   3. It has no shared layout chrome with the operator SPA.
//   4. The URL namespace is /dashboard/admin/* not /dashboard/v2/admin/*.
//   5. The admin cookie (cmms_dash_admin_sid) is separate from the
//      operator cookie (cmms_dash_sid).
//   6. Server-side admin endpoints live under /dashboard/api/admin/*
//      which are NOT gated by the operator cookie check.
//   7. The amber accent color never appears in the operator app.

import { useRouter } from 'vue-router'

const router = useRouter()

function goBackToDashboard() {
  // Hard navigation — the operator SPA is a different document, so a
  // router push wouldn't make sense. window.location.assign triggers
  // a full page load of /dashboard/v2/ask.
  window.location.assign('/dashboard/v2/ask')
}

// Hide the back link on the login page — the user just arrived there
// and there's nothing to "go back" to within the admin app.
function isLogin(): boolean {
  return router.currentRoute.value.path === '/login'
}
</script>

<template>
  <div
    class="min-h-[100dvh] w-full bg-canvas text-text-primary font-sans antialiased"
    data-testid="admin-shell"
  >
    <!-- Floating "Vissza a dashboardhoz" — top-left. Always visible
         except on the login page. -->
    <button
      v-if="!isLogin()"
      type="button"
      class="fixed top-3 left-3 z-50
             inline-flex items-center gap-1.5
             h-8 px-3 rounded-full
             bg-canvas-2/85 backdrop-blur-md
             border border-amber-500/30
             text-[12px] font-medium text-amber-700 dark:text-amber-300
             hover:bg-amber-500/10 hover:border-amber-500/50
             transition-colors duration-150
             focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50
             shadow-md shadow-black/30"
      data-testid="admin-back-to-dashboard"
      aria-label="Vissza a dashboardhoz"
      @click="goBackToDashboard"
    >
      <svg
        width="13" height="13" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true"
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
      Vissza a dashboardhoz
    </button>

    <router-view />
  </div>
</template>
