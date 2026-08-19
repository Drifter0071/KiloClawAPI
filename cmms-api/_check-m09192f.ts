// _check-m09192f.ts - look at how 09192 appears in the serviz CSV
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    `cd /opt/cmms-api/csv-integration
echo "=== header of SZERVIZLAP BELSŐ 2020-.csv ==="
head -1 "Szervizlap belső - SZERVIZLAP BELSŐ 2020-.csv"
echo "=== rows containing 09192 - first 20 ==="
grep -n 09192 "Szervizlap belső - SZERVIZLAP BELSŐ 2020-.csv" | head -20
echo "=== count of 09192 ==="
grep -c 09192 "Szervizlap belső - SZERVIZLAP BELSŐ 2020-.csv"`,
    (e, stream) => {
      if (e) { console.error(e); c.end(); return }
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (out += '[stderr] ' + d.toString()))
      stream.on('close', () => { console.log(out); c.end() })
    },
  )
})
c.on('error', (e) => console.error('conn error', e))
c.connect({ host: '10.0.3.81', port: 22, username: 'root', password: 'tarantula999' })
