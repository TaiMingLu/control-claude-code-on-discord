import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { TerminalInstance, PromptInfo } from './types.js';
import * as path from 'path';
import * as fs from 'fs';

// Dynamic import for strip-ansi (ESM module)
let stripAnsi: (text: string) => string;

async function initStripAnsi() {
  const module = await import('strip-ansi');
  stripAnsi = module.default;
}

initStripAnsi();

interface QueuedMessage {
  input: string;
  resolve: (success: boolean) => void;
  oauthToken?: string;  // Store token at queue time so it's used when processed
}

export class TerminalManager {
  private terminals: Map<string, TerminalInstance> = new Map();
  private outputBuffers: Map<string, string[]> = new Map();
  private workingDirectory: string;
  private appDirectory: string;
  private mcpConfigs: Map<string, string> = new Map(); // channelId -> mcpConfigPath
  private sessionIds: Map<string, string> = new Map(); // channelId -> claude session UUID
  private sessionIdsFilePath: string; // Path to persist session IDs
  private busyChannels: Set<string> = new Set(); // channels with running claude commands
  private messageQueues: Map<string, QueuedMessage[]> = new Map(); // channelId -> queued messages
  private awaitingSessionId: Set<string> = new Set(); // channels waiting to capture session_id from JSON output
  private latestUsageStats: Map<string, any> = new Map(); // channelId -> latest usage stats from JSON output
  private latestResultText: Map<string, string> = new Map(); // channelId -> latest result text from JSON output
  // (removed interactive mode fields)
  private channelModels: Map<string, string> = new Map(); // channelId -> model override
  private pendingPrompts: Map<string, { terminalId: string; options: string[] }> = new Map(); // channelId -> pending prompt
  private promptCallback?: (channelId: string, prompt: PromptInfo) => Promise<void>;
  private onQueueProcessCallback?: (channelId: string, message: string) => Promise<void>;
  private onAgentTurnCompleteCallback?: (channelId: string) => Promise<void>;

  constructor(
    workingDirectory: string,
    appDirectory: string,
    onQueueProcess?: (channelId: string, message: string) => Promise<void>,
    onAgentTurnComplete?: (channelId: string) => Promise<void>,
    onPromptDetected?: (channelId: string, prompt: PromptInfo) => Promise<void>
  ) {
    this.workingDirectory = workingDirectory;
    this.appDirectory = appDirectory;
    this.sessionIdsFilePath = path.join(workingDirectory, '.minion-claude-sessions.json');
    this.onQueueProcessCallback = onQueueProcess;
    this.onAgentTurnCompleteCallback = onAgentTurnComplete;
    this.promptCallback = onPromptDetected;
    this.loadSessionIds();
  }

