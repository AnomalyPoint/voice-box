# Voice Box

Give your AI a voice. Voice Box is an MCP server that adds text-to-speech capabilities to Claude Desktop, Cursor, and other MCP clients using OpenAI's TTS API.

## What It Does

Voice Box plays AI-generated speech directly through your computer's speakers in real-time. Perfect for:
- Having Claude speak responses out loud
- Voice-enabled AI assistants
- Accessibility features
- Hands-free interactions

**Features:**
- 6 voice options (alloy, echo, fable, onyx, nova, shimmer)
- 2 quality levels (tts-1 for speed, tts-1-hd for quality)
- Real-time streaming audio
- Works with any MCP client

---

## Quick Start

### Prerequisites

**1. Node.js**
- Version 18 or higher
- Check: `node --version`
- Download: https://nodejs.org

**2. ffmpeg**

<details>
<summary><strong>macOS</strong></summary>

```bash
# Install with Homebrew
brew install ffmpeg

# Verify installation
ffmpeg -version
```
</details>

<details>
<summary><strong>Windows</strong></summary>

1. Download ffmpeg from https://ffmpeg.org/download.html
2. Extract the zip file
3. Add the `bin` folder to your system PATH:
   - Search for "Environment Variables" in Windows Settings
   - Edit "Path" under System Variables
   - Add the path to ffmpeg's `bin` folder (e.g., `C:\ffmpeg\bin`)
4. Restart your terminal
5. Verify: `ffmpeg -version`
</details>

<details>
<summary><strong>Linux (Ubuntu/Debian)</strong></summary>

```bash
# Install ffmpeg
sudo apt-get update
sudo apt-get install ffmpeg

# Verify installation
ffmpeg -version
```
</details>

**3. OpenAI API Key**
- Get your API key from https://platform.openai.com/api-keys
- Keep it handy for configuration

---

## Installation & Setup

### For Claude Desktop

**Step 1: Find Your Config File**

<details>
<summary><strong>macOS</strong></summary>

```bash
# The config file is located at:
~/Library/Application Support/Claude/claude_desktop_config.json

# Open it with:
open -a TextEdit ~/Library/Application\ Support/Claude/claude_desktop_config.json
```
</details>

<details>
<summary><strong>Windows</strong></summary>

```
# The config file is located at:
%APPDATA%\Claude\claude_desktop_config.json

# Open File Explorer and paste the path above, or edit with Notepad:
notepad %APPDATA%\Claude\claude_desktop_config.json
```
</details>

<details>
<summary><strong>Linux</strong></summary>

```bash
# The config file is located at:
~/.config/Claude/claude_desktop_config.json

# Open it with your preferred editor:
nano ~/.config/Claude/claude_desktop_config.json
```
</details>

**Step 2: Add Voice Box Configuration**

Add this to your config file (replace `your-openai-api-key` with your actual key):

```json
{
  "mcpServers": {
    "voice-box": {
      "command": "npx",
      "args": ["-y", "git+https://github.com/AnomalyPoint/voice-box.git"],
      "env": {
        "OPENAI_API_KEY": "your-openai-api-key"
      }
    }
  }
}
```

**Step 3: Restart Claude Desktop**

Quit and reopen Claude Desktop completely.

**Step 4: Test It**

Ask Claude:
> "Use the text_to_speech tool to say 'Hello, this is a test'"

You should hear audio through your speakers!

---

### For Cursor

**Step 1: Open Cursor Settings**

1. Open Cursor
2. Go to Settings (Cmd+, on Mac, Ctrl+, on Windows/Linux)
3. Search for "MCP" or navigate to MCP settings

**Step 2: Add Voice Box**

Add this configuration:

```json
{
  "voice-box": {
    "command": "npx",
    "args": ["-y", "git+https://github.com/AnomalyPoint/voice-box.git"],
    "env": {
      "OPENAI_API_KEY": "your-openai-api-key"
    }
  }
}
```

**Step 3: Restart Cursor**

**Step 4: Test**

The `text_to_speech` tool should now be available in Cursor's AI features.

---

### For Claude Code

**Step 1: Create MCP Config File**

<details>
<summary><strong>macOS/Linux</strong></summary>

