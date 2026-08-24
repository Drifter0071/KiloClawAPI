// _check-vote404e.ts — find the *exact* string the deployed dist uses
// for the feedback vote URL. The dist has it in main-CnYrT-P7.js.
import { Client } from 'ssh2'
import { readFileSync } from 'node:fs'
import { Client as SSHClient } from 'ssh2'

const CMD = [
  "echo '=== exact bytes around feedback/vote in dist ==='",
  "grep -obP 'feedback/vote|/api/feedback|/v1/feedback|dashboard/api' /opt/cmms-api/dashboard/v2/assets/main-CnYrT-P7.js | head -20",
  "echo '=== look for jsonRequest path or /api prefix ==='",
  "grep -oP '\"/[a-zA-Z0-9_/\\-]*feedback[a-zA-Z0-9_/\\-]*\"' /opt/cmms-api/dashboard/v2/assets/main-CnYrT-P7.js | sort -u | head -20",
  "echo '=== what strings are passed as URL to fetch? ==='",
  "grep -oP '\"/[^\"]*api/feedback[^\"]*\"' /opt/cmms-api/dashboard/v2/assets/main-CnYrT-P7.js | sort -u | head",
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