  // Load persisted session IDs from disk
  private loadSessionIds(): void {
    try {
      if (fs.existsSync(this.sessionIdsFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.sessionIdsFilePath, 'utf-8'));
        for (const [channelId, sessionId] of Object.entries(data)) {
          this.sessionIds.set(channelId, sessionId as string);
        }
        console.log(`[SessionIds] Loaded ${this.sessionIds.size} persisted Claude session IDs`);
      }
    } catch (error) {
      console.error('[SessionIds] Error loading session IDs:', error);
    }
  }

  // Save session IDs to disk
  private saveSessionIds(): void {
    try {
      const data: Record<string, string> = {};
      this.sessionIds.forEach((v, k) => data[k] = v);
      fs.writeFileSync(this.sessionIdsFilePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('[SessionIds] Error saving session IDs:', error);
    }
  }

  async spawnClaudeCode(channelId: string, mcpPort: number, oauthToken?: string): Promise<TerminalInstance> {
    const id = uuidv4();

    // Create MCP config for this instance (stored in app directory)
    const mcpConfigDir = path.join(this.appDirectory, '.claude-minion', channelId);
    fs.mkdirSync(mcpConfigDir, { recursive: true });

    const mcpConfigPath = path.join(mcpConfigDir, 'mcp-config.json');
    // Each channel gets a unique approval port (base 3001 + offset based on channel count)
    const approvalPort = 3001 + (this.terminals.size % 100);
    
    const mcpConfig = {
      mcpServers: {
        'discord-messenger': {
          command: 'node',
          args: [path.join(this.appDirectory, 'dist', 'mcp-server.js')],
          env: {
            MCP_PORT: mcpPort.toString(),
            CHANNEL_ID: channelId,
            ORCHESTRATOR_URL: `http://localhost:${process.env.ORCHESTRATOR_PORT || 3000}`,
          },
        },
        'discord-approval': {
          command: 'node',
          args: [path.join(this.appDirectory, 'dist', 'approval-server.js')],
          env: {
            CHANNEL_ID: channelId,
            ORCHESTRATOR_URL: `http://localhost:${process.env.ORCHESTRATOR_PORT || 3000}`,
            APPROVAL_PORT: approvalPort.toString(),
            APPROVAL_TIMEOUT_MS: '300000', // 5 minutes
          },
        },
      },
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Store MCP config path for this channel
    this.mcpConfigs.set(channelId, mcpConfigPath);
    // Session ID will be captured from first command's JSON output

    // Spawn a shell for running claude commands
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';

    // Build environment with optional OAuth token override
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      TERM: 'xterm-256color',
      MCP_PORT: mcpPort.toString(),
      CHANNEL_ID: channelId,
    };

    // If a specific OAuth token is provided, use it instead of the inherited one
    if (oauthToken) {
      spawnEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      console.log(`[Terminal ${channelId}] Using specific OAuth token (${oauthToken.substring(0, 15)}...)`);
    }

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: this.workingDirectory,
      env: spawnEnv,
    });

    const terminal: TerminalInstance = {
      id,
      channelId,
      pty: ptyProcess,
      mcpPort,
      lastActivity: new Date(),
    };

    this.terminals.set(id, terminal);
    this.outputBuffers.set(id, []);

    // Collect output and log for debugging
    ptyProcess.onData((data: string) => {
      const buffer = this.outputBuffers.get(id);
      if (buffer) {
        buffer.push(data);
        // Keep only last 1000 lines
        if (buffer.length > 1000) {
          buffer.shift();
        }
      }
      terminal.lastActivity = new Date();
      // Debug: log terminal output
      const cleanData = stripAnsi ? stripAnsi(data) : data;
      if (cleanData.trim()) {
        console.log(`[Terminal ${channelId}] ${cleanData}`);
      }

      // Extract session_id from output
      if (this.awaitingSessionId.has(channelId)) {
        // JSON format: "session_id": "uuid"
        const jsonSessionMatch = cleanData.match(/"session_id"\s*:\s*"([^"]+)"/);
        // Interactive format: session ID might appear as UUID pattern in startup output
        const uuidMatch = cleanData.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        const sessionMatch = jsonSessionMatch || uuidMatch;
        if (sessionMatch) {
          const extractedSessionId = sessionMatch[1];
          this.sessionIds.set(channelId, extractedSessionId);
          this.awaitingSessionId.delete(channelId);
          this.saveSessionIds(); // Persist to disk for restart recovery
          console.log(`[Session] Captured session ID for channel ${channelId}: ${extractedSessionId.substring(0, 8)}...`);
        }
      }

      // Extract usage stats from JSON result
      // Look for {"type":"result"...} and parse it
      const resultStart = cleanData.indexOf('{"type":"result"');
      if (resultStart !== -1) {
        // Find matching closing brace
        let braceCount = 0;
        let endIdx = -1;
        for (let i = resultStart; i < cleanData.length; i++) {
          if (cleanData[i] === '{') braceCount++;
          if (cleanData[i] === '}') braceCount--;
          if (braceCount === 0) {
            endIdx = i + 1;
            break;
          }
        }
        if (endIdx !== -1) {
          try {
            const resultJson = JSON.parse(cleanData.substring(resultStart, endIdx));
            if (resultJson.usage) {
              this.latestUsageStats.set(channelId, resultJson.usage);
              console.log(`[Usage] Captured usage stats for channel ${channelId}`);
            }
            if (resultJson.result) {
              this.latestResultText.set(channelId, resultJson.result);
            }
          } catch (e) {
            // JSON not complete yet, ignore
          }
        }
      }

      // Detect interactive prompts in terminal output
      this.detectPrompts(channelId, cleanData, id);

      // Detect when Claude command finishes using sentinel marker
      if (this.busyChannels.has(channelId)) {
        const lines = cleanData.split('\n');
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine === '___CLAUDE_DONE___') {
            this.busyChannels.delete(channelId);
            console.log(`[Terminal ${channelId}] Claude command finished`);

            if (this.onAgentTurnCompleteCallback) {
              this.onAgentTurnCompleteCallback(channelId).catch(err => {
                console.error('[AgentTurnComplete] Error in callback:', err);
              });
            }

            this.processQueue(channelId);
            break;
          }
        }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`Terminal ${id} exited with code ${exitCode}`);
      this.terminals.delete(id);
      this.outputBuffers.delete(id);
    });

    // Wait a moment for shell to initialize
    await new Promise(resolve => setTimeout(resolve, 500));

    return terminal;
  }

  // Queue a message to be sent to Claude (handles busy state)
  // oauthToken: Optional OAuth token to use for this command (enables dynamic token switching)
  async sendInput(terminalId: string, input: string, oauthToken?: string): Promise<boolean> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      console.error(`Terminal ${terminalId} not found`);
      return false;
    }

    const channelId = terminal.channelId;

    // If channel is busy, queue the message
    if (this.busyChannels.has(channelId)) {
      console.log(`[Queue] Channel ${channelId} is busy, queuing message`);
      return new Promise((resolve) => {
        const queue = this.messageQueues.get(channelId) || [];
        queue.push({ input, resolve, oauthToken });  // Store token with queued message
        this.messageQueues.set(channelId, queue);
      });
    }

    // Send immediately
    return this.sendInputNow(terminalId, input, oauthToken);
  }

  // Actually send input to Claude (internal method)
  // In interactive mode: first call launches `claude` process, subsequent calls type into the existing prompt
  private sendInputNow(terminalId: string, input: string, oauthToken?: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      console.error(`Terminal ${terminalId} not found`);
      return false;
    }

    const channelId = terminal.channelId;
    const mcpConfigPath = this.mcpConfigs.get(channelId);
    if (!mcpConfigPath) {
      console.error(`MCP config not found for channel ${channelId}`);
      return false;
    }

    // Mark channel as busy
    this.busyChannels.add(channelId);

    // Escape the input for shell
    const escapedInput = input
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/\n/g, ' ')
      .replace(/\r/g, '');

    const existingSessionId = this.sessionIds.get(channelId);
    const model = this.channelModels.get(channelId) || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
    const tokenPrefix = oauthToken ? `CLAUDE_CODE_OAUTH_TOKEN="${oauthToken}" ` : '';

    // Pre-approved read-only tools (comma-separated in single string)
    const allowedToolsList = [
      'Read',
      'Bash(ls *)', 'Bash(cat *)', 'Bash(find *)', 'Bash(head *)', 'Bash(tail *)',
      'Bash(grep *)', 'Bash(wc *)', 'Bash(file *)', 'Bash(pwd)', 'Bash(which *)',
      'Bash(tree *)', 'Bash(du *)', 'Bash(df *)', 'Bash(echo *)', 'Bash(stat *)',
      'Bash(realpath *)', 'Bash(dirname *)', 'Bash(basename *)',
      'Bash(git log *)', 'Bash(git diff *)', 'Bash(git status *)', 'Bash(git show *)',
      'Bash(git branch *)', 'Bash(squeue *)', 'Bash(sinfo *)', 'Bash(sacct *)',
    ].join(',');
    const allowedTools = `"${allowedToolsList}"`;

    const permissionTool = '--permission-prompt-tool mcp__discord-approval__tool-approval';

    let claudeCmd: string;
    if (existingSessionId) {
      claudeCmd = `${tokenPrefix}claude -p "${escapedInput}" --model ${model} --output-format json --allowedTools ${allowedTools} ${permissionTool} --resume "${existingSessionId}" --mcp-config "${mcpConfigPath}" ; echo "___CLAUDE_DONE___"`;
      console.log(`[Sending to Claude] claude -p "..." --model ${model} --resume "${existingSessionId.substring(0, 8)}..."`);
    } else {
      claudeCmd = `${tokenPrefix}claude -p "${escapedInput}" --model ${model} --output-format json --allowedTools ${allowedTools} ${permissionTool} --mcp-config "${mcpConfigPath}" ; echo "___CLAUDE_DONE___"`;
      this.awaitingSessionId.add(channelId);
      console.log(`[Sending to Claude] claude -p "..." --model ${model} (new conversation)`);
    }

    terminal.pty.write(claudeCmd + '\r');
    terminal.lastActivity = new Date();
    return true;
  }

  // Process next message in the queue for a channel
  private processQueue(channelId: string): void {
    const queue = this.messageQueues.get(channelId);
    if (!queue || queue.length === 0) {
      return;
    }

    const terminal = this.getTerminalByChannelId(channelId);
    if (!terminal) {
      // Clear queue if terminal is gone
      this.messageQueues.delete(channelId);
      return;
    }

    const next = queue.shift()!;
    console.log(`[Queue] Processing next message for channel ${channelId}`);

    // Notify via callback that we're processing this message
    if (this.onQueueProcessCallback) {
      this.onQueueProcessCallback(channelId, next.input).catch(err => {
        console.error('[Queue] Error in callback:', err);
      });
    }

    // Pass the stored OAuth token (from when message was queued)
    const success = this.sendInputNow(terminal.id, next.input, next.oauthToken);
    next.resolve(success);
  }

  // Check if channel is currently processing a command
  isChannelBusy(channelId: string): boolean {
    return this.busyChannels.has(channelId);
  }

  // Get queue length for a channel
  getQueueLength(channelId: string): number {
    return this.messageQueues.get(channelId)?.length || 0;
  }

  sendRawInput(terminalId: string, input: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      console.error(`Terminal ${terminalId} not found`);
      return false;
    }

    terminal.pty.write(input);
    terminal.lastActivity = new Date();
    return true;
  }

  // Send interrupt (Ctrl+C) to stop current claude command
  sendInterrupt(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      console.error(`Terminal ${terminalId} not found`);
      return false;
    }

    // Send Ctrl+C
    terminal.pty.write('\x03');
    terminal.lastActivity = new Date();
    return true;
  }

  getOutput(terminalId: string, lines: number = 50): string[] {
    const buffer = this.outputBuffers.get(terminalId);
    if (!buffer) {
      return [];
    }

    const result = buffer.slice(-lines);
    // Strip ANSI codes for cleaner output
    return result.map(line => stripAnsi ? stripAnsi(line) : line);
  }

  getTerminal(terminalId: string): TerminalInstance | undefined {
    return this.terminals.get(terminalId);
  }

  getTerminalByChannelId(channelId: string): TerminalInstance | undefined {
    for (const terminal of this.terminals.values()) {
      if (terminal.channelId === channelId) {
        return terminal;
      }
    }
    return undefined;
  }

  killTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return false;
    }

    terminal.pty.kill();
    this.terminals.delete(terminalId);
    this.outputBuffers.delete(terminalId);
    return true;
  }

  killByChannelId(channelId: string): boolean {
    const terminal = this.getTerminalByChannelId(channelId);
    if (terminal) {
      return this.killTerminal(terminal.id);
    }
    return false;
  }

  getAllTerminals(): TerminalInstance[] {
    return Array.from(this.terminals.values());
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return false;
    }

    terminal.pty.resize(cols, rows);
    return true;
  }

  // Reset conversation for a channel (clears session so next message starts fresh)
  resetConversation(channelId: string): void {
    this.sessionIds.delete(channelId);
    this.awaitingSessionId.delete(channelId);
    this.saveSessionIds();
    this.busyChannels.delete(channelId);
    this.messageQueues.delete(channelId);
    console.log(`[Reset] Cleared session for channel ${channelId}, next message will start new conversation`);
  }

  // Clear busy state for a channel (call after interrupt)
  clearBusyState(channelId: string): void {
    this.busyChannels.delete(channelId);
    // Also clear message queue since queued messages are likely no longer relevant
    const queueLength = this.messageQueues.get(channelId)?.length || 0;
    this.messageQueues.delete(channelId);
    console.log(`[Interrupt] Cleared busy state for channel ${channelId}, dropped ${queueLength} queued message(s)`);
  }

  // Get session ID for a channel
  getSessionId(channelId: string): string | undefined {
    return this.sessionIds.get(channelId);
  }

  // Get MCP config path for a channel
  getMcpConfigPath(channelId: string): string | undefined {
    return this.mcpConfigs.get(channelId);
  }

  // Get latest usage stats for a channel
  getLatestUsageStats(channelId: string): any | undefined {
    return this.latestUsageStats.get(channelId);
  }

  getLatestResultText(channelId: string): string | undefined {
    return this.latestResultText.get(channelId);
  }

  clearLatestResultText(channelId: string): void {
    this.latestResultText.delete(channelId);
  }

  // Set model for a channel
  setChannelModel(channelId: string, model: string): void {
    this.channelModels.set(channelId, model);
    console.log(`[Model] Set model for channel ${channelId}: ${model}`);
  }

  // Get model for a channel
  getChannelModel(channelId: string): string {
    return this.channelModels.get(channelId) || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
  }

  // Clear model override for a channel (use default)
  clearChannelModel(channelId: string): void {
    this.channelModels.delete(channelId);
    console.log(`[Model] Cleared model override for channel ${channelId}, using default`);
  }

  // Detect interactive prompts in terminal output
  private detectPrompts(channelId: string, output: string, terminalId: string): void {
    // Skip if we already have a pending prompt for this channel
    if (this.pendingPrompts.has(channelId)) return;

    // Pattern 1: Menu with numbered options (❯ indicates current selection)
    // Example:
    //   Do you want to make this edit?
    //   ❯ 1. Yes
    //     2. Yes, allow all edits
    //     3. No
    const menuMatch = output.match(/([^\n]+\?)\s*\n((?:\s*[❯>]?\s*\d+\.\s*[^\n]+\n?)+)/);
    if (menuMatch) {
      const title = menuMatch[1].trim();
      const optionsBlock = menuMatch[2];
      const options = optionsBlock
        .split('\n')
        .map(line => line.replace(/^\s*[❯>]?\s*\d+\.\s*/, '').trim())
        .filter(opt => opt.length > 0);
      
      if (options.length >= 2) {
        console.log(`[Prompt] Detected menu prompt: "${title}" with ${options.length} options`);
        this.pendingPrompts.set(channelId, { terminalId, options });
        
        if (this.promptCallback) {
          this.promptCallback(channelId, {
            type: 'menu',
            title,
            options,
            raw: menuMatch[0],
          });
        }
        return;
      }
    }

    // Pattern 2: Binary yes/no prompts
    // Example: "Do you want to proceed? (y/n)" or "Trust this folder? [Y/n]"
    const binaryMatch = output.match(/([^\n]*\?)\s*[\[(]([yYnN])\/([yYnN])[\])]/);
    if (binaryMatch) {
      const title = binaryMatch[1].trim();
      const options = ['Yes', 'No'];
      
      console.log(`[Prompt] Detected binary prompt: "${title}"`);
      this.pendingPrompts.set(channelId, { terminalId, options });
      
      if (this.promptCallback) {
        this.promptCallback(channelId, {
          type: 'binary',
          title,
          options,
          raw: binaryMatch[0],
        });
      }
      return;
    }

    // Pattern 3: Trust folder prompt (specific to Claude Code)
    if (output.includes('trust this folder') || output.includes('Trust this folder')) {
      const titleMatch = output.match(/([^\n]*[Tt]rust this folder[^\n]*)/);
      const title = titleMatch ? titleMatch[1].trim() : 'Trust this folder?';
      
      // Check if it has numbered options
      const hasOptions = output.match(/\d+\.\s*(Yes|No)/i);
      const options = hasOptions ? ['Yes, trust this folder', 'No, exit'] : ['Yes', 'No'];
      
      console.log(`[Prompt] Detected trust prompt: "${title}"`);
      this.pendingPrompts.set(channelId, { terminalId, options });
      
      if (this.promptCallback) {
        this.promptCallback(channelId, {
          type: hasOptions ? 'menu' : 'binary',
          title,
          options,
          raw: output,
        });
      }
      return;
    }
  }

  // Send response to a pending prompt
  sendPromptResponse(channelId: string, optionIndex: number): boolean {
    const pending = this.pendingPrompts.get(channelId);
    if (!pending) {
      console.error(`[Prompt] No pending prompt for channel ${channelId}`);
      return false;
    }

    const terminal = this.terminals.get(pending.terminalId);
    if (!terminal) {
      console.error(`[Prompt] Terminal ${pending.terminalId} not found`);
      this.pendingPrompts.delete(channelId);
      return false;
    }

    // Send the appropriate keystroke
    if (pending.options.length === 2 && optionIndex < 2) {
      const key = optionIndex === 0 ? 'y' : 'n';
      terminal.pty.write(key + '\r');
      console.log(`[Prompt] Sent '${key}' for binary prompt`);
    } else {
      const num = (optionIndex + 1).toString();
      terminal.pty.write(num + '\r');
      console.log(`[Prompt] Sent '${num}' for menu prompt`);
    }

    this.pendingPrompts.delete(channelId);
    return true;
  }

  // Check if channel has a pending prompt
  hasPendingPrompt(channelId: string): boolean {
    return this.pendingPrompts.has(channelId);
  }

  // Send input with JSON output format and return the parsed result
  async sendInputWithJsonOutput(terminalId: string, input: string): Promise<any> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`);
    }

    const channelId = terminal.channelId;
    const mcpConfigPath = this.mcpConfigs.get(channelId);
    if (!mcpConfigPath) {
      throw new Error(`MCP config not found for channel ${channelId}`);
    }

    // Escape the input for shell
    const escapedInput = input
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/\n/g, ' ')
      .replace(/\r/g, '');

    const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
    const existingSessionId = this.sessionIds.get(channelId);

    // Build command with --output-format json
    let claudeCmd: string;
    if (existingSessionId) {
      claudeCmd = `claude -p "${escapedInput}" --model ${model} --output-format json --resume "${existingSessionId}" --mcp-config "${mcpConfigPath}" ; echo "___CLAUDE_DONE___"`;
    } else {
      claudeCmd = `claude -p "${escapedInput}" --model ${model} --output-format json --mcp-config "${mcpConfigPath}" ; echo "___CLAUDE_DONE___"`;
    }

    console.log(`[/context] Sending: claude -p "..." --model ${model} --output-format json${existingSessionId ? ` --resume "${existingSessionId.substring(0, 8)}..."` : ''}`);

    // Mark channel as busy
    this.busyChannels.add(channelId);

    return new Promise((resolve, reject) => {
      let output = '';
      let resolved = false;
      let sawDoneMarker = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.busyChannels.delete(channelId);
          reject(new Error('Timeout waiting for response'));
        }
      }, 60000); // 1 minute timeout

      const tryParseResult = () => {
        // Find the result JSON object - it starts with {"type":"result" and ends with }
        const startIdx = output.indexOf('{"type":"result"');
        if (startIdx === -1) return null;

        // Find the matching closing brace by counting braces
        let braceCount = 0;
        let endIdx = -1;
        for (let i = startIdx; i < output.length; i++) {
          if (output[i] === '{') braceCount++;
          if (output[i] === '}') braceCount--;
          if (braceCount === 0) {
            endIdx = i + 1;
            break;
          }
        }

        if (endIdx === -1) return null;

        try {
          const jsonStr = output.substring(startIdx, endIdx);
          const result = JSON.parse(jsonStr);
          return result;
        } catch (e) {
          // Not valid JSON yet
          return null;
        }
      };

      const dataHandler = (data: string) => {
        output += data;

        // Check for completion marker
        if (output.includes('___CLAUDE_DONE___') && !sawDoneMarker) {
          sawDoneMarker = true;
          // Wait a bit for all output to arrive, then parse
          setTimeout(() => {
            if (!resolved) {
              const result = tryParseResult();
              if (result) {
                resolved = true;
                clearTimeout(timeout);
                this.busyChannels.delete(channelId);
                resolve(result);
              } else {
                // Keep waiting for more data, will be handled by subsequent data events
              }
            }
          }, 500);
        }

        // Also try to parse on each data event after done marker (in case JSON comes in chunks)
        if (sawDoneMarker && !resolved) {
          const result = tryParseResult();
          if (result) {
            resolved = true;
            clearTimeout(timeout);
            this.busyChannels.delete(channelId);
            resolve(result);
          }
        }
      };

      // Listen for data
      terminal.pty.onData(dataHandler);

      // Send the command
      terminal.pty.write(claudeCmd + '\r');
      terminal.lastActivity = new Date();
    });
  }
}
