// _check-vote404c.ts — did a recent dashboard dist deploy add a new
// basename and the old build's call paths no longer hit the proxy?
import { Client } from 'ssh2'

const CMD = [
  "echo '=== v2 dist stamp + index.html first 30 lines ==='",
  "stat -c '%y %s %n' /opt/cmms-api/dashboard/v2/index.html 2>&1",
  "head -c 1200 /opt/cmms-api/dashboard/v2/index.html 2>&1",
  "echo",
  "echo '=== check if route exists in dist (look for the literal string) ==='",
  "grep -l 'feedback/vote' /opt/cmms-api/dashboard/v2/assets/*.js 2>/dev/null | head -5 || echo NONE",
  "echo '=== what path does AskPage call? grep with context ==='",
  "grep -o '.\{0,40\\}feedback/vote.\{0,40\\}' /opt/cmms-api/dashboard/v2/assets/AskPage-*.js 2>/dev/null | head -5",
  "echo '=== check for any newer dist files (post the latest mcp-server deploy) ==='",
  "find /opt/cmms-api/dashboard/v2 -newer /opt/cmms-api/mcp-server.ts 2>/dev/null | head -10",
  "echo '=== is mcp-server still the OLD one from 09:01, or newer? ==='",
  "stat -c '%y %s %n' /opt/cmms-api/mcp-server.ts /opt/cmms-api/dashboard/server.ts",
  "echo '=== local vs deployed mcp-server.ts md5 ==='",
  "md5sum /opt/cmms-api/mcp-server.ts",
  "echo '=== last 30 journal for cmms-mcp (look for 404) ==='",
  "journalctl -u cmms-mcp -n 200 --no-pager 2>&1 | grep -E '404|feedback/vote|error' | tail -20",
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
