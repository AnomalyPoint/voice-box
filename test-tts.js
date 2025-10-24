#!/usr/bin/env node
/**
 * Simple test script to verify the MCP server's text-to-speech functionality
 * This sends a properly formatted MCP tool call request to test the server
 */

const { spawn } = require('child_process');
const readline = require('readline');

// Load environment variables from parent .env
require('dotenv').config({ path: '../.env' });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY not found. Make sure ../.env has OPENAI_API_KEY set');
  process.exit(1);
}

// Start the MCP server
const server = spawn('node', ['dist/index.js'], {
  env: { ...process.env, OPENAI_API_KEY },
  stdio: ['pipe', 'pipe', 'pipe']
});

let buffer = '';

server.stdout.on('data', (data) => {
  buffer += data.toString();

  // Try to parse JSON-RPC responses
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        console.log('Response:', JSON.stringify(response, null, 2));
      } catch (e) {
        console.log('Server output:', line);
      }
    }
  }
});

server.stderr.on('data', (data) => {
  console.error('Server stderr:', data.toString());
});

server.on('close', (code) => {
  console.log(`Server exited with code ${code}`);
  process.exit(code || 0);
});

// Wait a bit for server to start
setTimeout(() => {
  console.log('Testing text_to_speech tool...\n');

  // Send initialization request
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

  // Wait for init, then list tools
  setTimeout(() => {
    const listToolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    };

    server.stdin.write(JSON.stringify(listToolsRequest) + '\n');

    // Wait, then call the tool
    setTimeout(() => {
      const callToolRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'text_to_speech',
          arguments: {
            text: 'Hello! This is a test of the text to speech MCP server. If you can hear this, it means everything is working correctly!',
            voice: 'alloy',
            model: 'tts-1'
          }
        }
      };

      console.log('Calling text_to_speech tool...');
      server.stdin.write(JSON.stringify(callToolRequest) + '\n');

      // Wait for audio to complete, then exit
      setTimeout(() => {
        console.log('\nTest complete! Shutting down...');
        server.kill();
      }, 15000); // Wait 15 seconds for audio to play

    }, 500);
  }, 500);
}, 1000);
