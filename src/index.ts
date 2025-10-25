#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import { spawn } from "child_process";
import Speaker from "speaker";

// Environment variable handling
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Audio configuration
const AUDIO_FORMAT = 16; // 16-bit
const CHANNELS = 1;
const RATE = 24000;

// Valid voice options
const VALID_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
const VALID_MODELS = ["tts-1", "tts-1-hd"] as const;

// OpenAI TTS text length limit
const MAX_TEXT_LENGTH = 4096;

// Request timeout (5 minutes)
const REQUEST_TIMEOUT = 300000;

// Maximum error message buffer size (10KB)
const MAX_ERROR_BUFFER_SIZE = 10240;

// Simple logging utility (logs to stderr to not interfere with MCP stdio)
const log = (message: string, ...args: any[]) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [Voice Box]`, message, ...args);
};

type Voice = typeof VALID_VOICES[number];
type Model = typeof VALID_MODELS[number];

/**
 * Wraps a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

/**
 * Play audio stream through local speakers using ffmpeg and speaker
 */
async function playTextToSpeech(
  text: string,
  voice: Voice = "alloy",
  model: Model = "tts-1"
): Promise<void> {
  log(`Starting TTS: voice=${voice}, model=${model}, textLength=${text.length}`);
  return new Promise(async (resolve, reject) => {
    let settled = false;
    let ffmpeg: ReturnType<typeof spawn> | null = null;
    let speaker: Speaker | null = null;

    try {
      // Start ffmpeg process to decode MP3 to PCM
      ffmpeg = spawn("ffmpeg", [
        "-i", "pipe:0",           // Read from stdin
        "-f", "mp3",              // Input format is mp3
        "-acodec", "pcm_s16le",   // Output codec
        "-ar", String(RATE),      // Audio sample rate
        "-ac", String(CHANNELS),  // Number of audio channels
        "-f", "s16le",            // Output format
        "pipe:1"                  // Write to stdout
      ]);

      // Set up speaker to play PCM audio
      speaker = new Speaker({
        channels: CHANNELS,
        bitDepth: AUDIO_FORMAT,
        sampleRate: RATE,
      });

      // Pipe ffmpeg output to speaker
      if (!ffmpeg.stdout) {
        throw new Error("ffmpeg stdout is not available");
      }
      ffmpeg.stdout.pipe(speaker);

      // Handle ffmpeg errors (limit buffer size to prevent memory issues)
      let ffmpegError = "";
      if (!ffmpeg.stderr) {
        throw new Error("ffmpeg stderr is not available");
      }
      ffmpeg.stderr.on("data", (data) => {
        const chunk = data.toString();
        if (ffmpegError.length + chunk.length <= MAX_ERROR_BUFFER_SIZE) {
          ffmpegError += chunk;
        } else if (ffmpegError.length < MAX_ERROR_BUFFER_SIZE) {
          // Add what we can fit and append truncation notice
          const remaining = MAX_ERROR_BUFFER_SIZE - ffmpegError.length;
          ffmpegError += chunk.slice(0, remaining) + "\n...[error output truncated]";
        }
      });

      ffmpeg.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(new Error(`ffmpeg process error: ${error.message}`));
        }
      });

      ffmpeg.on("close", (code) => {
        if (code !== 0 && !settled) {
          settled = true;
          reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegError}`));
        }
        // Don't resolve here - wait for speaker to finish
      });

      speaker.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Speaker error: ${error.message}`));
        }
      });

      // Resolve when speaker finishes playing audio
      speaker.on("close", () => {
        if (!settled) {
          settled = true;
          log("Audio playback completed");
          resolve();
        }
      });

      // Get streaming response from OpenAI TTS
      log("Requesting TTS from OpenAI API...");
      const response = await openai.audio.speech.create({
        model,
        voice,
        input: text,
        response_format: "mp3",
      });

      // Stream the response to ffmpeg stdin
      const stream = response.body;
      if (!stream) {
        throw new Error("No audio stream received from OpenAI");
      }

      // TypeScript doesn't recognize OpenAI's Response.body as async iterable,
      // but it implements the AsyncIterator protocol at runtime.
      // This is safe because OpenAI SDK returns a ReadableStream that supports async iteration.
      // @ts-ignore - OpenAI Response.body async iteration not typed
      log("Streaming audio data from OpenAI to ffmpeg...");
      if (!ffmpeg.stdin) {
        throw new Error("ffmpeg stdin is not available");
      }
      for await (const chunk of stream) {
        ffmpeg.stdin.write(chunk);
      }

      // Close ffmpeg stdin to signal end of input
      log("Audio stream complete, waiting for playback to finish...");
      if (!ffmpeg.stdin) {
        throw new Error("ffmpeg stdin is not available");
      }
      ffmpeg.stdin.end();

    } catch (error) {
      log("Error in playTextToSpeech:", error);

      // Clean up resources on error
      if (ffmpeg && !ffmpeg.killed) {
        ffmpeg.kill();
      }
      if (speaker) {
        speaker.end();
      }

      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
}

// Create MCP server
const server = new Server(
  {
    name: "voice-box",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "text_to_speech",
        description: "Convert text to speech and play it through local speakers using OpenAI's TTS API. This tool allows AI agents to provide natural voice updates and communicate like human colleagues, creating a more collaborative interaction. The audio plays directly on the user's computer.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text to convert to speech and play",
            },
            voice: {
              type: "string",
              description: "The voice to use for speech synthesis",
              enum: VALID_VOICES,
              default: "onyx",
            },
            model: {
              type: "string",
              description: "The TTS model to use (tts-1 is faster, tts-1-hd is higher quality)",
              enum: VALID_MODELS,
              default: "tts-1",
            },
          },
          required: ["text"],
        },
      },
    ],
  };
});

// Handle tool call request
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "text_to_speech") {
    const { text, voice = "onyx", model = "tts-1" } = request.params.arguments as {
      text: string;
      voice?: Voice;
      model?: Model;
    };

    try {
      // Validate inputs
      if (!text || typeof text !== "string") {
        throw new Error("Text parameter is required and must be a string");
      }

      if (text.length > MAX_TEXT_LENGTH) {
        throw new Error(`Text too long. Maximum length is ${MAX_TEXT_LENGTH} characters (received ${text.length})`);
      }

      if (voice && !VALID_VOICES.includes(voice)) {
        throw new Error(`Invalid voice. Must be one of: ${VALID_VOICES.join(", ")}`);
      }

      if (model && !VALID_MODELS.includes(model)) {
        throw new Error(`Invalid model. Must be one of: ${VALID_MODELS.join(", ")}`);
      }

      // Play the text to speech with timeout
      await withTimeout(playTextToSpeech(text, voice, model), REQUEST_TIMEOUT);

      return {
        content: [
          {
            type: "text",
            text: `Successfully played text to speech with voice "${voice}" using model "${model}"`,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error playing text to speech: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Connect stdio transport and start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is used for MCP protocol)
  console.error("Voice Box MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
