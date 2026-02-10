#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// Get configuration from environment
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';
const CHANNEL_ID = process.env.CHANNEL_ID || '';

if (!CHANNEL_ID) {
  console.error('CHANNEL_ID environment variable is required');
  process.exit(1);
}

async function sendToOrchestrator(data: any): Promise<void> {
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

// Create MCP server
const server = new McpServer({
  name: 'discord-messenger',
  version: '1.0.0',
});

// Tool: Send regular message (no mention)
server.tool(
  'send_regular_message',
  'Send a message to the user in Discord WITHOUT mentioning them. Use this frequently to log your thoughts, actions, and progress. Use Discord markdown: **bold**, *italic*, ~~strike~~, `code`, ```code block```',
  {
    message: z.string().describe('The message to send (use Discord markdown: **bold**, *italic*, `code`)'),
  },
  async ({ message }) => {
    try {
      await sendToOrchestrator({
        type: 'markdown',
        content: message,
      });
      return {
        content: [{ type: 'text', text: 'Message sent' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: Send mention message (mentions the user)
server.tool(
  'send_mention_message',
  'Send a message that @mentions the user. Use this when: (1) you have FINISHED the request, or (2) you need user input to proceed. Use Discord markdown: **bold**, *italic*, ~~strike~~, `code`, ```code block```',
  {
    message: z.string().describe('The message to send with @mention (use Discord markdown: **bold**, *italic*, `code`)'),
  },
  async ({ message }) => {
    try {
      await sendToOrchestrator({
        type: 'mention',
        mentionUser: true,
        mentionText: message,
      });
      return {
        content: [{ type: 'text', text: 'Mention sent' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: Upload file from disk to Discord
server.tool(
  'upload_file',
  'Upload a file from disk to Discord. Use for images, PDFs, or any file.',
  {
    file_path: z.string().describe('The absolute path to the file to upload'),
  },
  async ({ file_path }) => {
    try {
      if (!fs.existsSync(file_path)) {
        return {
          content: [{ type: 'text', text: `File not found: ${file_path}` }],
          isError: true,
        };
      }

      const fileBuffer = fs.readFileSync(file_path);
      const base64Content = fileBuffer.toString('base64');
      const filename = path.basename(file_path);

      await sendToOrchestrator({
        type: 'file_upload',
        filename,
        title: filename,
        base64Content,
      });
      return {
        content: [{ type: 'text', text: `File "${filename}" uploaded` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed: ${error}` }],
        isError: true,
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Discord Messenger MCP server running for channel ${CHANNEL_ID}`);
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
