import {
  Client,
  GatewayIntentBits,
  Events,
  Message,
  TextChannel,
  DMChannel,
  ChannelType,
  Partials,
  Collection,
  Attachment,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { SessionManager } from './session-manager.js';
import { TerminalManager } from './terminal-manager.js';
import { OAuthToken, PromptInfo } from './types.js';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

interface PendingMessage {
  user: string;
  text: string;
  timestamp: Date;
  files?: string[];
}

interface PendingApproval {
  messageId: string;
  channelId: string;
  requestId: string;
  approvalPort: number;
  toolName: string;
  timestamp: number;
}

interface PendingPrompt {
  messageId: string;
  channelId: string;
  options: string[];
  timestamp: number;
}

// Number emoji mapping
const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const EMOJI_TO_INDEX: Record<string, number> = {
  '1️⃣': 0, '2️⃣': 1, '3️⃣': 2, '4️⃣': 3, '5️⃣': 4,
  '6️⃣': 5, '7️⃣': 6, '8️⃣': 7, '9️⃣': 8,
  '✅': 0, '❌': 1,
};

export class DiscordBot {
  private client: Client;
  private sessionManager: SessionManager;
  private terminalManager: TerminalManager;
  private orchestratorServer: http.Server | null = null;
  private workingDirectory: string;
  private appDirectory: string;
  private oauthTokens: OAuthToken[];
  private categoryName: string;
  private botToken: string;

  // Message queue per channel
  private messageQueues: Map<string, PendingMessage[]> = new Map();
  
  // Pending approval requests (messageId -> approval info)
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  
  // Session allowlist: channelId -> Set of tool names approved for the session
  private sessionAllowlists: Map<string, Set<string>> = new Map();
  
  // Pending interactive prompts (messageId -> prompt info)
  private pendingPrompts: Map<string, PendingPrompt> = new Map();

  constructor(
    botToken: string,
    workingDirectory: string,
    appDirectory: string,
    sessionManager: SessionManager,
    terminalManager: TerminalManager,
    oauthTokens: OAuthToken[] = [],
    categoryName: string = 'Claude Code'
  ) {
    this.botToken = botToken;
    this.workingDirectory = workingDirectory;
    this.appDirectory = appDirectory;
    this.sessionManager = sessionManager;
    this.terminalManager = terminalManager;
    this.oauthTokens = oauthTokens;
    this.categoryName = categoryName;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, (c) => {
      console.log(`⚡️ Discord bot ready! Logged in as ${c.user.tag}`);
      console.log(`Watching for channels in category: "${this.categoryName}"`);
    });

    // Handle messages
    this.client.on(Events.MessageCreate, async (message) => {
      // Ignore bot messages
      if (message.author.bot) return;

      // Handle DMs
      if (message.channel.type === ChannelType.DM) {
        await this.handleDM(message);
        return;
      }

      // Handle guild messages - check if in target category
      if (message.channel.type === ChannelType.GuildText) {
        const channel = message.channel as TextChannel;
        const parent = channel.parent;

        if (parent && parent.name.toLowerCase() === this.categoryName.toLowerCase()) {
          await this.handleChannelMessage(message);
        }
      }
    });

    // Handle slash commands
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await this.handleSlashCommand(interaction);
    });

    // Handle reactions for approval system and interactive prompts
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      // Ignore bot's own reactions
      if (user.bot) return;

      const messageId = reaction.message.id;
      const emoji = reaction.emoji.name || '';

      // Check if this is a pending approval message (MCP tool approval)
      const approval = this.pendingApprovals.get(messageId);
      if (approval) {
        // Map reactions to responses
        let response: 'allow' | 'allow_session' | 'deny' | null = null;
        let resultText = '';
        let resultEmoji = '';

        if (emoji === '1️⃣') {
          response = 'allow';
          resultEmoji = '✅';
          resultText = 'APPROVED (once)';
        } else if (emoji === '2️⃣') {
          response = 'allow_session';
          resultEmoji = '✅';
          resultText = `APPROVED for session (${approval.toolName || 'tool'})`;
          // Add to bot-level session allowlist
          if (!this.sessionAllowlists.has(approval.channelId)) {
            this.sessionAllowlists.set(approval.channelId, new Set());
          }
          this.sessionAllowlists.get(approval.channelId)!.add(approval.toolName);
        } else if (emoji === '3️⃣') {
          response = 'deny';
          resultEmoji = '❌';
          resultText = 'REJECTED';
        } else {
          return; // Ignore other reactions
        }

        console.log(`[Approval] User ${user.id} ${resultText} request ${approval.requestId}`);

        try {
          await this.sendApprovalResponse(approval.approvalPort, approval.requestId, response);
          
          const channel = await this.client.channels.fetch(approval.channelId) as TextChannel;
          const message = await channel.messages.fetch(messageId);
          
          await message.edit(message.content + `\n\n**${resultEmoji} ${resultText}** by <@${user.id}>`);
          
          this.pendingApprovals.delete(messageId);
        } catch (error) {
          console.error('[Approval] Failed to send response:', error);
        }
        return;
      }

      // Check if this is a pending interactive prompt (PTY prompt)
      const prompt = this.pendingPrompts.get(messageId);
      if (prompt) {
        const optionIndex = EMOJI_TO_INDEX[emoji];
        if (optionIndex === undefined || optionIndex >= prompt.options.length) return;

        console.log(`[Prompt] User ${user.id} selected option ${optionIndex + 1}: ${prompt.options[optionIndex]}`);

        try {
          // Send keystroke to terminal
          const success = this.terminalManager.sendPromptResponse(prompt.channelId, optionIndex);
          
          if (success) {
            const channel = await this.client.channels.fetch(prompt.channelId) as TextChannel;
            const message = await channel.messages.fetch(messageId);
            
            const selectedOption = prompt.options[optionIndex];
            await message.edit(message.content + `\n\n**Selected:** ${selectedOption} by <@${user.id}>`);
          }
          
          this.pendingPrompts.delete(messageId);
        } catch (error) {
          console.error('[Prompt] Failed to send response:', error);
        }
        return;
      }
    });
  }

  private async handleDM(message: Message): Promise<void> {
    const userId = message.author.id;
    const text = message.content.trim();
    const upperText = text.toUpperCase();

    // Check if it's a session token (8 character hex)
    if (/^[A-F0-9]{8}$/.test(upperText)) {
      const session = this.sessionManager.getSessionByToken(upperText);
      if (session) {
        this.sessionManager.updateSessionUser(upperText, userId, message.channel.id);
        await message.reply(
          `✅ **Session configured!**\n` +
          `Working directory: \`${session.workingDirectory}\`\n\n` +
          `Now go to any channel under the **${this.categoryName}** category and send a message - Claude Code will start automatically.`
        );
      } else {
        await message.reply(
          `❌ Invalid session token \`${upperText}\`.\n\n` +
          `The token should be 8 characters like \`A1B2C3D4\` - shown in the terminal when you run \`npm start\`.`
        );
      }
      return;
    }

    // Handle DM commands
    const lowerText = text.toLowerCase();

    if (lowerText === 'tokens' || lowerText === '!tokens') {
      await this.handleTokensCommand(message);
      return;
    }

    const useMatch = lowerText.match(/^!?use\s+(\S+)$/);
    if (useMatch) {
      await this.handleUseTokenCommand(message, useMatch[1]);
      return;
    }

    if (lowerText === 'help' || lowerText === '!help') {
      await this.handleHelpCommand(message);
      return;
    }

    // Default response
    const session = this.sessionManager.getSessionByUserId(userId);
    if (!session) {
      await message.reply(
        `Welcome! To get started:\n` +
        `1. Run \`npm start\` on your server\n` +
        `2. Copy the **SESSION TOKEN** shown (8 characters like \`A1B2C3D4\`)\n` +
        `3. Send me that token here\n\n` +
        `**Commands:**\n` +
        `• \`tokens\` - List available OAuth tokens\n` +
        `• \`use <alias>\` - Switch to a different token\n` +
        `• \`help\` - Show help`
      );
    } else {
      const currentToken = this.sessionManager.getOAuthTokenForUser(userId);
      const tokenInfo = currentToken ? `\nCurrent token: \`${currentToken.alias}\`` : '';
      await message.reply(
        `✅ You're connected! Session: \`${session.token}\`\n` +
        `Working directory: \`${session.workingDirectory}\`${tokenInfo}\n\n` +
        `Send messages in any channel under **${this.categoryName}** category to interact with Claude Code.`
      );
    }
  }

  private async handleTokensCommand(message: Message): Promise<void> {
    const tokens = this.oauthTokens;
    const userId = message.author.id;

    if (tokens.length === 0) {
      await message.reply(
        `❌ No OAuth tokens configured.\n\n` +
        `Add tokens to your \`.env\` file:\n` +
        `• Single: \`CLAUDE_CODE_OAUTH_TOKEN=<token>\`\n` +
        `• Multiple: \`CLAUDE_CODE_OAUTH_TOKEN_<alias>=<token>\``
      );
      return;
    }

    const currentToken = this.sessionManager.getOAuthTokenForUser(userId);
    const currentAlias = currentToken?.alias || 'default';

    let tokenList = '**Available OAuth Tokens:**\n';
    for (const token of tokens) {
      const isSelected = token.alias === currentAlias;
      const selectedMarker = isSelected ? ' ✅' : '';
      const defaultMarker = token.isDefault ? ' (default)' : '';
      const preview = token.token.substring(0, 15) + '...';
      tokenList += `• \`${token.alias}\`${defaultMarker}${selectedMarker} - \`${preview}\`\n`;
    }
    tokenList += `\nTo switch: \`use <alias>\``;

    await message.reply(tokenList);
  }

  private async handleUseTokenCommand(message: Message, alias: string): Promise<void> {
    const token = this.oauthTokens.find(t => t.alias.toLowerCase() === alias.toLowerCase());
    if (!token) {
      const available = this.oauthTokens.map(t => `\`${t.alias}\``).join(', ');
      await message.reply(`❌ Token \`${alias}\` not found.\n\nAvailable: ${available}`);
      return;
    }

    const success = this.sessionManager.setUserTokenPreference(message.author.id, token.alias);
    if (success) {
      await message.reply(`✅ Switched to token \`${token.alias}\``);
    } else {
      await message.reply(`❌ Failed to save token preference.`);
    }
  }

  private async handleHelpCommand(message: Message): Promise<void> {
    await message.reply(
      `**DM Commands:**\n` +
      `• \`<8-char token>\` - Connect with session token\n` +
      `• \`tokens\` - List OAuth tokens\n` +
      `• \`use <alias>\` - Switch token\n` +
      `• \`help\` - Show this help\n\n` +
      `**Channel Commands (slash):**\n` +
      `• \`/reset\` - New conversation\n` +
      `• \`/interrupt\` - Stop Claude (Ctrl+C)\n` +
      `• \`/compact\` - Compact context\n` +
      `• \`/debug\` - Show terminal output`
    );
  }

  private async handleChannelMessage(message: Message): Promise<void> {
    const channelId = message.channel.id;
    const userId = message.author.id;
    const text = message.content;

    // Check for text commands
    const lowerText = text.trim().toLowerCase();

    if (lowerText === '!interrupt' || lowerText === '!stop') {
      await this.handleInterrupt(message);
      return;
    }

    if (lowerText === '!reset' || lowerText === '!new') {
      await this.handleReset(message);
      return;
    }

    if (lowerText === '!debug') {
      await this.handleDebug(message);
      return;
    }

    if (lowerText === '!help') {
      await message.reply(
        `**Commands:**\n` +
        `• \`!interrupt\` / \`!stop\` - Stop Claude\n` +
        `• \`!reset\` / \`!new\` - New conversation\n` +
        `• \`!debug\` - Show terminal output`
      );
      return;
    }

    // Check if user has a session
    let session = this.sessionManager.getSessionByUserId(userId);
    if (!session) {
      await message.reply(`Please DM me your session token first to set up Claude Code.`);
      return;
    }

    // Get or create channel session
    let channelSession = this.sessionManager.getChannelSession(channelId);
    if (!channelSession) {
      await this.spawnClaudeCodeForChannel(channelId, session.token, userId, message.channel as TextChannel);
      await new Promise(resolve => setTimeout(resolve, 2000));
      channelSession = this.sessionManager.getChannelSession(channelId);
      if (!channelSession) {
        await message.reply(`Failed to start Claude Code. Please try again.`);
        return;
      }
    }

    // Download attachments
    const downloadedFiles = await this.processAttachments(message, channelId);

    // Build message with file info
    let messageWithFiles = text;
    if (downloadedFiles.length > 0) {
      const fileList = downloadedFiles.map(f => `  - ${f}`).join('\n');
      messageWithFiles = `${text}\n\n[Attached files saved to:\n${fileList}]`;
    }

    // Queue message
    this.queueMessage(channelId, userId, messageWithFiles);

    // Notify if busy
    if (this.terminalManager.isChannelBusy(channelId)) {
      const queuePos = this.terminalManager.getQueueLength(channelId) + 1;
      await message.reply(`⏳ Claude is busy. Your message is queued (position ${queuePos}).`);
    }

    // Get user's OAuth token
    const userToken = this.sessionManager.getOAuthTokenForUser(userId);

    // Send to terminal
    let success = await this.terminalManager.sendInput(channelSession.terminalId, messageWithFiles, userToken?.token);
    if (!success) {
      // Respawn terminal
      console.log(`[Channel ${channelId}] Terminal not found, respawning...`);
      await this.spawnClaudeCodeForChannel(channelId, channelSession.sessionToken, userId, message.channel as TextChannel);
      await new Promise(resolve => setTimeout(resolve, 1000));
      const newSession = this.sessionManager.getChannelSession(channelId);
      if (newSession) {
        success = await this.terminalManager.sendInput(newSession.terminalId, messageWithFiles, userToken?.token);
      }
      if (!success) {
        await message.reply(`Failed to send message to Claude Code.`);
      }
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = interaction.channelId;
    const channelSession = this.sessionManager.getChannelSession(channelId);

    switch (interaction.commandName) {
      case 'reset':
        if (!channelSession) {
          await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
          return;
        }
        this.terminalManager.resetConversation(channelId);
        this.messageQueues.set(channelId, []);
        this.sessionAllowlists.delete(channelId);
        await interaction.reply('🔄 Conversation reset. Next message starts fresh. Session allowlist cleared.');
        break;

      case 'interrupt':
        if (!channelSession) {
          await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
          return;
        }
        this.terminalManager.sendInterrupt(channelSession.terminalId);
        this.terminalManager.clearBusyState(channelId);
        this.messageQueues.set(channelId, []);
        await interaction.reply('⏹️ Interrupted Claude and cleared queue.');
        break;

      case 'compact':
        if (!channelSession) {
          await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
          return;
        }
        const userToken = this.sessionManager.getOAuthTokenForUser(interaction.user.id);
        await this.terminalManager.sendInput(channelSession.terminalId, '/compact', userToken?.token);
        await interaction.reply('📦 Sent /compact to Claude Code...');
        break;

      case 'debug':
        if (!channelSession) {
          await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
          return;
        }
        const output = this.terminalManager.getOutput(channelSession.terminalId, 30);
        const outputText = output.join('').slice(-1800);
        await interaction.reply({ content: `📟 Terminal output:\n\`\`\`\n${outputText || '(no output)'}\n\`\`\``, ephemeral: true });
        break;

      case 'context':
        if (!channelSession) {
          await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
          return;
        }
        const usage = this.terminalManager.getLatestUsageStats(channelId);
        if (!usage) {
          await interaction.reply({ content: 'No usage stats available yet.', ephemeral: true });
          return;
        }
        const totalContext = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        await interaction.reply(
          `📊 **Context Usage:**\n` +
          `• Input: ${usage.input_tokens || 0}\n` +
          `• Cache creation: ${usage.cache_creation_input_tokens || 0}\n` +
          `• Cache read: ${usage.cache_read_input_tokens || 0}\n` +
          `• Output: ${usage.output_tokens || 0}\n` +
          `• **Total: ${totalContext.toLocaleString()} tokens**`
        );
        break;

      case 'model':
        const modelName = interaction.options.getString('name');
        if (!modelName) {
          // Show current model
          const currentModel = this.terminalManager.getChannelModel(channelId);
          const isDefault = !channelSession;
          await interaction.reply(
            `🤖 **Current model:** \`${currentModel}\`${isDefault ? ' (default)' : ''}\n\n` +
            `To change: \`/model name:claude-opus-4-20250514\`\n` +
            `Common models:\n` +
            `• \`claude-sonnet-4-5-20250929\` (default, fast)\n` +
            `• \`claude-opus-4-20250514\` (powerful)`
          );
        } else {
          // Set model
          this.terminalManager.setChannelModel(channelId, modelName);
          await interaction.reply(`✅ Model set to \`${modelName}\` for this channel.\n\nNote: Takes effect on next message.`);
        }
        break;

      default:
        await interaction.reply({ content: 'Unknown command', ephemeral: true });
    }
  }

  private async handleInterrupt(message: Message): Promise<void> {
    const channelSession = this.sessionManager.getChannelSession(message.channel.id);
    if (!channelSession) {
      await message.reply('No active session in this channel.');
      return;
    }
    this.terminalManager.sendInterrupt(channelSession.terminalId);
    this.terminalManager.clearBusyState(message.channel.id);
    this.messageQueues.set(message.channel.id, []);
    await message.reply('⏹️ Interrupted Claude and cleared queue.');
  }

  private async handleReset(message: Message): Promise<void> {
    const channelSession = this.sessionManager.getChannelSession(message.channel.id);
    if (!channelSession) {
      await message.reply('No active session in this channel.');
      return;
    }
    this.terminalManager.resetConversation(message.channel.id);
    this.messageQueues.set(message.channel.id, []);
    this.sessionAllowlists.delete(message.channel.id);
    await message.reply('🔄 Conversation reset. Next message starts fresh. Session allowlist cleared.');
  }

  private async handleDebug(message: Message): Promise<void> {
    const channelSession = this.sessionManager.getChannelSession(message.channel.id);
    if (!channelSession) {
      await message.reply('No active session in this channel.');
      return;
    }
    const output = this.terminalManager.getOutput(channelSession.terminalId, 30);
    const outputText = output.join('').slice(-1800);
    await message.reply(`📟 Terminal output:\n\`\`\`\n${outputText || '(no output)'}\n\`\`\``);
  }

  private async spawnClaudeCodeForChannel(
    channelId: string,
    sessionToken: string,
    userId: string,
    channel: TextChannel
  ): Promise<void> {
    const session = this.sessionManager.getSessionByToken(sessionToken);
    if (!session) {
      console.error('Session not found:', sessionToken);
      return;
    }

    const userToken = this.sessionManager.getOAuthTokenForUser(userId);
    const channelSession = this.sessionManager.createChannelSession(channelId, sessionToken, userId, '');

    try {
      const terminal = await this.terminalManager.spawnClaudeCode(channelId, channelSession.mcpPort, userToken?.token);
      channelSession.terminalId = terminal.id;

      const tokenInfo = userToken ? `\nUsing token: \`${userToken.alias}\`` : '';
      await channel.send(
        `**Claude Code started!**\nWorking directory: \`${session.workingDirectory}\`${tokenInfo}`
      );

      console.log(`Spawned Claude Code for channel ${channelId} on MCP port ${channelSession.mcpPort}`);
    } catch (error) {
      console.error('Failed to spawn Claude Code:', error);
      this.sessionManager.removeChannelSession(channelId);
      await channel.send('Failed to start Claude Code. Please try again.');
    }
  }

  private queueMessage(channelId: string, userId: string, text: string): void {
    if (!this.messageQueues.has(channelId)) {
      this.messageQueues.set(channelId, []);
    }
    const queue = this.messageQueues.get(channelId)!;
    queue.push({ user: userId, text, timestamp: new Date() });
    if (queue.length > 100) queue.shift();
  }

  getPendingMessages(channelId: string): PendingMessage[] {
    const messages = this.messageQueues.get(channelId) || [];
    this.messageQueues.set(channelId, []);
    return messages;
  }

  async handleQueueProcess(channelId: string, message: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      if (channel) {
        const displayMessage = message.length > 100 ? message.substring(0, 97) + '...' : message;
        await channel.send(`▶️ Processing: "${displayMessage}"`);
      }
    } catch (error) {
      console.error('[DiscordBot] Error posting queue notification:', error);
    }
  }

  async handleAgentTurnComplete(channelId: string): Promise<void> {
    // Check if there's a result text that wasn't sent via MCP
    const resultText = this.terminalManager.getLatestResultText(channelId);
    if (resultText) {
      this.terminalManager.clearLatestResultText(channelId);
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && channel.isTextBased() && 'send' in channel) {
          await this.sendLongMessage(channel as TextChannel, resultText);
        }
      } catch (error) {
        console.error(`[AgentTurnComplete] Failed to send result to channel ${channelId}:`, error);
      }
    }
  }

  private async processAttachments(message: Message, channelId: string): Promise<string[]> {
    const downloadedFiles: string[] = [];
    const tmpDir = path.join(this.appDirectory, '.claude-minion', 'tmp', channelId);
    fs.mkdirSync(tmpDir, { recursive: true });

    for (const [, attachment] of message.attachments) {
      try {
        const timestamp = Date.now();
        const safeName = attachment.name?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
        const filePath = path.join(tmpDir, `${timestamp}-${safeName}`);

        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(filePath, buffer);

        console.log(`Downloaded: ${filePath} (${(buffer.length / 1024).toFixed(1)} KB)`);
        downloadedFiles.push(filePath);
      } catch (error) {
        console.error('Failed to download attachment:', error);
      }
    }

    return downloadedFiles;
  }

  // HTTP server for MCP communication
  startOrchestratorServer(port: number): void {
    this.orchestratorServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);

      if (req.method === 'GET' && url.pathname.startsWith('/messages/')) {
        const channelId = url.pathname.split('/messages/')[1];
        const messages = this.getPendingMessages(channelId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages }));
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            await this.handleMCPMessage(data);
            res.writeHead(200);
            res.end('OK');
          } catch (error) {
            console.error('Error handling MCP message:', error);
            res.writeHead(500);
            res.end('Error');
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    this.orchestratorServer.listen(port, () => {
      console.log(`Orchestrator server listening on port ${port}`);
    });
  }

  private async handleMCPMessage(data: any): Promise<void> {
    const { type, channelId, content, filename, base64Content, mentionText, requestId, approvalPort } = data;

    // Clear any pending result text since MCP is handling the response
    this.terminalManager.clearLatestResultText(channelId);

    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      if (!channel) {
        console.error(`Channel ${channelId} not found`);
        return;
      }

      const channelSession = this.sessionManager.getChannelSession(channelId);
      const userId = channelSession?.userId;

      switch (type) {
        case 'markdown':
          // Split long messages (Discord 2000 char limit)
          await this.sendLongMessage(channel, content);
          break;

        case 'file_upload':
          const fileBuffer = Buffer.from(base64Content, 'base64');
          await channel.send({
            files: [{ attachment: fileBuffer, name: filename }]
          });
          break;

        case 'mention':
          const mention = userId ? `<@${userId}>` : '';
          await this.sendLongMessage(channel, `${mention} ${mentionText || content}`);
          break;

        case 'action':
          await channel.send(`🔄 ${content}`);
          break;

        case 'result':
          await channel.send(`✅ ${content}`);
          break;

        case 'approval_request':
          const toolName = data.toolName || 'unknown';
          const channelAllowlist = this.sessionAllowlists.get(channelId);
          
          // Check if this tool is already approved for the session
          if (channelAllowlist?.has(toolName)) {
            console.log(`[Approval] Auto-approved ${toolName} for channel ${channelId} (session allowlist)`);
            try {
              await this.sendApprovalResponse(approvalPort || 3001, requestId, 'allow');
              console.log(`[Approval] Auto-approval response sent successfully for ${requestId}`);
            } catch (err) {
              console.error(`[Approval] Auto-approval response failed for ${requestId}:`, err);
              // Retry once after a short delay
              await new Promise(r => setTimeout(r, 500));
              try {
                await this.sendApprovalResponse(approvalPort || 3001, requestId, 'allow');
                console.log(`[Approval] Auto-approval retry succeeded for ${requestId}`);
              } catch (err2) {
                console.error(`[Approval] Auto-approval retry also failed:`, err2);
              }
            }
            break;
          }
          
          // Send approval message with 3-option reactions
          const approvalMsg = await channel.send(content);
          await approvalMsg.react('1️⃣');
          await approvalMsg.react('2️⃣');
          await approvalMsg.react('3️⃣');
          
          // Store pending approval with tool name for session allowlist
          this.pendingApprovals.set(approvalMsg.id, {
            messageId: approvalMsg.id,
            channelId,
            requestId,
            approvalPort: approvalPort || 3001,
            toolName,
            timestamp: Date.now(),
          });
          
          console.log(`[Approval] Posted request ${requestId} (tool: ${toolName}) as message ${approvalMsg.id}`);
          break;

        default:
          console.log('Unknown MCP message type:', type);
      }
    } catch (error) {
      console.error('Error sending to Discord:', error);
    }
  }

  private async sendLongMessage(channel: TextChannel, content: string): Promise<void> {
    const maxLength = 1990; // Leave room for code blocks etc
    
    if (content.length <= maxLength) {
      await channel.send(content);
      return;
    }

    // Split by newlines first, then by length
    const chunks: string[] = [];
    let current = '';

    for (const line of content.split('\n')) {
      if (current.length + line.length + 1 > maxLength) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current += (current ? '\n' : '') + line;
      }
    }
    if (current) chunks.push(current);

    for (const chunk of chunks) {
      await channel.send(chunk);
      await new Promise(r => setTimeout(r, 100)); // Rate limit
    }
  }

  async registerSlashCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder().setName('reset').setDescription('Reset conversation and start fresh'),
      new SlashCommandBuilder().setName('interrupt').setDescription('Stop current Claude operation (Ctrl+C)'),
      new SlashCommandBuilder().setName('compact').setDescription('Compact Claude Code conversation context'),
      new SlashCommandBuilder().setName('debug').setDescription('Show terminal output for debugging'),
      new SlashCommandBuilder().setName('context').setDescription('Display context window usage stats'),
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('Set or view the Claude model for this channel')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Model name (e.g., claude-sonnet-4-5-20250929, claude-opus-4-20250514)')
            .setRequired(false)
        ),
    ];

    const rest = new REST().setToken(this.botToken);

    try {
      console.log('Registering slash commands...');
      await rest.put(
        Routes.applicationCommands(this.client.user!.id),
        { body: commands.map(c => c.toJSON()) }
      );
      console.log('Slash commands registered!');
    } catch (error) {
      console.error('Failed to register slash commands:', error);
    }
  }

  async start(): Promise<void> {
    await this.client.login(this.botToken);
    // Register slash commands after login
    await this.registerSlashCommands();
  }

  async stop(): Promise<void> {
    this.client.destroy();
    if (this.orchestratorServer) {
      this.orchestratorServer.close();
    }
  }

  async sendDirectMessage(channelId: string, text: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel | DMChannel;
      if (channel) {
        await this.sendLongMessage(channel as TextChannel, text);
      }
    } catch (error) {
      console.error('Failed to send DM:', error);
    }
  }

  // Handle interactive prompt detected by terminal manager
  async handlePromptDetected(channelId: string, prompt: PromptInfo): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      if (!channel) {
        console.error(`[Prompt] Channel ${channelId} not found`);
        return;
      }

      // Build the prompt message
      let message = `⚠️ **${prompt.title}**\n\n`;
      
      if (prompt.type === 'binary') {
        message += `React: ✅ **Yes** or ❌ **No**`;
      } else {
        prompt.options.forEach((opt, i) => {
          message += `${NUMBER_EMOJIS[i]} ${opt}\n`;
        });
      }

      // Send message
      const promptMsg = await channel.send(message);

      // Add reactions
      if (prompt.type === 'binary') {
        await promptMsg.react('✅');
        await promptMsg.react('❌');
      } else {
        for (let i = 0; i < prompt.options.length && i < NUMBER_EMOJIS.length; i++) {
          await promptMsg.react(NUMBER_EMOJIS[i]);
        }
      }

      // Store pending prompt
      this.pendingPrompts.set(promptMsg.id, {
        messageId: promptMsg.id,
        channelId,
        options: prompt.options,
        timestamp: Date.now(),
      });

      console.log(`[Prompt] Posted prompt as message ${promptMsg.id}`);
    } catch (error) {
      console.error('[Prompt] Failed to post prompt:', error);
    }
  }

  private async sendApprovalResponse(port: number, requestId: string, response: 'allow' | 'allow_session' | 'deny'): Promise<void> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ requestId, response });
      
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port,
        path: '/approval-response',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = http.request(options, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}
