#!/usr/bin/env bash
#
# Deploy RiftElo to Cloudflare Workers.
#
# ⚠️  MUST be run inside WSL (Ubuntu), NOT native Windows. OpenNext's bundler
#     mangles Windows paths and the deploy fails; the local `preview` also hangs
#     on Windows. See DEPLOYMENT.md for the full story.
#
# Usage (from Windows, via the Bash tool or a terminal):
#   wsl.exe -e bash -lc "bash /mnt/c/Users/kyin9/Documents/GitHub/RiftboundElo/scripts/deploy.sh"
#
# What it does: edits happen in the Windows working tree; this rsyncs that tree
# into a WSL-native copy (~/riftelo) where the toolchain works, regenerates the
# Prisma client for Linux, then builds + deploys the Worker.
#
set -euo pipefail

# Repo root = one level up from this script (auto-detected, works from /mnt/c).
SRC="${RIFTELO_SRC:-$(cd "$(dirname "$0")/.." && pwd)}"
WORK="${RIFTELO_WORK:-$HOME/riftelo}"

# Node 22+ is required by wrangler; WSL's system node is often older.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null 2>&1 || true
node -v | grep -qE 'v(2[2-9]|[3-9][0-9])' || { echo "ERROR: need Node >=22 in WSL (got $(node -v)). Install via nvm."; exit 1; }

if [ "$SRC" != "$WORK" ]; then
  echo "→ syncing working tree  $SRC  →  $WORK"
  mkdir -p "$WORK"
  # Exclude native/generated/heavy dirs — WSL regenerates its own Linux copies.
  rsync -a --delete \
    --exclude node_modules --exclude .next --exclude .open-next --exclude .git \
    --exclude .wrangler --exclude "src/generated" --exclude "prisma/dev.db" \
    --exclude "prisma/dump.json" --exclude ".scratch_*.log" \
    "$SRC/" "$WORK/"
fi

cd "$WORK"
echo "→ npm install (Linux binaries; no-op if unchanged)"
npm install --no-audit --no-fund

echo "→ prisma generate (engineType=client → wasm compiler, no native engine)"
npx prisma generate

echo "→ opennextjs-cloudflare build"
npx opennextjs-cloudflare build

echo "→ opennextjs-cloudflare deploy"
npx opennextjs-cloudflare deploy

echo "✓ deployed. Verify:"
echo "    curl -s -o /dev/null -w '%{http_code}\\n' https://riftelo.doombornegame.workers.dev/riftelo"
echo "    curl -s -o /dev/null -w '%{http_code}\\n' --doh-url https://1.1.1.1/dns-query https://kevin-yin.com/riftelo"
