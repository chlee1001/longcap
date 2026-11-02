import { readdir, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";

const filters = process.argv.slice(2);
const files = (
  await readdir(new URL("../tests/", import.meta.url), { withFileTypes: true })
)
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".test.ts") &&
      (filters.length === 0 ||
        filters.some((filter) => entry.name.includes(filter))),
  )
  .map((entry) => entry.name)
  .sort();
if (files.length === 0) throw new Error("No test files selected");
const outputDirectory = new URL("../.test-build/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: files.map((file) =>
    join(fileURLToPath(new URL("../tests/", import.meta.url)), file),
  ),
  outdir: fileURLToPath(outputDirectory),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outExtension: { ".js": ".mjs" },
});
const outputs = files.map((file) =>
  join(fileURLToPath(outputDirectory), file.replace(/\.ts$/, ".mjs")),
);
const child = spawn(process.execPath, ["--test", ...outputs], {
  stdio: "inherit",
});
const timer = setTimeout(() => {
  console.error("Test run exceeded 120 seconds");
  child.kill("SIGKILL");
}, 120_000);
const outcome = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
}).finally(() => clearTimeout(timer));
if (outcome.signal) {
  console.error(`Test process terminated by ${outcome.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = outcome.code ?? 1;
}
