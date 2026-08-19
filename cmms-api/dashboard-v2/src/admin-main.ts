// src/admin-main.ts
//
// Standalone admin SPA entry point. Boots a SEPARATE Vue app on the
// #admin-app root mounted from admin.html. This app:
//   - has its own Vue instance, Pinia, router
//   - has NO AppShell, no topbar, no operator sidebar, no bottom tabs
//   - mounts only the admin routes (login, panel, disliked)
//   - does NOT share runtime state with the main operator app
//
// The "Admin panel" button in OperatorMenu does a hard
// window.location.assign('/dashboard/admin/login') that fully unloads
// the operator SPA and loads this one in its place. The reverse —
// navigating back to the operator SPA — is done by AdminPanelPage's
// "Vissza a dashboardhoz" link which navigates to /dashboard/v2/ask
// (full reload again).
//
// Rationale: the user explicitly asked for admin to be a "whole
// separate page, not part of the main app". Putting the admin UI in
// the same Vue app would have meant:
//   - the same topbar, sidebar, and bottom tabs
//   - the same Pinia store
//   - the same router history
//   - the same operator cookie check
// which is exactly the "feels completely disconnected" failure mode
// they were reporting. The fix is structural: two apps, one backend.

import { createApp } from 'vue'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { createPinia } from 'pinia'
import AdminShell from './admin-shell.vue'
import { adminRouter } from './admin-routes'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/tokens.css'
import './styles/base.css'

const app = createApp(AdminShell)
app.use(createPinia())
app.use(adminRouter)
app.use(VueQueryPlugin, {
  queryClient: new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  }),
})
app.mount('#admin-app')
