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
  ],
})
