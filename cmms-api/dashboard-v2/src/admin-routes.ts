// src/admin-routes.ts
//
// Router for the standalone admin SPA. Lives at /dashboard/admin/
// (NOT /dashboard/v2/) so the URL namespace is fully separate from
// the operator app. The two apps share Vite build + design tokens,
// but at runtime they're two separate documents loaded by two
// separate HTML files (index.html + admin.html).
//
// Admin routes:
//   /dashboard/admin/login       — AdminLoginPage.vue
//   /dashboard/admin/            — AdminPanelPage.vue
//   /dashboard/admin/disliked    — DislikedAnswersPage.vue
//
// Everything is gated by the admin cookie (cmms_dash_admin_sid) on
// the server side. The login page does an onMounted probe at
// /dashboard/api/admin/state — if the cookie is still valid, it
// skips the form and navigates to /admin. The panel page also
// does this probe (in case the cookie expired mid-session).

import { createRouter, createWebHistory } from 'vue-router'

export const adminRouter = createRouter({
  history: createWebHistory('/dashboard/admin/'),
  routes: [
    { path: '/', redirect: '/login' },
    {
      path: '/login',
      name: 'admin-login',
      component: () => import('./routes/AdminLoginPage.vue' /* webpackChunkName: "admin-login" */),
    },
    {
      path: '/panel',
      name: 'admin-panel',
      // The root path / redirects to /login, which redirects to /panel
      // on a valid cookie. /panel is the actual landing page.
      component: () => import('./routes/AdminPanelPage.vue' /* webpackChunkName: "admin-panel" */),
    },
    {
      path: '/disliked',
      name: 'admin-disliked',
      component: () => import('./routes/DislikedAnswersPage.vue' /* webpackChunkName: "admin-disliked" */),
    },
  ],
})
