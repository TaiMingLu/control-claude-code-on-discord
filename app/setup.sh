#!/bin/bash

set -e

echo "═══════════════════════════════════════════════════════════"
echo "        Control Claude on Discord (Discord) - Setup Script"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    echo "Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "Error: Node.js 18+ is required (found v$NODE_VERSION)"
    exit 1
fi

echo "✓ Node.js $(node -v) detected"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed"
    exit 1
fi

echo "✓ npm $(npm -v) detected"

# Check for Claude CLI
if ! command -v claude &> /dev/null; then
    echo "Warning: Claude CLI not found"
    echo "Install it with: npm install -g @anthropic-ai/claude-code"
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Build the project
echo ""
echo "Building..."
npm run build

# Create projects directory if it doesn't exist
if [ ! -d "../projects" ]; then
    mkdir -p ../projects
    echo "✓ Created ../projects directory"
fi

# Check for .env file at root level
if [ ! -f "../.env" ]; then
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  CONFIGURATION REQUIRED"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "Creating .env file..."
    cat > ../.env << 'EOF'
# Discord Bot Token (from Discord Developer Portal)
DISCORD_BOT_TOKEN=

# Claude Code OAuth Token (from 'claude setup-token')
CLAUDE_CODE_OAUTH_TOKEN=

# Category name to watch for channels (channels under this category get Claude Code)
CATEGORY_NAME=Claude

# Working directory for Claude Code
WORKING_DIRECTORY=/path/to/your/workspace

# Optional: Orchestrator port (default 3000)
# ORCHESTRATOR_PORT=3000

# Optional: Claude model (default claude-sonnet-4-5-20250929)
# CLAUDE_MODEL=claude-sonnet-4-5-20250929

# Optional: Multiple OAuth tokens
# CLAUDE_CODE_OAUTH_TOKEN_work=sk-ant-oat01-work-token
# CLAUDE_CODE_OAUTH_TOKEN_personal=sk-ant-oat01-personal-token
EOF
    echo ""
    echo "Please edit ../.env and add your tokens:"
    echo "  - DISCORD_BOT_TOKEN (from Discord Developer Portal)"
    echo "  - CLAUDE_CODE_OAUTH_TOKEN (from 'claude setup-token')"
    echo "  - WORKING_DIRECTORY (path to your projects)"
    echo ""
    exit 0
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  SETUP COMPLETE!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "To start the bot, run:"
echo "  cd app && npm start"
echo ""
echo "Or use the launcher script:"
echo "  ./start.sh"
echo ""
