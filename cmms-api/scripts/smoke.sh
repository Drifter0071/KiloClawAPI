#!/usr/bin/env bash
# Smoke test: start the API in the background, hit each endpoint, stop it.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${READ_TOKEN:?Set CMMS_API_TOKEN_READ (and CMMS_API_TOKEN_WRITE for writes)}"
: "${WRITE_TOKEN:?Set CMMS_API_TOKEN_WRITE for writes}"

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"

export PORT HOST CMMS_API_TOKEN_READ="$READ_TOKEN" CMMS_API_TOKEN_WRITE="$WRITE_TOKEN"
export CMMS_DB_PATH="${CMMS_DB_PATH:-../cmms.db}"

# 1) start
echo "== starting cmms-api on ${BASE} =="
"./cmms-api" > cmms-api.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

# Wait for /v1/health to come up.
for i in $(seq 1 60); do
  if curl -fsS "${BASE}/v1/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "${BASE}/v1/health" >/dev/null; then
  echo "server did not start"; cat cmms-api.log; exit 1
fi

echo "== /v1/health =="
curl -fsS "${BASE}/v1/health" | tee /dev/stderr
echo

echo "== /v1/schema (size only) =="
curl -fsS -H "authorization: Bearer ${READ_TOKEN}" "${BASE}/v1/schema" | wc -c

echo "== /v1/index (top 3 customers) =="
curl -fsS -H "authorization: Bearer ${READ_TOKEN}" "${BASE}/v1/index" | python -c "import sys,json; d=json.load(sys.stdin); print('totalJobs=',d['totalJobs']); print('top3 customers=',[c['name'] for c in d['topCustomers'][:3]])"

echo "== /v1/jobs/search q=TMV-400 =="
curl -fsS -H "authorization: Bearer ${READ_TOKEN}" -H "content-type: application/json" \
  -d '{"q":"TMV-400","limit":3}' "${BASE}/v1/jobs/search" | python -c "import sys,json; d=json.load(sys.stdin); print('hits=',d['total']); print('first=', d['jobs'][0]['sorszam'] if d['jobs'] else None)"

echo "== /v1/jobs/1 =="
curl -fsS -H "authorization: Bearer ${READ_TOKEN}" "${BASE}/v1/jobs/1" | python -c "import sys,json; d=json.load(sys.stdin); print('sorszam=',d['sorszam'],'status=',d['status'],'devices=',len(d['devices']))"

echo "== /v1/jobs/1/raw (truncated) =="
curl -fsS -H "authorization: Bearer ${READ_TOKEN}" "${BASE}/v1/jobs/1/raw" | python -c "import sys,json; d=json.load(sys.stdin); print('keys=',list(d.keys())[:8])"

echo "== POST /v1/jobs (write token) =="
NEW=$(curl -fsS -H "authorization: Bearer ${WRITE_TOKEN}" -H "content-type: application/json" \
  -d '{"customer":{"name":"SMOKE TEST KFT.","address":"Budapest"},"devices":["TMV-400(10297)"],"reported":"smoke test fault","technician":"SMK"}' \
  "${BASE}/v1/jobs")
echo "$NEW" | python -c "import sys,json; d=json.load(sys.stdin); print('created key=',d['key'],'sorszam=',d['sorszam'])"

NEW_KEY=$(echo "$NEW" | python -c "import sys,json; print(json.load(sys.stdin)['key'])")

echo "== POST /v1/jobs/$NEW_KEY/notes (write token) =="
curl -fsS -H "authorization: Bearer ${WRITE_TOKEN}" -H "content-type: application/json" \
  -d '{"kind":"work","body":"smoke test resolution","author":"smk"}' \
  "${BASE}/v1/jobs/${NEW_KEY}/notes" | python -c "import sys,json; d=json.load(sys.stdin); print('notes now=',len(d['notes']))"

echo "== /v1/jobs/$NEW_KEY/raw shows mirrored row =="
curl -fsS -H "authorization: Bearer ${READ_TOKEN}" "${BASE}/v1/jobs/${NEW_KEY}/raw" | python -c "import sys,json; d=json.load(sys.stdin); print('AKTUÁLIS NÉV=',d.get('AKTUÁLIS NÉV'),'NY/Z=',d.get('NY/Z'),'MEGJEGYZÉS startswith=',(d.get('MEGJEGYZÉS') or '')[:30])"

echo "== auth: write endpoint with read token should be 403 =="
code=$(curl -s -o /dev/null -w "%{http_code}" -H "authorization: Bearer ${READ_TOKEN}" -H "content-type: application/json" \
  -d '{"customer":{"name":"X"},"reported":"x"}' "${BASE}/v1/jobs")
echo "got $code (expect 403)"

echo "== auth: no token should be 401 =="
code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/v1/schema")
echo "got $code (expect 401)"

echo "== ALL GOOD =="
