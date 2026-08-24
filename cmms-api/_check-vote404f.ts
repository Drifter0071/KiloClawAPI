// _check-vote404f.ts — examine the dist code around the call
import { Client } from 'ssh2'

const CMD = [
  // get 400 bytes around the feedback/vote call site
  "dd if=/opt/cmms-api/dashboard/v2/assets/main-CnYrT-P7.js bs=1 skip=17650 count=300 2>/dev/null",
  "echo '===END==='",
  // also peek at the jsonRequest helper
  "echo '=== jsonRequest ==='",
  "grep -oP '.{0,300}jsonRequest.{0,300}' /opt/cmms-api/dashboard/v2/assets/main-CnYrT-P7.js | head -3",
  "echo '=== fetch call sites in feedback area ==='",
  "dd if=/opt/cmms-api/dashboard/v2/assets/main-CnYrT-P7.js bs=1 skip=17500 count=1500 2>/dev/null | tr ',' '\\n' | grep -E 'fetch|feedback|method' | head -20",
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
