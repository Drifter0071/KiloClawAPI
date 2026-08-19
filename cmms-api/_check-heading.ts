// _check-heading.ts — verify the deployed AskPage chunk has the
// ATX heading code compiled in (data-testid="agent-body-heading-...").
import { Client } from 'ssh2'

const c = new Client()
c.on('ready', () => {
  c.exec(
    "grep -c 'agent-body-heading' /opt/cmms-api/dashboard/v2/assets/AskPage-*.js && echo --- && grep -o 'openai/gpt-[0-9.]*-luna-pro' /opt/cmms-api/dashboard/v2/assets/*.js | head -1",
    (e, stream) => {
      if (e) { console.error('exec error', e); c.end(); return }
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (out += '[stderr] ' + d.toString()))
      stream.on('close', () => { console.log(out); c.end() })
    },
  )
})
c.on('error', (e) => console.error('conn error', e))
c.connect({
  host: '10.0.3.81',
  port: 22,
  username: 'root',
  password: 'tarantula999',
})
