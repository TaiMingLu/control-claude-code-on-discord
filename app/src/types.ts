export interface Session {
  token: string;
  userId: string;
  dmChannelId: string;
  createdAt: Date;
  workingDirectory: string;
}

// OAuth token with alias for multi-token support
export interface OAuthToken {
  alias: string;           // User-friendly name (e.g., "work", "personal")
  token: string;           // The actual OAuth token
  isDefault?: boolean;     // Whether this is the default token
}

// Per-user settings stored persistently
export interface UserSettings {
  userId: string;
  selectedTokenAlias: string;  // Which token alias the user has selected
  updatedAt: Date;
}

export interface ChannelSession {
  channelId: string;
  sessionToken: string;
  userId: string;
  terminalId: string;
  mcpPort: number;
  createdAt: Date;
}

export interface TerminalInstance {
  id: string;
  channelId: string;
  pty: any; // node-pty IPty
  mcpPort: number;
  lastActivity: Date;
}

export interface MCPMessage {
  type: 'markdown' | 'file' | 'mention';
  channelId: string;
  content?: string;
  filename?: string;
  fileContent?: string;
  mentionUser?: boolean;
  mentionText?: string;
}

// Interactive prompt detected in terminal output
export interface PromptInfo {
  type: 'binary' | 'menu';
  title: string;
  options: string[];
  raw: string;
}
