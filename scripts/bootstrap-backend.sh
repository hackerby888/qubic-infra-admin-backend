#!/usr/bin/env bash
# Provision a NEW backend instance for the qubic admin fleet.
# Run as root on a fresh Ubuntu box. Idempotent — safe to re-run.
#
#   scp scripts/bootstrap-backend.sh root@<NEW_IP>:/root/ && ssh root@<NEW_IP> bash /root/bootstrap-backend.sh
#   # or:
#   curl -fsSL https://raw.githubusercontent.com/hackerby888/qubic-infra-admin-backend/main/scripts/bootstrap-backend.sh | bash
#
# After it finishes:
#   1) copy the shared .env onto the box (it holds the secrets, so it is NOT in git)
#   2) add the box IP to the deploy fleet:   gh variable set BACKEND_HOSTS -b '[...,"<NEW_IP>"]'
#   3) add <NEW_IP>:80 as an origin in the Cloudflare LB pool 'qubic_global'
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24.14.0}"
REPO="${REPO:-https://github.com/hackerby888/qubic-infra-admin-backend.git}"
APP_DIR="${APP_DIR:-/root/qubic-infra-admin-backend}"
APP_NAME="${APP_NAME:-qubic}"

echo "==> nvm + node $NODE_VERSION + pm2"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"   # so deploy.yml's `nvm use default` works
npm install -g pm2

echo "==> repo -> $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch origin --prune
    git -C "$APP_DIR" checkout -f main
    git -C "$APP_DIR" reset --hard origin/main
else
    git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
    cat <<EOF

==> ALMOST DONE — the .env (secrets) is NOT on this box yet.
    Copy it from an existing instance, then re-run this script:
      ssh root@<EXISTING_BE> 'cat $APP_DIR/.env' | ssh root@<THIS_BOX> 'cat > $APP_DIR/.env'
    (.env must use the SAME JWT_SECRET as the other boxes, the RS MONGO_URI, PORT=80.)
EOF
    exit 0
fi

echo "==> build + pm2"
npm ci
npm run build
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
else
    pm2 start dist/index.js --name "$APP_NAME"
fi
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save

echo
echo "==> $APP_NAME is up. Verify:   curl -s http://127.0.0.1:80/health"
echo "==> NEXT (run from a machine with gh + your Cloudflare dashboard):"
echo "    1) add this box to the deploy fleet variable (append its IP):"
echo "         gh variable set BACKEND_HOSTS -R hackerby888/qubic-infra-admin-backend -b '[\"77.42.74.26\",\"40.160.3.59\",\"<THIS_IP>\"]'"
echo "    2) add <THIS_IP>:80 as an origin in the Cloudflare LB pool 'qubic_global'"