```bash
# Create the config file if it doesn't exist
mkdir -p ~/.config/claude-code
touch ~/.config/claude-code/mcp.json

# Open it with your preferred editor
nano ~/.config/claude-code/mcp.json
# or
code ~/.config/claude-code/mcp.json
```
</details>

<details>
<summary><strong>Windows</strong></summary>

```
# Create the config file if it doesn't exist
mkdir %USERPROFILE%\.config\claude-code
notepad %USERPROFILE%\.config\claude-code\mcp.json
```
</details>

**Step 2: Add Voice Box Configuration**

Add this to your `mcp.json` file:

```json
{
  "mcpServers": {
    "voice-box": {
      "command": "npx",
      "args": ["-y", "git+https://github.com/AnomalyPoint/voice-box.git"],
      "env": {
        "OPENAI_API_KEY": "your-openai-api-key"
      }
    }
  }
}
```

**Step 3: Restart Claude Code**

If you have Claude Code running, restart it to load the new MCP server.

**Step 4: Test**

In your terminal with Claude Code:
```bash
claude-code
```

Then ask Claude to use the tool:
> "Use the text_to_speech tool to say 'Hello from Claude Code'"

---

### For Other MCP Clients

Add this to your MCP client's configuration:

```json
{
  "mcpServers": {
    "voice-box": {
      "command": "npx",
      "args": ["-y", "git+https://github.com/AnomalyPoint/voice-box.git"],
      "env": {
        "OPENAI_API_KEY": "your-openai-api-key"
      }
    }
  }
}
```

---

## Usage

Once installed, use the `text_to_speech` tool in your MCP client:

**Basic usage:**
```
Use text_to_speech to say "Hello world"
```

**With specific voice:**
```
Use text_to_speech with the nova voice to say "I sound different now"
```

**With high quality:**
```
Use text_to_speech with model tts-1-hd to say "High quality audio"
```

### Available Voices

- `alloy` - Neutral, balanced (default)
- `echo` - Clear, expressive
- `fable` - Warm, engaging
- `onyx` - Deep, authoritative
- `nova` - Energetic, friendly
- `shimmer` - Soft, gentle

### Tool Parameters

- `text` (required) - The text to speak
- `voice` (optional) - Voice to use (default: alloy)
- `model` (optional) - tts-1 (faster) or tts-1-hd (higher quality, default: tts-1)

---

## Troubleshooting

### "ffmpeg not found"
**Solution:** Make sure ffmpeg is installed and in your PATH. Test with:
```bash
ffmpeg -version
```

### "OPENAI_API_KEY environment variable is required"
**Solution:** Check that your API key is correctly set in the MCP config file.

### Audio not playing
**Check:**
1. System volume is up
2. Default audio output device is working
3. Try a different voice: `Use text_to_speech with the echo voice to say "test"`

### First-time slow startup
**Normal:** The first run may take 30-60 seconds as npm installs dependencies. Subsequent runs are fast.

### Claude Desktop not detecting the server
**Solution:**
1. Verify the config file path is correct
2. Check JSON syntax is valid (use https://jsonlint.com)
3. Completely quit and restart Claude Desktop
4. Check Claude Desktop logs for errors

**macOS logs:**
```bash
tail -f ~/Library/Logs/Claude/mcp*.log
```

**Windows logs:**
```
%APPDATA%\Claude\logs\
```

---

## How It Works

1. **OpenAI TTS** - Generates high-quality MP3 audio from text
2. **ffmpeg** - Decodes MP3 to raw PCM audio (16-bit, 24kHz, mono)
3. **speaker** - Plays PCM audio through your system's default audio output

This streaming pipeline ensures low latency and smooth playback.

---

## Development

Want to modify or extend Voice Box?

```bash
# Clone the repository
git clone https://github.com/AnomalyPoint/voice-box.git
cd voice-box

# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Test locally
node dist/index.js
```

---

## Privacy & Security

- **No data storage** - Audio is streamed and played in real-time, nothing is saved
- **API key security** - Your OpenAI API key is stored locally in your MCP config
- **Open source** - All code is visible and auditable

---

## License

ISC

---

## Support

- **Issues:** https://github.com/AnomalyPoint/voice-box/issues
- **Docs:** https://github.com/AnomalyPoint/voice-box

Made with Claude Code 🤖
