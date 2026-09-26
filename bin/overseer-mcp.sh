#!/bin/sh
# Starts the Overseer MCP server for Claude Code (see .mcp.json).
# Also finds Node in ~/.local/node when it isn't on PATH, e.g. when VS Code runs as a Flatpak.
cd "$(dirname "$0")/.." || exit 1
PATH="$PATH:$HOME/.local/node/bin"
exec node --import tsx src/agent/mcp.ts
