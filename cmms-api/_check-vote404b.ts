// _check-vote404b.ts — recheck: is the vote route actually inside the
// deployed bundle that mcp-server.ts loads? mcp-server.ts is the
// entry, dashboard/server.ts is what it imports.
import { Client } from 'ssh2'

const CMD = [
  "echo '=== dashboard/server.ts: feedback/vote route present? ==='",
  "grep -n 'feedback/vote' /opt/cmms-api/dashboard/server.ts | head -5",
  "echo '=== mcp-server.ts: does it import dashboard/server? ==='",
  "grep -n 'dashboard/server' /opt/cmms-api/mcp-server.ts | head -5",
  "echo '=== /opt/cmms-api/dashboard/ exists? ==='",
  "ls -la /opt/cmms-api/dashboard/ | head -10",
  "echo '=== is the dashboard handler bundled into a .js? ==='",
  "find /opt/cmms-api -name 'server.js' -size +50k 2>/dev/null | head -5",
  "echo '=== bun version running cmms-mcp ==='",
  "systemctl show cmms-mcp -p ExecStart --no-pager",
  "echo '=== journal last 10 lines for cmms-mcp ==='",
  "journalctl -u cmms-mcp -n 10 --no-pager 2>&1 | tail -20",
  "echo '=== direct curl with NO auth (port 8788) - shows path == 404 handler? ==='",
  "curl -i -s http://127.0.0.1:8788/dashboard/api/feedback/vote -X POST -H 'Content-Type: application/json' -d '{}' --max-time 5 2>&1 | head -20",
  "echo '=== same with the no-trailing-slash test ==='",
  "curl -i -s http://127.0.0.1:8788/dashboard/api/feedback/vote 2>&1 | head -20",
  "echo '=== same on 8787 (direct cmms-api, no auth header) ==='",
  "curl -i -s http://127.0.0.1:8787/v1/feedback/vote -X POST -H 'Content-Type: application/json' -d '{}' --max-time 5 2>&1 | head -20",
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
