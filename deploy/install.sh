#!/usr/bin/env bash
# Install the server into Claude Code and sign in.
#
# Everything here is one command each. It exists so nobody has to read the
# README to get started, not because the steps are complicated.
set -euo pipefail

PKG="@thenavidm/midjourney-mcp-cli@latest"

command -v node >/dev/null 2>&1 || {
  echo "Node 22 or newer is required. https://nodejs.org" >&2
  exit 1
}

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 22 ]; then
  echo "Node 22 or newer is required, found $(node -v)." >&2
  echo "The browser connection uses the global WebSocket added in Node 22." >&2
  exit 1
fi

echo "Installing the MCP server into Claude Code..."
if command -v claude >/dev/null 2>&1; then
  claude mcp add midjourney --scope user -- npx -y "$PKG"
else
  echo "The claude CLI is not installed, so nothing was registered."
  echo "Add this to your client's config yourself:"
  echo "  command: npx"
  echo "  args:    -y $PKG"
fi

echo
echo "Signing in. A Chrome window will open."
npx -y "$PKG" login

echo
npx -y "$PKG" doctor
