# Control Claude on Discord

> Run Claude Code on remote servers and interact via Discord channels.

Run Claude Code on a remote server (like an HPC cluster) and control it entirely through Discord. No SSH terminal needed — just chat.

**How it works:** You create a category in Discord (e.g. "Claude"). Any channel you create under that category automatically gets its own Claude Code session running on your server. Type a message in the channel, and Claude Code executes it — reading files, running commands, editing code — all from Discord. When Claude needs permission to do something dangerous, it asks via emoji reactions (1️⃣ approve once, 2️⃣ approve for session, 3️⃣ deny). Conversations persist across bot restarts, so you can pick up where you left off.

## Features

- **Category-based routing** — Channels under a specific Discord category automatically get their own Claude Code session
- **Permission system** — 3-option reactions (1️⃣ once / 2️⃣ allow for session / 3️⃣ deny) for tool approvals, with read-only tools auto-approved
- **Session persistence** — Conversations resume across bot restarts
- **Multi-token support** — Configure multiple OAuth tokens and switch between them per user via DMs
- **Slash commands** — `/reset`, `/model`, `/compact`, `/interrupt`, `/debug`, `/context`
- **Text commands** — `!reset`, `!interrupt`, `!debug`, `!help`
- **DM commands** — Send tokens, `use <alias>`, `tokens`, `help`
- **File attachments** — Upload files in Discord and Claude can access them
- **Message chunking** — Long responses are automatically split to fit Discord's 2000-character limit

## Prerequisites

- **Node.js 18+**
- **Claude Code CLI** (`npm install -g @anthropic-ai/claude-code`)
- **Discord bot** with Message Content Intent enabled

## Quick Start

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g., "Claude Code")
3. Go to **Bot** → enable these **Privileged Gateway Intents**:
   - ✅ Message Content Intent
   - ✅ Server Members Intent
4. Copy the **Bot Token**

### 2. Invite the Bot to Your Server

1. Go to **OAuth2** → **URL Generator**
2. Select scopes: `bot`, `applications.commands`
3. Select permissions: `Send Messages`, `Read Message History`, `Attach Files`, `Add Reactions`, `Use Slash Commands`
4. Open the generated URL to invite the bot

### 3. Create a Category

In your Discord server, create a category (e.g., "Claude"). Any channel created under this category will automatically get a Claude Code session.

### 4. Install and Configure

```bash
git clone https://github.com/your-username/control-claude-on-discord.git
cd control-claude-on-discord/app
npm install
npm run build
```

Copy the example environment file and fill in your tokens:

```bash
cp .env.example ../.env
nano ../.env
```

### 5. Start the Bot

```bash
npm start
```

### 6. Connect via Discord

1. The bot prints a **session token** on startup
2. **DM the bot** with the token to authenticate
3. Create a channel under your configured category
4. Start chatting!

## Cluster Deployment

Running on an HPC cluster or remote server:

```bash
# SSH to your server
ssh your-server

# Setup
git clone https://github.com/your-username/control-claude-on-discord.git
cd control-claude-on-discord/app
./setup.sh

# Get a Claude Code OAuth token (headless)
claude setup-token
# Copy the token into ../.env

# Use a random high port to avoid conflicts on shared clusters
# Edit ../.env: ORCHESTRATOR_PORT=31415

# Run in tmux for persistence
tmux new -s claude-bot
npm start
# Detach: Ctrl+B, D

# Reattach later
tmux attach -t claude-bot
```

**Tip:** On shared clusters, use a random high port (10000–65535) for `ORCHESTRATOR_PORT` to avoid collisions with other users.

## Configuration

All options go in `.env` (in the repo root):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | ✅ | — | Bot token from Discord Developer Portal |
| `CLAUDE_CODE_OAUTH_TOKEN` | ✅ | — | OAuth token from `claude setup-token` |
| `CATEGORY_NAME` | | `Claude` | Discord category name to watch |
| `WORKING_DIRECTORY` | | `.` | Working directory for Claude Code sessions |
| `ORCHESTRATOR_PORT` | | `3000` | Port for internal orchestrator communication |
| `CLAUDE_MODEL` | | `claude-sonnet-4-5-20250929` | Model to use |
| `CONTEXT_WINDOW_MAX` | | `200000` | Max context tokens (for `/context` stats) |

### Multiple Tokens

You can configure multiple OAuth tokens with aliases:

```env
CLAUDE_CODE_OAUTH_TOKEN_default=sk-ant-oat01-your-default-token
CLAUDE_CODE_OAUTH_TOKEN_work=sk-ant-oat01-your-work-token
CLAUDE_CODE_OAUTH_TOKEN_personal=sk-ant-oat01-your-personal-token
```

Users can switch tokens by DMing the bot: `tokens` to list, `use <alias>` to switch.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           Remote Server                              │
│                                                                      │
│  ┌─────────────────────┐      ┌────────────────────────────────────┐ │
│  │   Main Orchestrator │      │  Claude Code + MCP (Channel #1)   │ │
│  │   (Discord Gateway  │◄────►│  - PTY terminal (node-pty)        │ │
│  │    Bot)             │      │  - discord-messenger MCP server    │ │
│  │                     │      └────────────────────────────────────┘ │
│  │  - Session tokens   │      ┌────────────────────────────────────┐ │
│  │  - Channel mapping  │◄────►│  Claude Code + MCP (Channel #2)   │ │
│  │  - Message routing  │      └────────────────────────────────────┘ │
│  │  - Permission mgmt  │                                            │
│  └──────────┬──────────┘                                            │
│             │ WebSocket                                              │
└─────────────┼────────────────────────────────────────────────────────┘
              ▼
       [ Discord API ]
```

Each channel gets its own Claude Code process running in a PTY (via `node-pty`). The orchestrator routes Discord messages to the correct session and handles tool permission requests via emoji reactions. An MCP server (`discord-messenger`) lets Claude Code send messages back to Discord.

## Commands Reference

### Slash Commands (in channels)

| Command | Description |
|---------|-------------|
| `/reset` | Start a new conversation |
| `/model` | Change the Claude model |
| `/compact` | Compact conversation context |
| `/interrupt` | Interrupt Claude (Ctrl+C) |
| `/debug` | Show raw terminal output |
| `/context` | Show context window usage |

### Text Commands (in channels)

| Command | Description |
|---------|-------------|
| `!reset` / `!new` | Start a new conversation |
| `!interrupt` / `!stop` | Interrupt Claude |
| `!debug` | Show terminal output |
| `!help` | Show available commands |

### DM Commands

| Command | Description |
|---------|-------------|
| `<token>` | Authenticate with a session token |
| `tokens` | List available OAuth tokens |
| `use <alias>` | Switch to a different token |
| `help` | Show DM commands |

## Troubleshooting

### Bot not responding in channels
- Verify the channel is under the correct category (check `CATEGORY_NAME`)
- Ensure **Message Content Intent** is enabled in Discord Developer Portal
- Check logs for errors

### "Invalid API key" error
```bash
claude -p "hi"          # Test authentication
claude setup-token      # Regenerate token if needed
```

### Permission reactions not working
- Make sure the bot has **Add Reactions** permission
- The user who sent the message must react (not someone else)

### Session not persisting
- Session data is stored in `.minion-sessions.json` and `.minion-channel-sessions.json`
- These files must be writable in the repo root

## Credits

- Original Slack version: [tonychenxyz/claude-code-minion-public](https://github.com/tonychenxyz/claude-code-minion-public)

## License

MIT
