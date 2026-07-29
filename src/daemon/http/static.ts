import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// dist/daemon/http/static.js -> dist/ui ; src/daemon/http/static.ts -> src/ui
const UI_ROOT = resolve(fileURLToPath(new URL("../../ui", import.meta.url)));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

export function uiRoot(): string {
  return UI_ROOT;
}

/**
 * Serve the control panel.
 *
 * Every resolved path is re-checked to be inside the UI directory, so a
 * traversal such as /../../secrets.json cannot escape even if normalisation
 * behaves unexpectedly on some platform.
 */
export async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const candidate = resolve(join(UI_ROOT, relative === "" ? "index.html" : relative));

  if (candidate !== UI_ROOT && !candidate.startsWith(UI_ROOT + sep)) {
    return false;
  }

  let info;
  try {
    info = await stat(candidate);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream",
    "Content-Length": info.size,
    // The panel is local and versionless; never let a stale build stick around.
    "Cache-Control": "no-cache",
  });
  createReadStream(candidate).pipe(res);
  return true;
}
