// _check-vote404.ts — why does /dashboard/api/feedback/vote 404?
import { Client } from 'ssh2'

const CMD = [
  "echo '=== feedback/vote occurrences in deployed mcp-server.ts ==='",
  "grep -c 'feedback/vote' /opt/cmms-api/mcp-server.ts || echo MISSING",
  "echo '=== my-corrections occurrences (newer feature marker) ==='",
  "grep -c 'my-corrections' /opt/cmms-api/mcp-server.ts || echo MISSING",
  "echo '=== POST 8788 /dashboard/api/feedback/vote (no auth) ==='",
  "curl -s -o /tmp/b88.txt -w '%{http_code}\\n' -X POST http://127.0.0.1:8788/dashboard/api/feedback/vote -H 'Content-Type: application/json' -d '{}'; cat /tmp/b88.txt",
  "echo",
  "echo '=== POST 8787 /v1/feedback/vote (no auth) ==='",
  "curl -s -o /tmp/b87.txt -w '%{http_code}\\n' -X POST http://127.0.0.1:8787/v1/feedback/vote -H 'Content-Type: application/json' -d '{}'; cat /tmp/b87.txt",
  "echo",
  "echo '=== services ==='",
  "systemctl is-active cmms-mcp cmms-api",
  "echo '=== file stamps ==='",
  "stat -c '%y %s %n' /opt/cmms-api/mcp-server.ts /opt/cmms-api/cmms-api 2>&1",
  "echo '=== askpage chunks ==='",
  "ls /opt/cmms-api/dashboard/v2/assets/ | grep -i askpage",
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
