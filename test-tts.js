#!/usr/bin/env node
/**
 * Test script for Voice Box MCP server (stdio transport)
 * This sends MCP protocol messages via stdin/stdout to test the text_to_speech tool
 */

const { spawn } = require('child_process');
const readline = require('readline');

// Load environment variables
require('dotenv').config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY not found. Make sure .env has OPENAI_API_KEY set');
  process.exit(1);
}

console.log('Starting Voice Box MCP server test...\n');

// Start the MCP server
const server = spawn('node', ['dist/index.js'], {
  env: { ...process.env, OPENAI_API_KEY },
  stdio: ['pipe', 'pipe', 'inherit'] // stdin, stdout, stderr
});

let responseBuffer = '';
let testComplete = false;

// Handle server stdout (MCP responses)
server.stdout.on('data', (data) => {
  responseBuffer += data.toString();

  // Try to parse complete JSON-RPC messages
  const lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() || ''; // Keep incomplete line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const response = JSON.parse(line);
      console.log('← Received:', JSON.stringify(response, null, 2));

      // Handle initialize response
      if (response.id === 1 && response.result) {
        console.log('\n✓ Server initialized successfully');
        console.log('Server info:', response.result.serverInfo);
        console.log('\nSending tools/list request...\n');

        // Send tools/list request
        const listToolsRequest = {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list'
        };
        server.stdin.write(JSON.stringify(listToolsRequest) + '\n');
      }

      // Handle tools/list response
      if (response.id === 2 && response.result) {
        console.log('\n✓ Tools listed successfully');
        console.log('Available tools:', response.result.tools.map(t => t.name));
        console.log('\nCalling text_to_speech tool...\n');

        // Send tool call request
        const callToolRequest = {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'text_to_speech',
            arguments: {
              text: 'Hello! This is a test of the stdio-based Voice Box MCP server. If you can hear this, the migration to stdio was successful!',
              voice: 'nova',
              model: 'tts-1'
            }
          }
        };
        server.stdin.write(JSON.stringify(callToolRequest) + '\n');
      }

      // Handle tool call response
      if (response.id === 3 && response.result) {
        console.log('\n✓ Text-to-speech tool executed successfully!');
        console.log('Result:', response.result.content[0].text);
        console.log('\n🎉 All tests passed!\n');
        testComplete = true;

        // Give audio time to finish, then exit
        setTimeout(() => {
          server.kill();
          process.exit(0);
        }, 2000);
      }

      // Handle errors
      if (response.error) {
        console.error('\n✗ Error:', response.error);
        server.kill();
        process.exit(1);
      }

    } catch (e) {
      // Not valid JSON or incomplete message, ignore
    }
  }
});

server.on('error', (error) => {
  console.error('Server process error:', error);
  process.exit(1);
});

server.on('close', (code) => {
  if (!testComplete) {
    console.log(`\nServer exited with code ${code}`);
    process.exit(code || 0);
  }
});

// Send initialization request after a brief delay
setTimeout(() => {
  console.log('Sending initialize request...\n');

  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  };

  server.stdin.write(JSON.stringify(initRequest) + '\n');
}, 500);

// Handle cleanup on Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\nTest interrupted by user');
  server.kill();
  process.exit(0);
});
