import { cp, mkdir, stat } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: [
    "src/background.ts",
    "src/offscreen.ts",
    "src/popup.ts",
    "src/app.ts",
  ],
  bundle: true,
  format: "esm",
  target: "chrome116",
  outdir: "dist",
});

await build({
  entryPoints: ["src/content.ts"],
  bundle: true,
  format: "iife",
  target: "chrome116",
  outdir: "dist",
});

for (const file of ["popup.html", "app.html", "offscreen.html", "styles.css"]) {
  await cp(`ui/${file}`, `dist/${file}`);
}
await cp("manifest.json", "dist/manifest.json");
await cp("THIRD_PARTY_NOTICES.txt", "dist/THIRD_PARTY_NOTICES.txt");
await cp("node_modules/pdfjs-dist/build/pdf.worker.mjs", "dist/pdf.worker.mjs");
for (const directory of ["cmaps", "standard_fonts"]) {
  await cp(`node_modules/pdfjs-dist/${directory}`, `dist/${directory}`, {
    recursive: true,
  });
}
for (const directory of ["wasm", "iccs"]) {
  try {
    await stat(`node_modules/pdfjs-dist/${directory}`);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  await cp(`node_modules/pdfjs-dist/${directory}`, `dist/${directory}`, {
    recursive: true,
  });
}
await mkdir("dist/assets", { recursive: true });
for (const file of [
  "local-font.ttf",
  "emoji-font.ttf",
  "NotoSansKR-OFL.txt",
  "NotoEmoji-OFL.txt",
]) {
  await cp(`assets/${file}`, `dist/assets/${file}`);
}
