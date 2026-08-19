import { createRouter, createWebHistory } from 'vue-router'

// Main operator SPA (Ask, Stream, Térkép, Diff, Tokenek).
// Admin lives in a SEPARATE SPA — see admin.html + src/admin-main.ts.
// Loading /admin/* here would have made it look like a tab in the
// main app, which the user explicitly rejected ("admin should be a
// whole separate page, not part of the main app, it has its own login
// page and pages, it is only related to the main app through the
// backend"). The "Admin panel" item in OperatorMenu does a hard
// window.location.assign('/dashboard/admin/login') that loads the
// standalone admin entry.

export const router = createRouter({
  history: createWebHistory('/dashboard/v2/'),
  routes: [
    { path: '/', redirect: '/ask' },
    {
      path: '/login',
      name: 'login',
      component: () => import('./LoginPage.vue' /* webpackChunkName: "login" */),
    },
    {
      path: '/ask',
      name: 'ask',
      component: () => import('./AskPage.vue' /* webpackChunkName: "ask" */),
    },
    {
      path: '/stream',
      name: 'stream',
      component: () => import('./StreamPage.vue' /* webpackChunkName: "stream" */),
    },
    {
      path: '/map',
      name: 'map',
      component: () => import('./MapPage.vue' /* webpackChunkName: "map" */),
    },
    {
      path: '/diff',
      name: 'diff',
      component: () => import('./DiffPage.vue' /* webpackChunkName: "diff" */),
    },
    {
      path: '/tokens',
      name: 'tokens',
      component: () => import('./TokensPage.vue' /* webpackChunkName: "tokens" */),
    },
    {
      path: '/admin/login',
      name: 'admin-login',
      // Separate from the user login route. Rendered with a stripped-
      // down AppShell (no rail, no topbar — see AdminShell.vue).
      component: () => import('./AdminLoginPage.vue' /* webpackChunkName: "admin-login" */),
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('./AdminPanelPage.vue' /* webpackChunkName: "admin-panel" */),
    },
    {
      path: '/admin/disliked',
      name: 'admin-disliked',
      // Master/detail view of every disliked Ask answer. Routed
      // by the admin panel's "Disliked válaszok listája" button.
      // The detail drawer is teleported (same HIG pattern as
      // TicketInspector on mobile) so the list keeps its scroll
      // position when a row is selected.
      component: () => import('./DislikedAnswersPage.vue' /* webpackChunkName: "admin-disliked" */),
    },
  ],
})
