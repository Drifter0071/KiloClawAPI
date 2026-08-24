// _check-vote404d.ts — the smoke gun: is the dist making the request
// to a doubled path? With <base href="/dashboard/v2/"> and a
// relative URL "/dashboard/api/feedback/vote", the browser
// SHOULD treat it as absolute (it starts with /), but let me check
// what the dist actually calls.
import { Client } from 'ssh2'

const CMD = [
  "echo '=== exact fetch URL in the dist ==='",
  "grep -o '.\{0,80\\}feedback/vote.\{0,80\\}' /opt/cmms-api/dashboard/v2/assets/main-CnYrT-P7.js | head -5",
  "echo '=== check whether request is made with leading slash ==='",
  "grep -o '.\{0,5\\}/dashboard/api/feedback/vote.\{0,5\\}' /opt/cmms-api/dashboard/v2/assets/main-CnYrT-P7.js | head -5",
  "echo '=== check what other dist files have the path (v2 ask) ==='",
  "grep -l 'feedback/vote' /opt/cmms-api/dashboard/v2/assets/*.js 2>/dev/null",
  "echo '=== check askpage chunk ==='",
  "grep -o '.\{0,80\\}feedback/vote.\{0,80\\}' /opt/cmms-api/dashboard/v2/assets/AskPage-*.js 2>/dev/null | head -5",
  "echo '=== the SPA could be calling /v2/dashboard/api/feedback/vote (after base href). Test that: ==='",
  "curl -i -s -X POST http://127.0.0.1:8788/dashboard/v2/dashboard/api/feedback/vote -H 'Content-Type: application/json' -d '{}' --max-time 5 2>&1 | head -10",
  "echo '=== also test: /v2/dashboard/api/feedback/vote (without leading /dashboard) ==='",
  "curl -i -s -X POST http://127.0.0.1:8788/v2/dashboard/api/feedback/vote -H 'Content-Type: application/json' -d '{}' --max-time 5 2>&1 | head -10",
  "echo '=== with the no-slash prefix; absolute paths start with / ==='",
  "curl -i -s -X POST 'http://127.0.0.1:8788/v2/api/feedback/vote' -H 'Content-Type: application/json' -d '{}' --max-time 5 2>&1 | head -10",
].join('\n')

const c = new Client()
c.on('ready', () => {
  c.exec(CMD, (e, stream) => {
    if (e) { console.error('exec error', e.message); process.exit(1) }
    stream.on('close', () => { c.end() })
    stream.on('data', (d: Buffer) => process.stdout.write(d.toString()))
    stream.stderr.on('data', (d: Buffer) => process.stderr.write(d.toString()))
  })
})
c.on('error', (e) => console.error('conn error', e.message))
c.connect({ host: '10.0.3.81', port: 22, username: 'root', password: 'tarantula999' })
