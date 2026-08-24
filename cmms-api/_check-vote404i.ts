// _check-vote404i.ts — check what AskPage chunk fetches at click time
import { Client } from 'ssh2'

const CMD = [
  "echo '=== entire dist file listing newest first ==='",
  "find /opt/cmms-api/dashboard/v2/assets -name 'AskPage*' -o -name 'main*' -o -name 'useFeedback*' 2>/dev/null",
  "echo '=== look for ALL feedback/* or api/* paths in any chunk ==='",
  "for f in /opt/cmms-api/dashboard/v2/assets/*.js; do grep -oP '\"/[a-zA-Z0-9_/\\-\\.]*api[a-zA-Z0-9_/\\-\\.]*\"' \"$f\" 2>/dev/null | sort -u; done | sort -u",
  "echo '=== check the jsonRequest helper (b) for prefix logic ==='",
  "grep -oP '.{0,200}function b\\(.{0,400}' /opt/cmms-api/dashboard/v2/assets/main-CnYrT-P7.js | head -3",
  "echo '=== check if the helper appends a base or uses URL constructor ==='",
  "grep -oP 'b\\(\"\\/dashboard\\/[^\"]{0,40}' /opt/cmms-api/dashboard/v2/assets/main-CnYrT-P7.js | head -10",
  "echo '=== search for any /v1/feedback literal (some builds proxy through that) ==='",
  "grep -l 'v1/feedback' /opt/cmms-api/dashboard/v2/assets/*.js 2>/dev/null | head -5",
  "echo '=== ensure no UseApi alternatives call /api/feedback without /dashboard prefix ==='",
  "grep -oP '\"/api/feedback[^\"]*\"' /opt/cmms-api/dashboard/v2/assets/*.js 2>/dev/null | head -5",
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
