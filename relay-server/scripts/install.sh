#!/bin/sh
# Install cloudflared if not already present
set -e

INSTALL_DIR="$HOME/.kiro-remote"
DEST="$INSTALL_DIR/cloudflared"

# Check if already on PATH
if command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared already installed: $(cloudflared --version)"
  exit 0
fi

# Check if already downloaded
if [ -f "$DEST" ]; then
  echo "cloudflared already installed at $DEST"
  exit 0
fi

mkdir -p "$INSTALL_DIR"

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  SUFFIX="arm64"
else
  SUFFIX="amd64"
fi

URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${SUFFIX}"

echo "Downloading cloudflared for darwin-${SUFFIX}..."
curl -L -o "$DEST" "$URL"
chmod 755 "$DEST"

echo "cloudflared installed to $DEST"
echo "Add to PATH: export PATH=\"\$HOME/.kiro-remote:\$PATH\""
