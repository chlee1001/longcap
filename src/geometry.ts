import {
  DEFAULT_SETTINGS,
  type CaptureJob,
  type JobState,
  type Rect,
  type Settings,
} from "./shared/contracts.js";

export interface PlannedTile {
  x: number;
  y: number;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export function planTiles(
  width: number,
  height: number,
  viewW: number,
  viewH: number,
  maxTiles = 200,
): { tiles: PlannedTile[]; complete: boolean } {
  if (
    ![width, height, viewW, viewH].every((n) => Number.isFinite(n) && n > 0) ||
    !Number.isInteger(maxTiles) ||
    maxTiles < 1 ||
    maxTiles > 2000
  )
    throw new RangeError("Invalid tile dimensions or limit");
  const columns = Math.ceil(width / viewW);
  const rows = Math.ceil(height / viewH);
  const tiles: PlannedTile[] = [];
  for (let row = 0; row < rows && tiles.length < maxTiles; row++) {
    for (
      let column = 0;
      column < columns && tiles.length < maxTiles;
      column++
    ) {
      const x = column * viewW;
      const y = row * viewH;
      tiles.push({
        x,
        y,
        width: Math.min(viewW, width - x),
        height: Math.min(viewH, height - y),
        scrollX: Math.min(x, Math.max(0, width - viewW)),
        scrollY: Math.min(y, Math.max(0, height - viewH)),
      });
    }
  }
  return { tiles, complete: columns * rows <= maxTiles };
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function sanitizeSourceUrl(value: string): string {
  const safe = safeUrl(value);
  if (!safe) return "";
  const url = new URL(safe);
  url.search = "";
  url.hash = "";
  return url.href;
}

export function cleanFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 200)
    .replace(/[. ]+$/g, "");
  return cleaned &&
    cleaned !== "." &&
    cleaned !== ".." &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
    ? cleaned
    : "capture";
}

const edges: Record<JobState, readonly JobState[]> = {
  preparing: ["capturing", "cancelled", "failed", "interrupted"],
  capturing: ["paused", "composing", "cancelled", "failed", "interrupted"],
  paused: ["capturing", "cancelled", "failed", "interrupted"],
  composing: ["completed", "cancelled", "failed", "interrupted"],
  completed: [],
  cancelled: [],
  failed: [],
  interrupted: [],
};

export function transition(
  job: CaptureJob,
  next: JobState,
  now = Date.now(),
): CaptureJob {
  if (
    !edges[job.state]?.includes(next) ||
    !Number.isFinite(now) ||
    now < job.updatedAt
  )
    throw new Error("Invalid job transition");
  return { ...job, state: next, updatedAt: now };
}

export function validateSettings(value: unknown): Settings {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid settings");
  const input = value as Record<string, unknown>;
  const merged = { ...DEFAULT_SETTINGS, ...input };
  if (
    !["png", "jpg", "pdf"].includes(merged.format as string) ||
    !["one", "a4", "letter", "legal"].includes(merged.pdfPaper as string)
  )
    throw new TypeError("Invalid settings enum");
  for (const key of [
    "landscape",
    "smartSplit",
    "pdfLinks",
    "pdfText",
    "provenance",
    "includeUrl",
    "saveAs",
    "clipboardFit",
  ] as const) {
    if (typeof merged[key] !== "boolean")
      throw new TypeError(`Invalid setting: ${key}`);
  }
  for (const [key, min, max, integer] of [
    ["quality", 0, 1, false],
    ["imageWaitMs", 0, 60000, true],
    ["maxTiles", 1, 2000, true],
    ["maxDurationMs", 1000, 3600000, true],
  ] as const) {
    const n = merged[key];
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      (integer && !Number.isInteger(n))
    )
      throw new RangeError(`Invalid setting: ${key}`);
  }
  if (
    typeof merged.folder !== "string" ||
    /[\u0000-\u001f\u007f]/.test(merged.folder)
  )
    throw new TypeError("Invalid setting: folder");
  return {
    format: merged.format,
    quality: merged.quality,
    pdfPaper: merged.pdfPaper,
    landscape: merged.landscape,
    smartSplit: merged.smartSplit,
    pdfLinks: merged.pdfLinks,
    pdfText: merged.pdfText,
    provenance: merged.provenance,
    includeUrl: merged.includeUrl,
    imageWaitMs: merged.imageWaitMs,
    maxTiles: merged.maxTiles,
    maxDurationMs: merged.maxDurationMs,
    saveAs: merged.saveAs,
    folder: merged.folder,
    clipboardFit: merged.clipboardFit,
  };
}
