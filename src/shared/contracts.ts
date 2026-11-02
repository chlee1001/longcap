export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Tool =
  | "select"
  | "crop"
  | "rect"
  | "ellipse"
  | "arrow"
  | "line"
  | "text"
  | "highlight"
  | "redact"
  | "badge"
  | "pen"
  | "marker";

export interface Annotation {
  id: string;
  type: Exclude<Tool, "select" | "crop">;
  rect: Rect;
  color: string;
  fill: string;
  lineWidth: number;
  points?: Point[];
  text?: string;
  fontSize?: number;
  number?: number;
  mode?: "blur" | "pixel";
  heads?: "end" | "both";
}

export interface EditDocument {
  annotations: Annotation[];
  crop: Rect | null;
  template: "none" | "bar" | "barBottom" | "mac" | "windows";
  dateFormat: "date" | "datetime" | "iso" | "none";
}

export interface Tile {
  id: string;
  blobKey: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface Link {
  rect: Rect;
  href: string;
}

export interface TextRun {
  rect: Rect;
  text: string;
}

export interface CaptureRecord {
  id: string;
  title: string;
  url: string;
  createdAt: number;
  width: number;
  height: number;
  scale: number;
  tiles: Tile[];
  links: Link[];
  text: TextRun[];
  edit: EditDocument;
  revision: number;
  complete: boolean;
  warnings: string[];
  source: "page" | "element" | "pdf";
}

export type JobState =
  | "preparing"
  | "capturing"
  | "paused"
  | "composing"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface CaptureJob {
  id: string;
  requestId: string;
  tabId: number;
  windowId: number;
  documentId: string;
  mode: "page" | "element" | "pdf";
  frameId: number;
  token?: string;
  state: JobState;
  completed: number;
  total: number;
  createdAt: number;
  updatedAt: number;
  captureId?: string;
  error?: string;
  warnings: string[];
}

export interface Settings {
  format: "png" | "jpg" | "pdf";
  quality: number;
  pdfPaper: "one" | "a4" | "letter" | "legal";
  landscape: boolean;
  smartSplit: boolean;
  pdfLinks: boolean;
  pdfText: boolean;
  provenance: boolean;
  includeUrl: boolean;
  imageWaitMs: number;
  maxTiles: number;
  maxDurationMs: number;
  saveAs: boolean;
  folder: string;
  clipboardFit: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  format: "png",
  quality: 0.92,
  pdfPaper: "a4",
  landscape: false,
  smartSplit: true,
  pdfLinks: true,
  pdfText: true,
  provenance: false,
  includeUrl: false,
  imageWaitMs: 1500,
  maxTiles: 200,
  maxDurationMs: 120000,
  saveAs: false,
  folder: "",
  clipboardFit: true,
};

export function emptyEdit(): EditDocument {
  return { annotations: [], crop: null, template: "none", dateFormat: "none" };
}

export interface RuntimeRequest {
  target: "broker" | "host";
  type: string;
  requestId: string;
  jobId?: string;
  payload?: unknown;
}

export interface RuntimeReply<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
}

export function makeRequest(
  target: RuntimeRequest["target"],
  type: string,
  payload?: unknown,
  jobId?: string,
): RuntimeRequest {
  return { target, type, requestId: crypto.randomUUID(), payload, jobId };
}

export async function callBroker<T>(
  type: string,
  payload?: unknown,
  jobId?: string,
): Promise<T> {
  const reply: RuntimeReply<T> = await chrome.runtime.sendMessage(
    makeRequest("broker", type, payload, jobId),
  );
  if (!reply?.ok)
    throw new Error(reply?.error || "Capture broker did not respond");
  return reply.value as T;
}

export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "target") &&
    Object.hasOwn(value, "type") &&
    Object.hasOwn(value, "requestId") &&
    "target" in value &&
    (value.target === "broker" || value.target === "host") &&
    "type" in value &&
    typeof value.type === "string" &&
    "requestId" in value &&
    typeof value.requestId === "string"
  );
}

export interface ScrollerInfo {
  documentId: string;
  title: string;
  url: string;
  width: number;
  height: number;
  viewport: Rect;
  scrollX: number;
  scrollY: number;
  scaleX: number;
  scaleY: number;
  windowWidth: number;
  windowHeight: number;
  /** Scroller was auto-detected for a page capture; compose it into the window. */
  embedded: boolean;
  links: Link[];
  text: TextRun[];
  warnings: string[];
}

export interface ExportFile {
  name: string;
  blob: Blob;
}
