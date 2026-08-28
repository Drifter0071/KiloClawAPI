#!/usr/bin/env bash
# Smoke test: start the API in the background, hit each endpoint, stop it.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${READ_TOKEN:?Set CMMS_API_TOKEN_READ}"
PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"

export PORT HOST CMMS_API_TOKEN_READ="$READ_TOKEN"
export CMMS_DB_PATH="${CMMS_DB_PATH:-../cmms.db}"
export CMMS_SKIP_FULL_ETL="${CMMS_SKIP_FULL_ETL:-true}"

# 1) start
echo "== starting cmms-api on ${BASE} =="
"./cmms-api" > cmms-api.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

# Wait for /v1/health to come up (RAG build can take a few seconds).
for i in $(seq 1 90); do
  if curl -fsS "${BASE}/v1/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "${BASE}/v1/health" >/dev/null; then
  echo "server did not start"; cat cmms-api.log; exit 1
fi

echo "== /v1/health =="
curl -fsS "${BASE}/v1/health" | tee /dev/stderr
echo

echo "== /v1/chat/completions (non-stream) =="
curl -fsS -H "authorization: Bearer ${READ_TOKEN}" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Melyik jegyen volt vezérlő hiba?"}]}' \
  "${BASE}/v1/chat/completions" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('content=', d['choices'][0]['message']['content'][:200]); print('hits=', d['cmms']['hits_count'], 'used_llm=', d['cmms']['used_llm'])"

echo "== /v1/chat/completions (SSE, first 5 lines) =="
curl -fsS -N -H "authorization: Bearer ${READ_TOKEN}" -H "content-type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"vezérlő hiba"}]}' \
  "${BASE}/v1/chat/completions" | head -5

echo "== auth: no token should be 401 =="
code=$(curl -s -o /dev/null -w "%{http_code}" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"x"}]}' "${BASE}/v1/chat/completions")
echo "got $code (expect 401)"

echo "== unknown route should be 404 =="
code=$(curl -s -o /dev/null -w "%{http_code}" -H "authorization: Bearer ${READ_TOKEN}" "${BASE}/v1/jobs/search")
echo "got $code (expect 404)"

echo "== ALL GOOD =="
