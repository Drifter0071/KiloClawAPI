#!/usr/bin/env bash
# Inline install — assumes binary and DB are already at their target paths.
# Called by deploy.ts with the right variables set.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/cmms-api}"
DATA_DIR="${DATA_DIR:-/var/lib/cmms}"
CMMS_DB_PATH="${CMMS_DB_PATH:-/var/lib/cmms/cmms.db}"
ENV_FILE="/etc/cmms-api.env"
SERVICE_USER="cmmsapi"
PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"

CMMS_READ_TOKEN="${CMMS_API_TOKEN_READ:-$(openssl rand -hex 32)}"
CMMS_WRITE_TOKEN="${CMMS_API_TOKEN_WRITE:-$(openssl rand -hex 32)}"

# 1. system user
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# 2. install bun if missing
if ! command -v bun >/dev/null 2>&1; then
  echo "==> installing bun"
  curl -fsSL https://bun.sh/install | bash
  cp "$HOME/.bun/bin/bun" /usr/local/bin/bun
  chmod +x /usr/local/bin/bun
fi

# 3. dirs
install -d -m 0755 "$INSTALL_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"

# 4. fix permissions on already-uploaded files
chmod 0755 "$INSTALL_DIR/cmms-api"
chown "$SERVICE_USER:$SERVICE_USER" "$CMMS_DB_PATH" || true
chmod 0640 "$CMMS_DB_PATH" || true

# 5. env file
umask 077
cat > "$ENV_FILE" <<EOF
CMMS_DB_PATH=$CMMS_DB_PATH
CMMS_SPECIALIZED_DB=$DATA_DIR/cmms_specialized.db
PORT=$PORT
HOST=$HOST
CMMS_API_TOKEN_READ=$CMMS_READ_TOKEN
CMMS_API_TOKEN_WRITE=$CMMS_WRITE_TOKEN
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 0600 "$ENV_FILE"
ln -sf "$ENV_FILE" "$INSTALL_DIR/.env" 2>/dev/null || true

# 6. systemd unit — cmms-api
cat > /etc/systemd/system/cmms-api.service <<EOF
[Unit]
Description=cmms-api
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$INSTALL_DIR/cmms-api
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true
PrivateDevices=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cmms-api.service
systemctl restart cmms-api.service

# 7. cloudflared
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "==> installing cloudflared"
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
    | tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  apt-get update -qq && apt-get install -y cloudflared
fi

# 8. cloudflared quick tunnel
cat > /etc/systemd/system/cloudflared-cmms.service <<EOF
[Unit]
Description=Cloudflare tunnel to cmms-api
After=cmms-api.service network-online.target
Wants=cmms-api.service

[Service]
Type=simple
ExecStart=$(command -v cloudflared) tunnel --no-autoupdate --url http://127.0.0.1:$PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cloudflared-cmms.service
systemctl restart cloudflared-cmms.service

# 9. wait for tunnel URL
sleep 3
TUNNEL_URL=""
for attempt in $(seq 1 30); do
  TUNNEL_URL=$(journalctl -u cloudflared-cmms.service --no-pager -n 200 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)
  if [ -n "$TUNNEL_URL" ]; then break; fi
  sleep 1
done

# 10. save tunnel info to home directory
if [ -n "$TUNNEL_URL" ]; then
  cat > ~/tunnel-info.txt <<EOF
Tunnel URL: $TUNNEL_URL
Read Token: $CMMS_READ_TOKEN
Write Token: $CMMS_WRITE_TOKEN
Base URL: $TUNNEL_URL/v1/capabilities
Health: $TUNNEL_URL/v1/health
EOF
  echo "Tunnel info saved to ~/tunnel-info.txt"
fi

# 11. summary
echo ""
echo "============================================================"
echo "cmms-api installed and running."
echo ""
echo "  bind    : http://$HOST:$PORT"
echo "  binary  : $INSTALL_DIR/cmms-api"
echo "  db      : $CMMS_DB_PATH"
echo "  env     : $ENV_FILE"
echo "  tunnel  : ${TUNNEL_URL:-pending}"
echo ""
echo "  Read token  : $CMMS_READ_TOKEN"
echo "  Write token : $CMMS_WRITE_TOKEN"
echo "============================================================"
