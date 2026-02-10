import { v4 as uuidv4 } from 'uuid';
import { Session, ChannelSession, OAuthToken, UserSettings } from './types.js';
import * as fs from 'fs';
import * as path from 'path';

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private channelSessions: Map<string, ChannelSession> = new Map();
  private userSettings: Map<string, UserSettings> = new Map();  // userId -> settings
  private oauthTokens: OAuthToken[] = [];
  private sessionFilePath: string;
  private channelSessionFilePath: string;
  private userSettingsFilePath: string;
  private nextMcpPort: number = 9100;

  constructor(dataDir: string = '.', oauthTokens: OAuthToken[] = []) {
    this.sessionFilePath = path.join(dataDir, '.minion-sessions.json');
    this.channelSessionFilePath = path.join(dataDir, '.minion-channel-sessions.json');
    this.userSettingsFilePath = path.join(dataDir, '.minion-user-settings.json');
    this.oauthTokens = oauthTokens;
    this.loadSessions();
    this.loadUserSettings();
  }

  private loadSessions(): void {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf-8'));
        for (const [key, value] of Object.entries(data)) {
          const session = value as Session;
          session.createdAt = new Date(session.createdAt);
          this.sessions.set(key, session);
        }
      }
      if (fs.existsSync(this.channelSessionFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.channelSessionFilePath, 'utf-8'));
        for (const [key, value] of Object.entries(data)) {
          const session = value as ChannelSession;
          session.createdAt = new Date(session.createdAt);
          this.channelSessions.set(key, session);
          // Track highest MCP port
          if (session.mcpPort >= this.nextMcpPort) {
            this.nextMcpPort = session.mcpPort + 1;
          }
        }
      }
    } catch (error) {
      console.error('Error loading sessions:', error);
    }
  }

  private saveSessions(): void {
    try {
      const sessionsObj: Record<string, Session> = {};
      this.sessions.forEach((v, k) => sessionsObj[k] = v);
      fs.writeFileSync(this.sessionFilePath, JSON.stringify(sessionsObj, null, 2));

      const channelSessionsObj: Record<string, ChannelSession> = {};
      this.channelSessions.forEach((v, k) => channelSessionsObj[k] = v);
      fs.writeFileSync(this.channelSessionFilePath, JSON.stringify(channelSessionsObj, null, 2));
    } catch (error) {
      console.error('Error saving sessions:', error);
    }
  }

  private loadUserSettings(): void {
    try {
      if (fs.existsSync(this.userSettingsFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.userSettingsFilePath, 'utf-8'));
        for (const [key, value] of Object.entries(data)) {
          const settings = value as UserSettings;
          settings.updatedAt = new Date(settings.updatedAt);
          this.userSettings.set(key, settings);
        }
        console.log(`Loaded ${this.userSettings.size} user settings`);
      }
    } catch (error) {
      console.error('Error loading user settings:', error);
    }
  }

  private saveUserSettings(): void {
    try {
      const settingsObj: Record<string, UserSettings> = {};
      this.userSettings.forEach((v, k) => settingsObj[k] = v);
      fs.writeFileSync(this.userSettingsFilePath, JSON.stringify(settingsObj, null, 2));
    } catch (error) {
      console.error('Error saving user settings:', error);
    }
  }

  // Get all available OAuth tokens
  getOAuthTokens(): OAuthToken[] {
    return this.oauthTokens;
  }

  // Get the OAuth token for a specific user (based on their selection or default)
  getOAuthTokenForUser(userId: string): OAuthToken | undefined {
    // If no tokens configured, return undefined
    if (this.oauthTokens.length === 0) {
      return undefined;
    }

    // Check if user has a preference
    const settings = this.userSettings.get(userId);
    if (settings?.selectedTokenAlias) {
      const selectedToken = this.oauthTokens.find(t => t.alias === settings.selectedTokenAlias);
      if (selectedToken) {
        return selectedToken;
      }
    }

    // Return default token
    const defaultToken = this.oauthTokens.find(t => t.isDefault);
    return defaultToken || this.oauthTokens[0];
  }

  // Set the user's preferred OAuth token
  setUserTokenPreference(userId: string, alias: string): boolean {
    // Verify the alias exists
    const token = this.oauthTokens.find(t => t.alias === alias);
    if (!token) {
      return false;
    }

    const settings: UserSettings = {
      userId,
      selectedTokenAlias: alias,
      updatedAt: new Date(),
    };
    this.userSettings.set(userId, settings);
    this.saveUserSettings();
    console.log(`[UserSettings] User ${userId} selected token alias: ${alias}`);
    return true;
  }

  // Get user settings
  getUserSettings(userId: string): UserSettings | undefined {
    return this.userSettings.get(userId);
  }

  createSession(userId: string, dmChannelId: string, workingDirectory: string): Session {
    const token = uuidv4().substring(0, 8).toUpperCase();
    const session: Session = {
      token,
      userId,
      dmChannelId,
      createdAt: new Date(),
      workingDirectory,
    };
    this.sessions.set(token, session);
    this.saveSessions();
    return session;
  }

  getSessionByToken(token: string): Session | undefined {
    return this.sessions.get(token.toUpperCase());
  }

  getSessionByUserId(userId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        return session;
      }
    }
    return undefined;
  }

  updateSessionUser(token: string, userId: string, dmChannelId: string): boolean {
    const session = this.sessions.get(token.toUpperCase());
    if (session) {
      session.userId = userId;
      session.dmChannelId = dmChannelId;
      this.saveSessions();
      return true;
    }
    return false;
  }

  createChannelSession(
    channelId: string,
    sessionToken: string,
    userId: string,
    terminalId: string
  ): ChannelSession {
    const mcpPort = this.nextMcpPort++;
    const channelSession: ChannelSession = {
      channelId,
      sessionToken,
      userId,
      terminalId,
      mcpPort,
      createdAt: new Date(),
    };
    this.channelSessions.set(channelId, channelSession);
    this.saveSessions();
    return channelSession;
  }

  getChannelSession(channelId: string): ChannelSession | undefined {
    return this.channelSessions.get(channelId);
  }

  removeChannelSession(channelId: string): void {
    this.channelSessions.delete(channelId);
    this.saveSessions();
  }

  getAllChannelSessions(): ChannelSession[] {
    return Array.from(this.channelSessions.values());
  }

  getChannelIdByMcpPort(port: number): string | undefined {
    for (const session of this.channelSessions.values()) {
      if (session.mcpPort === port) {
        return session.channelId;
      }
    }
    return undefined;
  }

  getUserIdByChannelId(channelId: string): string | undefined {
    const session = this.channelSessions.get(channelId);
    return session?.userId;
  }
}
