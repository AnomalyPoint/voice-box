# Voice Box

Give your AI a voice. Voice Box is an MCP server that adds text-to-speech capabilities to Claude Desktop, Cursor, and other MCP clients using OpenAI's TTS API.

## What It Does

Voice Box plays AI-generated speech directly through your computer's speakers in real-time. Perfect for:
- Having Claude speak responses out loud
- Voice-enabled AI assistants
- Accessibility features
- Hands-free interactions

**Features:**
- 9 voice options (alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer)
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

### For Claude Code

<details open>
<summary><strong>Click to expand/collapse Claude Code setup</strong></summary>

**Quick Install (Recommended)**

**Step 1:** Set your OpenAI API key as an environment variable:

```bash
# macOS/Linux - Add to ~/.bashrc or ~/.zshrc
export OPENAI_API_KEY="your-api-key-here"

# Windows PowerShell
$env:OPENAI_API_KEY="your-api-key-here"
```

**Step 2:** Install Voice Box with one command:

```bash
claude mcp add voice-box --command npx --args "-y @anomalypoint/voice-box@latest" --env OPENAI_API_KEY
```

**Step 3:** Restart Claude Code and approve the MCP server when prompted.

**Step 4:** Test it:
> "Use the text_to_speech tool to say 'Hello from Claude Code'"

---

**Manual Installation (Alternative)**

**Step 1: Create Project MCP Config**

In your project root, create a `.mcp.json` file:

```bash
# Create the config file
touch .mcp.json

# Open with your preferred editor
code .mcp.json
# or
nano .mcp.json
```

> **Note:** Claude Code will prompt for approval before using project-scoped servers from `.mcp.json` files for security.

**Step 2: Add Voice Box Configuration**

Add this to your `.mcp.json` file:

```json
{
  "mcpServers": {
    "voice-box": {
      "command": "npx",
      "args": ["-y", "@anomalypoint/voice-box@latest"],
      "env": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

> **Tip:** Use `${OPENAI_API_KEY}` to reference environment variables from your shell.

**Step 3: Set Environment Variable**

<details>
<summary><strong>macOS/Linux</strong></summary>

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
export OPENAI_API_KEY="your-api-key-here"

# Or set for current session
export OPENAI_API_KEY="your-api-key-here"
```
</details>

<details>
<summary><strong>Windows</strong></summary>

```powershell
# Set for current session
$env:OPENAI_API_KEY="your-api-key-here"

# Or set permanently via System Properties > Environment Variables
```
</details>

**Step 4: Approve and Test**

Start Claude Code and approve the MCP server when prompted, then ask:
> "Use the text_to_speech tool to say 'Hello from Claude Code'"

</details>

---

### For Claude Desktop

<details>
<summary><strong>Click to expand/collapse Claude Desktop setup</strong></summary>

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
      "args": ["-y", "@anomalypoint/voice-box@latest"],
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

</details>

---

### For Cursor

<details>
<summary><strong>Click to expand/collapse Cursor setup</strong></summary>

**Step 1: Create MCP Config File**

<details>
<summary><strong>Project-Specific (Recommended for teams)</strong></summary>

Create `.cursor/mcp.json` in your project root:

```bash
mkdir -p .cursor
touch .cursor/mcp.json
```

This config will be shared with your team via version control.
</details>

<details>
<summary><strong>Global (Available in all projects)</strong></summary>

**macOS/Linux:**
```bash
mkdir -p ~/.cursor
touch ~/.cursor/mcp.json
```

**Windows:**
```
mkdir %USERPROFILE%\.cursor
notepad %USERPROFILE%\.cursor\mcp.json
```
</details>

**Step 2: Add Voice Box Configuration**

Add this to your MCP config file:

```json
{
  "mcpServers": {
    "voice-box": {
      "command": "npx",
      "args": ["-y", "@anomalypoint/voice-box@latest"],
      "env": {
        "OPENAI_API_KEY": "your-openai-api-key"
      }
    }
  }
}
```

**Step 3: Restart Cursor**

**Step 4: Test**

The `text_to_speech` tool should now be available in Cursor's AI features.

</details>

---

### For Other MCP Clients

<details>
<summary><strong>Click to expand/collapse setup for other MCP clients</strong></summary>

Add this to your MCP client's configuration:

```json
{
  "mcpServers": {
    "voice-box": {
      "command": "npx",
      "args": ["-y", "@anomalypoint/voice-box@latest"],
      "env": {
        "OPENAI_API_KEY": "your-openai-api-key"
      }
    }
  }
}
```

</details>

---

## 🎤 Enhanced Voice Communication (Optional)

Want your AI agent to talk through its work like a human colleague? Add these instructions to your `CLAUDE.md` (or equivalent agent instructions file) to enable natural voice communication.

<details>
<summary><strong>Click to expand voice communication setup</strong></summary>

### Quick Setup

Copy the section below and paste it into your `CLAUDE.md` or agent instructions file:

---

**📋 COPY EVERYTHING BELOW THIS LINE:**

```markdown
## Voice Communication Protocol

Use the `text_to_speech` tool to communicate naturally like a colleague working alongside the user.

### Rules:

1. **Voice-First**: Use voice for all communication by default. Never work in silence.

2. **Natural Dialogue**: Talk like a human. Use phrases like:
   - "Okay, working on this now..."
   - "Found the issue in this file..."
   - "Let me check something quick..."
   - "Done with that, moving on..."

3. **Text + Voice for Important Info**: When sharing plans, findings, or decisions, use BOTH text and voice so information is preserved in context:
   - Plans and approaches
   - Key findings and issues
   - Technical details (code, errors, paths)
   - Lists and summaries

   Use voice only for casual progress updates and narration.

4. **Never Go Silent**: Keep the user informed:
   - What you're doing now
   - When you finish a step
   - What's next
   - Any issues you encounter

5. **Wait for Answers**: If you ask a question, wait for the user's response before continuing.

6. **Settings**: Use `voice: "nova"` and `model: "tts-1"` by default.

### Example:

**[Voice]** "Hey, analyzing the auth module now..."
**[Voice]** "Found three issues. Let me put them on screen."

**[Text]** Issues in src/auth/login.ts:
- Line 42: Missing null check
- Line 78: Need try/catch for async
- Line 95: Race condition in token refresh

**[Voice]** "Fixing these now, starting with the null check..."
**[Voice]** "All fixed! Running tests..."
**[Voice]** "Tests passed! What's next?"
```

**📋 END OF COPYABLE SECTION**

---

### Available Voices

Choose from 9 voices (nova recommended for natural conversation):
- **alloy** - Neutral, balanced
- **ash** - Clear, articulate
- **coral** - Warm, conversational
- **echo** - Clear, expressive
- **fable** - Warm, engaging
- **nova** - Energetic, friendly ⭐
- **onyx** - Deep, authoritative
- **sage** - Calm, measured
- **shimmer** - Soft, gentle

</details>

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

- `alloy` - Neutral, balanced
- `ash` - Clear, articulate
- `coral` - Warm, conversational
- `echo` - Clear, expressive
- `fable` - Warm, engaging
- `nova` - Energetic, friendly (default)
- `onyx` - Deep, authoritative
- `sage` - Calm, measured
- `shimmer` - Soft, gentle

### Tool Parameters

- `text` (required) - The text to speak
- `voice` (optional) - Voice to use (default: nova)
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
