// _check-vote404h.ts — find any dist assets that have a different
// path string, and check the dist served at the actual public URL
import { Client } from 'ssh2'

const CMD = [
  "echo '=== ALL asset files in dist (with size + mtime) ==='",
  "find /opt/cmms-api/dashboard/v2 -name '*.js' -printf '%T@ %s %p\\n' 2>/dev/null | sort -rn | head -20",
  "echo '=== check the dist path that is being served (curl with skip_zrok_interstitial) ==='",
  "curl -s 'https://nctmechanic.shares.zrok.io/dashboard/v2/' -H 'skip_zrok_interstitial: 1' --max-time 8 | head -8",
  "echo '=== fetch the main bundle from zrok ==='",
  "curl -s 'https://nctmechanic.shares.zrok.io/dashboard/v2/assets/main-CnYrT-P7.js' -H 'skip_zrok_interstitial: 1' --max-time 8 -o /tmp/m.js; head -c 200 /tmp/m.js; echo",
  "echo '=== the user reported a 404 — the route prefix in their error is /dashboard/api/feedback/vote (no v2 segment). Test that on zrok: ==='",
  "curl -i -s -X POST 'https://nctmechanic.shares.zrok.io/dashboard/api/feedback/vote' -H 'skip_zrok_interstitial: 1' -H 'Content-Type: application/json' -d '{}' --max-time 10 2>&1 | head -10",
  "echo '=== with -L (follow redirects, zrok sometimes redirects to interstitial) ==='",
  "curl -i -sL -X POST 'https://nctmechanic.shares.zrok.io/dashboard/api/feedback/vote' -H 'skip_zrok_interstitial: 1' -H 'Content-Type: application/json' -d '{}' --max-time 12 2>&1 | head -15",
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
