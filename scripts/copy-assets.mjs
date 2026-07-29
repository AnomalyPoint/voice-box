#!/usr/bin/env node
/**
 * Copies non-TypeScript assets into dist/ after `tsc` runs.
 *
 * The web UI is deliberately never bundled or transpiled -- it ships as plain
 * HTML/CSS/ES modules so it works offline and stays auditable in the tarball.
 * See scripts/ (build tooling, not shipped) vs src/assets/ (shipped).
 */
import { cp, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const ASSETS = [
  ["src/ui", "dist/ui"],
  ["src/assets", "dist/assets"],
];

const exists = async (p) => access(p).then(() => true, () => false);

let copied = 0;
for (const [from, to] of ASSETS) {
  const src = join(root, from);
  if (!(await exists(src))) continue;
  await mkdir(dirname(join(root, to)), { recursive: true });
  await cp(src, join(root, to), { recursive: true });
  console.log(`  copied ${from} -> ${to}`);
  copied++;
}

if (copied === 0) console.log("  no assets to copy");
