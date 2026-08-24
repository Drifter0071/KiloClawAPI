// _check-vote404g.ts — confirm the real path. Open the dist html,
// look at the absolute base, and probe with the right Referer to
// reproduce the 404.
import { Client } from 'ssh2'

const CMD = [
  "echo '=== index.html <base> and askpage route ==='",
  "grep -E '<base|router|routes' /opt/cmms-api/dashboard/v2/index.html 2>&1 | head -5",
  "echo '=== createWebHistory base in dist? ==='",
  "grep -oP 'createWebHistory\\(\"[^\\\"]*\"' /opt/cmms-api/dashboard/v2/assets/*.js 2>/dev/null | head -3",
  "echo '=== check the live page serves the right base ==='",
  "curl -s http://127.0.0.1:8788/dashboard/v2/ | head -8",
  "echo '=== check what /dashboard/api/* gets with cookie. Set a fake one and try. ==='",
  "curl -i -s -X POST 'http://127.0.0.1:8788/dashboard/api/feedback/vote' -H 'Content-Type: application/json' -H 'Cookie: cmms_session=garbage' -d '{}' --max-time 5 2>&1 | head -10",
  "echo '=== same with the original header (just x-cmms-uid, no cookie) ==='",
  "curl -i -s -X POST 'http://127.0.0.1:8788/dashboard/api/feedback/vote' -H 'Content-Type: application/json' -H 'X-Cmms-Uid: 11111111-1111-1111-1111-111111111111' -d '{\"answer_id\":\"01m0d62he8w3yn68nv9ft8t46t\",\"vote\":1}' --max-time 5 2>&1 | head -10",
  "echo '=== the answer 01m0d62... was logged earlier; if vote works, we expect 200 ==='",
  "echo '=== on 8787 direct: same body w/ read token ==='",
  "TOK=$(grep CMMS_API_TOKEN_READ /etc/cmms-api.env | cut -d= -f2)",
  "curl -i -s -X POST 'http://127.0.0.1:8787/v1/feedback/vote' -H 'Content-Type: application/json' -H \"Authorization: Bearer $TOK\" -H 'X-Cmms-Uid: 11111111-1111-1111-1111-111111111111' -d '{\"answer_id\":\"01m0d62he8w3yn68nv9ft8t46t\",\"vote\":1}' --max-time 8 2>&1 | head -10",
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
