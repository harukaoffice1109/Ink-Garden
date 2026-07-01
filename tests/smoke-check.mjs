import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const requiredFiles = [
  "index.html",
  "src/main.js",
  "src/fluid.js",
  "src/scene.js",
  "src/audio.js",
  "src/styles.css",
  "vendor/three.min.js",
  "favicon.svg",
  "og-image.svg"
];

const failures = [];

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`Missing ${file}`);
}

const html = readFileSync(join(root, "index.html"), "utf8");
for (const marker of [
  "paperLayer",
  "fishLayer",
  "inkLayer",
  "surfaceLayer",
  "data-tool=\"brush\"",
  "data-tool=\"vortex\"",
  "id=\"recordBtn\"",
  "aria-pressed"
]) {
  if (!html.includes(marker)) failures.push(`HTML marker not found: ${marker}`);
}

for (const file of ["src/main.js", "src/fluid.js", "src/scene.js", "src/audio.js", "tests/smoke-check.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${file} syntax failed:\n${result.stderr}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Ink Garden smoke check passed.");
