import { createApp } from 'vue'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './routes'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/tokens.css'
import './styles/base.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
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
app.mount('#app')

// PWA (feature #4): register the service worker in production only.
// In dev, vite's live reload would fight a SW that caches stale
// modules. The SW is scoped to /dashboard/v2/ and never touches
// /dashboard/api/* (cookie-gated). Failure to register is non-fatal —
// the app works fine without it.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // eslint-disable-next-line no-console
      console.warn('[pwa] service worker registration failed — continuing without it')
    })
  })
}

