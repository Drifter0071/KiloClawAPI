import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory('/dashboard/'),
  routes: [
    { path: '/', redirect: '/ask' },
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
