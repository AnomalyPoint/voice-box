import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved relative to this module so the same path works in both layouts:
//   dist/shared/assets.js -> dist/assets/<name>
//   src/shared/assets.ts  -> src/assets/<name>
const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

/** Absolute path to a shipped asset (see scripts/copy-assets.mjs). */
export function assetPath(name: string): string {
  return join(assetsDir, name);
}

export const ASSETS_DIR = assetsDir;
