// _check-m09192e.ts - search the CSV integration files for M09192
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    `cd /opt/cmms-api/csv-integration
echo "=== Files containing M09192 anywhere ==="
grep -l M09192 *.csv 2>/dev/null
echo "=== Number of occurrences per file ==="
for f in *.csv; do
  c=$(grep -c M09192 "$f" 2>/dev/null)
  if [ "$c" != "0" ] && [ -n "$c" ]; then echo "$f: $c matches"; fi
done
echo "=== Sample lines for M09192 - first 5 files ==="
FILES=$(grep -l M09192 *.csv 2>/dev/null | head -5)
for f in $FILES; do
  echo "---- $f ----"
  grep -i M09192 "$f" | head -5
done
echo "=== Also check 09192 without M prefix ==="
grep -l 09192 *.csv 2>/dev/null | head -10`,
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
