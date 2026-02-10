#!/usr/bin/env node

import { DiscordBot } from './discord-bot.js';
import { SessionManager } from './session-manager.js';
import { TerminalManager } from './terminal-manager.js';
import { Session, OAuthToken } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// App directory is where this script lives (app/dist -> app/)
const appDirectory = path.resolve(__dirname, '..');
// Root directory is parent of app/
const rootDirectory = path.resolve(appDirectory, '..');

interface Config {
  discordBotToken: string;
  orchestratorPort: number;
  workingDirectory: string;
  appDirectory: string;
  oauthTokens: OAuthToken[];
  categoryName: string;
}

function loadConfig(): Config {
  // Try to load from .env file in root directory
  const envPath = path.join(rootDirectory, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
        process.env[key.trim()] = value;
      }
    }
  }

  const discordBotToken = process.env.DISCORD_BOT_TOKEN;
  const orchestratorPort = parseInt(process.env.ORCHESTRATOR_PORT || '3000', 10);
  const defaultWorkingDir = rootDirectory;
  const workingDirectory = process.env.WORKING_DIRECTORY || defaultWorkingDir;
  const categoryName = process.env.CATEGORY_NAME || 'Claude Code';

  if (!discordBotToken) {
    console.error('Error: DISCORD_BOT_TOKEN is required');
    console.error('Set it in .env file or as environment variable');
    process.exit(1);
  }

  // Parse OAuth tokens
  const oauthTokens: OAuthToken[] = [];

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    oauthTokens.push({
      alias: 'default',
      token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      isDefault: true,
    });
  }

  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^CLAUDE_CODE_OAUTH_TOKEN_(.+)$/);
    if (match && value) {
      const alias = match[1].toLowerCase();
      if (!oauthTokens.some(t => t.alias === alias)) {
        oauthTokens.push({
          alias,
          token: value,
          isDefault: oauthTokens.length === 0,
        });
      }
    }
  }

  if (oauthTokens.length === 0) {
    console.warn('Warning: No CLAUDE_CODE_OAUTH_TOKEN found');
  }

  const hasDefault = oauthTokens.some(t => t.isDefault);
  if (!hasDefault && oauthTokens.length > 0) {
    oauthTokens[0].isDefault = true;
  }

  return {
    discordBotToken,
    orchestratorPort,
    workingDirectory,
    appDirectory,
    oauthTokens,
    categoryName,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           Claude Code Minion - Discord Bot');
  console.log('═══════════════════════════════════════════════════════════');

  const config = loadConfig();

  console.log(`App directory: ${config.appDirectory}`);
  console.log(`Working directory: ${config.workingDirectory}`);
  console.log(`Orchestrator port: ${config.orchestratorPort}`);
  console.log(`Category name: ${config.categoryName}`);

  if (config.oauthTokens.length > 0) {
    console.log(`OAuth tokens configured: ${config.oauthTokens.length}`);
    for (const token of config.oauthTokens) {
      const defaultLabel = token.isDefault ? ' (default)' : '';
      console.log(`  - ${token.alias}${defaultLabel}: ${token.token.substring(0, 20)}...`);
    }
  }

  if (!fs.existsSync(config.workingDirectory)) {
    fs.mkdirSync(config.workingDirectory, { recursive: true });
    console.log(`Created working directory: ${config.workingDirectory}`);
  }

  // Initialize managers
  const sessionManager = new SessionManager(config.workingDirectory, config.oauthTokens);

  // Initialize Discord bot
  const bot = new DiscordBot(
    config.discordBotToken,
    config.workingDirectory,
    config.appDirectory,
    sessionManager,
    null as any,
    config.oauthTokens,
    config.categoryName
  );

  // Create terminal manager
  const terminalManager = new TerminalManager(
    config.workingDirectory,
    config.appDirectory,
    (channelId, message) => bot.handleQueueProcess(channelId, message),
    (channelId) => bot.handleAgentTurnComplete(channelId),
    (channelId, prompt) => bot.handlePromptDetected(channelId, prompt)
  );

  // Wire up
  (bot as any).terminalManager = terminalManager;

  // Check for existing session with a linked user
  const existingSessions: Session[] = Array.from((sessionManager as any).sessions?.values() || []);
  const existingUserSession = existingSessions.find((s) => s.userId && s.dmChannelId);

  let session: Session;
  if (existingUserSession) {
    // Reuse existing session — no need to re-authenticate
    session = existingUserSession;
    console.log(`\nRestored session for user ${session.userId} (token: ${session.token})`);
  } else {
    // First run — create new session token
    session = sessionManager.createSession('', '', config.workingDirectory);
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  SESSION TOKEN: ' + session.token);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('To connect:');
    console.log('1. DM the bot in Discord with this token');
    console.log(`2. Create a channel under the "${config.categoryName}" category`);
    console.log('3. Start chatting with Claude Code!');
  }
  console.log('');

  // Start orchestrator
  process.env.ORCHESTRATOR_PORT = config.orchestratorPort.toString();
  bot.startOrchestratorServer(config.orchestratorPort);

  // Start bot
  await bot.start();

  // Send restart notification
  if (existingUserSession?.userId && existingUserSession?.dmChannelId) {
    try {
      await bot.sendDirectMessage(
        existingUserSession.dmChannelId,
        `🔄 **Bot restarted!**\n\nYour session has been restored automatically. No need to re-authenticate.\n\nYour existing channel sessions should continue working.`
      );
      console.log(`Sent restart notification to user ${existingUserSession.userId}`);
    } catch (error) {
      console.error('Failed to send restart notification:', error);
    }
  }

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    await bot.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
