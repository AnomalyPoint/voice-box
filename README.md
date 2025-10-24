# Ava MCP - Text-to-Speech MCP Server

A Model Context Protocol (MCP) server that provides text-to-speech capabilities using OpenAI's TTS API. This server plays audio directly through your local speakers, making it perfect for AI assistants and agents that need to communicate verbally.

## Features

- 🎙️ **Real-time Text-to-Speech**: Converts text to speech using OpenAI's TTS API
- 🔊 **Local Audio Playback**: Plays audio directly through your computer's speakers
- 🎭 **Multiple Voices**: Choose from 6 different voices (alloy, echo, fable, onyx, nova, shimmer)
- ⚡ **Two Quality Levels**: Use tts-1 for speed or tts-1-hd for higher quality
- 🔌 **MCP Compatible**: Works with any MCP client (Claude Desktop, Cline, etc.)

## Prerequisites

- Node.js 18 or higher
- ffmpeg installed and available in PATH
- OpenAI API key

### Installing ffmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt-get install ffmpeg
```

**Windows:**
Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH

## Installation

### Option 1: Using npx (recommended)

Add to your MCP client configuration (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "ava-tts": {
      "command": "npx",
      "args": ["-y", "ava-mcp"],
      "env": {
        "OPENAI_API_KEY": "your-openai-api-key-here"
      }
    }
  }
}
```

### Option 2: Local Installation

```bash
npm install -g ava-mcp
```

Then configure your MCP client:

```json
{
  "mcpServers": {
    "ava-tts": {
      "command": "ava-mcp",
      "env": {
        "OPENAI_API_KEY": "your-openai-api-key-here"
      }
    }
  }
}
```

### Option 3: Development/Local Testing

```bash
# Clone or navigate to the project
cd ava-mcp

# Install dependencies
npm install

# Build the project
npm run build

# Run locally
npm start
```

## Usage

Once configured, the `text_to_speech` tool will be available to your MCP client.

### Tool: text_to_speech

**Description:** Convert text to speech and play it through local speakers

**Parameters:**
- `text` (required): The text to convert to speech and play
- `voice` (optional): Voice to use - alloy, echo, fable, onyx, nova, or shimmer (default: alloy)
- `model` (optional): TTS model - tts-1 (faster) or tts-1-hd (higher quality) (default: tts-1)

### Example Usage

In Claude Desktop or another MCP client, you can ask:

> "Use the text-to-speech tool to say 'Hello, how are you today?'"

Or with specific voice:

> "Use text-to-speech with the nova voice to say 'This is a test'"

## Configuration

### MCP Client Configuration

The server requires the `OPENAI_API_KEY` environment variable. Configure it in your MCP client's config file.

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "ava-tts": {
      "command": "npx",
      "args": ["-y", "ava-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with auto-reload)
npm run dev

# Build for production
npm run build

# Run built version
npm start
```

## Architecture

The server uses a streaming audio pipeline:

1. **OpenAI TTS API** generates MP3 audio stream
2. **ffmpeg** decodes MP3 to PCM (16-bit, 24kHz, mono)
3. **speaker** library plays PCM audio through local speakers

This architecture ensures low latency and high-quality audio playback.

## Troubleshooting

### "ffmpeg not found"
Make sure ffmpeg is installed and in your PATH. Test with:
```bash
ffmpeg -version
```

### "OPENAI_API_KEY environment variable is required"
Ensure your MCP client configuration includes the OPENAI_API_KEY in the env section.

### Audio not playing
- Check your system volume
- Verify your default audio output device is working
- Try with a different voice or model

### Permission denied errors (Linux/macOS)
The built file should be executable. If not:
```bash
chmod +x dist/index.js
```

## License

ISC

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.
