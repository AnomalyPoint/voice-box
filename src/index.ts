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
const CHUNK_SIZE = 1024;

// Valid voice options
const VALID_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
const VALID_MODELS = ["tts-1", "tts-1-hd"] as const;

type Voice = typeof VALID_VOICES[number];
type Model = typeof VALID_MODELS[number];

/**
 * Play audio stream through local speakers using ffmpeg and speaker
 */
async function playTextToSpeech(
  text: string,
  voice: Voice = "alloy",
  model: Model = "tts-1"
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      // Start ffmpeg process to decode MP3 to PCM
      const ffmpeg = spawn("ffmpeg", [
        "-i", "pipe:0",           // Read from stdin
        "-f", "mp3",              // Input format is mp3
        "-acodec", "pcm_s16le",   // Output codec
        "-ar", String(RATE),      // Audio sample rate
        "-ac", String(CHANNELS),  // Number of audio channels
        "-f", "s16le",            // Output format
        "pipe:1"                  // Write to stdout
      ]);

      // Set up speaker to play PCM audio
      const speaker = new Speaker({
        channels: CHANNELS,
        bitDepth: AUDIO_FORMAT,
        sampleRate: RATE,
      });

      // Pipe ffmpeg output to speaker
      ffmpeg.stdout.pipe(speaker);

      // Handle ffmpeg errors
      let ffmpegError = "";
      ffmpeg.stderr.on("data", (data) => {
        ffmpegError += data.toString();
      });

      ffmpeg.on("error", (error) => {
        reject(new Error(`ffmpeg process error: ${error.message}`));
      });

      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegError}`));
        } else {
          resolve();
        }
      });

      speaker.on("error", (error) => {
        reject(new Error(`Speaker error: ${error.message}`));
      });

      // Get streaming response from OpenAI TTS
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

      // @ts-ignore - Node.js stream compatibility
      for await (const chunk of stream) {
        ffmpeg.stdin.write(chunk);
      }

      // Close ffmpeg stdin to signal end of input
      ffmpeg.stdin.end();

    } catch (error) {
      reject(error);
    }
  });
}

// Create MCP server instance
const server = new Server(
  {
    name: "ava-mcp",
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
        description: "Convert text to speech and play it through local speakers using OpenAI's TTS API. This tool speaks the provided text out loud on the user's computer.",
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
              default: "alloy",
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
    const { text, voice = "alloy", model = "tts-1" } = request.params.arguments as {
      text: string;
      voice?: Voice;
      model?: Model;
    };

    try {
      // Validate inputs
      if (!text || typeof text !== "string") {
        throw new Error("Text parameter is required and must be a string");
      }

      if (voice && !VALID_VOICES.includes(voice)) {
        throw new Error(`Invalid voice. Must be one of: ${VALID_VOICES.join(", ")}`);
      }

      if (model && !VALID_MODELS.includes(model)) {
        throw new Error(`Invalid model. Must be one of: ${VALID_MODELS.join(", ")}`);
      }

      // Play the text to speech
      await playTextToSpeech(text, voice, model);

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

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ava MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
