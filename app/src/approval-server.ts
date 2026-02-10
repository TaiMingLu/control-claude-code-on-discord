#!/usr/bin/env node

/**
 * Discord-based permission approval MCP server for Claude Code.
 * 
 * When Claude needs permission to run a tool, it calls this MCP server.
 * The server posts to Discord with 3 options:
 *   1️⃣ Yes (allow once)
 *   2️⃣ Yes, allow for this session (auto-approve same tool type going forward)
 *   3️⃣ No (deny)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as http from 'http';

// Configuration from environment
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';
const CHANNEL_ID = process.env.CHANNEL_ID || '';
const APPROVAL_TIMEOUT_MS = parseInt(process.env.APPROVAL_TIMEOUT_MS || '300000', 10);

if (!CHANNEL_ID) {
  console.error('CHANNEL_ID environment variable is required');
  process.exit(1);
}

// Session-level allowlist: tool names that have been approved for the session
const sessionAllowlist: Set<string> = new Set();

// Pending approvals waiting for user response
interface PendingApproval {
  resolve: (response: 'allow' | 'allow_session' | 'deny') => void;
  messageId?: string;
  timestamp: number;
}

const pendingApprovals = new Map<string, PendingApproval>();

// HTTP server to receive approval responses from Discord bot
let approvalServer: http.Server | null = null;

function startApprovalServer(port: number): void {
  approvalServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/approval-response') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { requestId, response } = data;
          // Support legacy { approved: true/false } format
          const resolvedResponse = data.response || (data.approved ? 'allow' : 'deny');
          
          const pending = pendingApprovals.get(requestId);
          if (pending) {
            pending.resolve(resolvedResponse);
            pendingApprovals.delete(requestId);
            console.error(`[Approval] Received ${resolvedResponse} for ${requestId}`);
          }
          
          res.writeHead(200);
          res.end('OK');
        } catch (error) {
          res.writeHead(400);
          res.end('Invalid JSON');
        }
      });
      return;
    }
    
    res.writeHead(404);
    res.end('Not found');
  });
  
  approvalServer.listen(port, '127.0.0.1', () => {
    console.error(`[Approval] Server listening on port ${port}`);
  });
}

async function sendToOrchestrator(data: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(ORCHESTRATOR_URL);
    const postData = JSON.stringify({ ...data, channelId: CHANNEL_ID });

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(responseData));
          } catch {
            resolve({ ok: true });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function generateRequestId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function formatToolInput(input: unknown): string {
  if (typeof input === 'string') {
    return input.length > 500 ? input.substring(0, 500) + '...' : input;
  }
  const str = JSON.stringify(input, null, 2);
  return str.length > 500 ? str.substring(0, 500) + '...' : str;
}

// Create MCP server
const server = new McpServer({
  name: 'discord-approval',
  version: '1.0.0',
});

// Tool: Request approval for a dangerous operation
server.tool(
  'tool-approval',
  'Request user approval for a tool operation via Discord.',
  {
    tool_name: z.string().describe('Name of the tool requiring approval'),
    input: z.unknown().describe('Parameters being passed to the tool'),
  },
  async ({ tool_name, input }) => {
    // Check session allowlist first
    if (sessionAllowlist.has(tool_name)) {
      console.error(`[Approval] Auto-approved ${tool_name} (session allowlist)`);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ behavior: 'allow', updatedInput: input }),
        }],
      };
    }

    const requestId = generateRequestId();
    console.error(`[Approval] Request ${requestId}: ${tool_name}`);
    
    const formattedInput = formatToolInput(input);
    const message = `⚠️ **Permission Request** (ID: \`${requestId}\`)\n\n` +
      `**Tool:** \`${tool_name}\`\n` +
      `**Input:**\n\`\`\`\n${formattedInput}\n\`\`\`\n\n` +
      `1️⃣ **Yes** (allow once)\n` +
      `2️⃣ **Yes, allow for this session**\n` +
      `3️⃣ **No** (deny)`;
    
    const approvalPort = parseInt(process.env.APPROVAL_PORT || '3001', 10);
    
    try {
      // IMPORTANT: Register the pending approval BEFORE sending to orchestrator
      // to avoid race condition where bot auto-approves before the promise is set up
      const responsePromise = new Promise<'allow' | 'allow_session' | 'deny'>((resolve) => {
        pendingApprovals.set(requestId, {
          resolve,
          timestamp: Date.now(),
        });
        
        setTimeout(() => {
          if (pendingApprovals.has(requestId)) {
            pendingApprovals.delete(requestId);
            console.error(`[Approval] Request ${requestId} timed out`);
            resolve('deny');
          }
        }, APPROVAL_TIMEOUT_MS);
      });

      await sendToOrchestrator({
        type: 'approval_request',
        requestId,
        content: message,
        approvalPort,
        toolName: tool_name,
      });
      
      const response = await responsePromise;
      
      if (response === 'allow' || response === 'allow_session') {
        if (response === 'allow_session') {
          sessionAllowlist.add(tool_name);
          console.error(`[Approval] Added ${tool_name} to session allowlist`);
        }
        console.error(`[Approval] Request ${requestId} APPROVED (${response})`);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ behavior: 'allow', updatedInput: input }),
          }],
        };
      } else {
        console.error(`[Approval] Request ${requestId} DENIED`);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ behavior: 'deny', message: 'User rejected the operation via Discord' }),
          }],
        };
      }
    } catch (error) {
      console.error(`[Approval] Error:`, error);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ behavior: 'deny', message: `Approval request failed: ${error}` }),
        }],
        isError: true,
      };
    }
  }
);

async function main() {
  const approvalPort = parseInt(process.env.APPROVAL_PORT || '3001', 10);
  startApprovalServer(approvalPort);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[Approval] Discord Approval MCP server running for channel ${CHANNEL_ID}`);
  console.error(`[Approval] Session allowlist enabled — "allow for session" will auto-approve future same-tool requests`);
}

main().catch((error) => {
  console.error('Failed to start approval server:', error);
  process.exit(1);
});
