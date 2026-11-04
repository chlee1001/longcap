import { PDFDocument, PDFName, PDFString, PDFHexString } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  cleanFileName,
  intersection,
  safeUrl,
  validateSettings,
} from "./geometry.js";
import { getOutputRect, renderRegion, sanitizedMetadata } from "./render.js";
import type {
  CaptureRecord,
  ExportFile,
  Rect,
  Settings,
} from "./shared/contracts.js";

export interface PdfPagePlan {
  region: Rect;
  width: number;
  height: number;
  margin: number;
  factor: number;
}
const papers = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
} as const;
const LIMIT = 14400;
const PIXELS = 16_000_000;
export function pagePlan(
  width: number,
  height: number,
  settings: Settings,
): PdfPagePlan[] {
  validateSettings(settings);
  if (![width, height].every((n) => Number.isFinite(n) && n > 0))
    throw new RangeError("Invalid PDF dimensions");
  const pages: PdfPagePlan[] = [];
  if (settings.pdfPaper === "one") {
    const factor = Math.min(0.75, LIMIT / width),
      pageHeight = LIMIT / factor;
    for (let y = 0; y < height; y += pageHeight) {
      const h = Math.min(pageHeight, height - y);
      pages.push({
        region: { x: 0, y, width, height: h },
        width: width * factor,
        height: h * factor,
        margin: 0,
        factor,
      });
    }
  } else {
    let pw: number = papers[settings.pdfPaper][0],
      ph: number = papers[settings.pdfPaper][1];
    if (settings.landscape) [pw, ph] = [ph, pw];
    const factor = (pw - 40) / width,
      pageHeight = (ph - 40) / factor;
    for (let y = 0; y < height; y += pageHeight)
      pages.push({
        region: { x: 0, y, width, height: Math.min(pageHeight, height - y) },
        width: pw,
        height: ph,
        margin: 20,
        factor,
      });
  }
  return pages;
}
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const b of bytes) {
    value ^= b;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12),
    view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(out.length - 4, crc(out.subarray(4, out.length - 4)));
  return out;
}
export function pngWithMetadata(
  bytes: Uint8Array,
  entries: Record<string, string>,
): Uint8Array {
  if (bytes.length < 8 || signature.some((n, i) => bytes[i] !== n))
    throw new Error("Invalid PNG signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8,
    end = -1,
    count = 0,
    idat = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12)
      throw new Error("Truncated PNG chunk");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc(bytes.subarray(offset + 4, offset + 8 + length)) !==
        view.getUint32(offset + 8 + length)
    )
      throw new Error("Invalid PNG chunk");
    if (
      count++ === 0 &&
      (type !== "IHDR" ||
        length !== 13 ||
        !view.getUint32(offset + 8) ||
        !view.getUint32(offset + 12))
    )
      throw new Error("Invalid PNG header");
    if (type === "IDAT") idat = true;
    if (type === "IEND") {
      if (length || !idat || offset + 12 !== bytes.length)
        throw new Error("Invalid PNG end");
      end = offset;
      break;
    }
    offset += length + 12;
  }
  if (end < 0) throw new Error("Incomplete PNG");
  const encoder = new TextEncoder();
  const extras = Object.entries(entries).map(([key, value]) => {
    if (
      !/^[\x20-\x7e]{1,79}$/.test(key) ||
      key.trim() !== key ||
      key.includes("  ") ||
      value.includes("\0")
    )
      throw new Error("Invalid PNG metadata");
    const k = encoder.encode(key),
      v = encoder.encode(value),
      data = new Uint8Array(k.length + 5 + v.length);
    data.set(k);
    data.set(v, k.length + 5);
    return chunk("iTXt", data);
  });
  const out = new Uint8Array(
    bytes.length + extras.reduce((n, c) => n + c.length, 0),
  );
  out.set(bytes.subarray(0, end));
  let pos = end;
  for (const extra of extras) {
    out.set(extra, pos);
    pos += extra.length;
  }
  out.set(bytes.subarray(end), pos);
  return out;
}
export function provenancePayload(
  record: CaptureRecord,
  settings: Settings,
  hash: string,
  region: Rect,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    title: record.title,
    capturedAt: new Date(record.createdAt).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    scale: record.scale,
    version: "0.1.0",
    editRevision: record.revision,
    region,
    sha256Rgb: hash,
    hashDomain: "RGB raster pixels before provenance band; row-major",
    notice:
      "Local pixel digest, not a trusted timestamp or site authentication",
  };
  if (settings.includeUrl && record.url) {
    const url = new URL(record.url);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    if (safeUrl(url.href)) result.url = url.href;
  }
  return result;
}
export function exportRecord(
  record: CaptureRecord,
  settings: Settings,
): CaptureRecord {
  let url = "";
  if (settings.includeUrl && record.url) {
    try {
      const parsed = new URL(record.url);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      url = safeUrl(parsed.href) ?? "";
    } catch {
      /* Invalid URLs are not disclosed. */
    }
  }
  return { ...record, url };
}
async function blobOf(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob && blob.type === mime
          ? resolve(blob)
          : reject(new Error(`Canvas encoding failed: ${mime}`)),
      mime,
      quality,
    ),
  );
}
async function digest(canvas: HTMLCanvasElement): Promise<string> {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data,
    rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4) {
    rgb[j++] = rgba[i];
    rgb[j++] = rgba[i + 1];
    rgb[j++] = rgba[i + 2];
  }
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", rgb)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

export function rgbHasher() {
  const hash = sha256.create();
  return {
    update(rgba: Uint8Array | Uint8ClampedArray) {
      if (rgba.length % 4) throw new Error("Invalid RGBA pixels");
      const rgb = new Uint8Array((rgba.length / 4) * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4) {
        rgb[j++] = rgba[i];
        rgb[j++] = rgba[i + 1];
        rgb[j++] = rgba[i + 2];
      }
      hash.update(rgb);
    },
    digest() {
      return Array.from(hash.digest(), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    },
  };
}
export function rasterSide(scale: number, redactions: number): number {
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isSafeInteger(redactions) ||
    redactions < 0
  )
    throw new RangeError("Invalid raster scale or redaction count");
  const halo =
    redactions * (Math.ceil(Math.max(2, 8 * scale) * 4 + 12 * scale) + 2);
  const side = Math.min(4096, Math.floor(Math.sqrt(PIXELS)) - 2 * halo - 2);
  if (side < 1)
    throw new Error("Redaction sampling exceeds the renderer pixel limit");
  return side;
}
function regions(rect: Rect, scale: number, redactions: number): Rect[] {
  if (!Number.isFinite(scale) || scale <= 0)
    throw new RangeError("Invalid capture scale");
  const side = rasterSide(scale, redactions) / scale,
    result: Rect[] = [];
  for (let y = 0; y < rect.height; y += side)
    for (let x = 0; x < rect.width; x += side)
      result.push({
        x: rect.x + x,
        y: rect.y + y,
        width: Math.min(side, rect.width - x),
        height: Math.min(side, rect.height - y),
      });
  return result;
}
export function ownedTextBounds(rect: Rect, page: Rect): Rect | null {
  const center = rect.y + rect.height / 2;
  return center >= page.y && center < page.y + page.height
    ? intersection(rect, page)
    : null;
}
async function images(
  record: CaptureRecord,
  settings: Settings,
): Promise<ExportFile[]> {
  const parts = regions(
      getOutputRect(record),
      record.scale,
      record.edit.annotations.filter((a) => a.type === "redact").length,
    ),
    output: ExportFile[] = [],
    png = settings.format === "png" || settings.provenance;
  for (const part of parts) {
    const canvas = await renderRegion(record, part, record.scale);
    try {
      if (!png) {
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable");
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      let blob = await blobOf(
        canvas,
        png ? "image/png" : "image/jpeg",
        settings.quality,
      );
      if (settings.provenance) {
        const payload = provenancePayload(
          record,
          settings,
          await digest(canvas),
          part,
        );
        const bytes = pngWithMetadata(
          new Uint8Array(await blob.arrayBuffer()),
          { "LongCap": JSON.stringify(payload) },
        );
        blob = new Blob([bytes as BlobPart], { type: "image/png" });
      }
      const suffix =
        parts.length > 1
          ? `-x${Math.round(part.x * record.scale)}-y${Math.round(part.y * record.scale)}`
          : "";
      output.push({
        name: `${cleanFileName(record.title)}${suffix}.${png ? "png" : "jpg"}`,
        blob,
      });
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  return output;
}

async function smartBoundary(
  record: CaptureRecord,
  page: PdfPagePlan,
): Promise<number> {
  const bottom = page.region.y + page.region.height;
  const window = Math.min(page.region.height * 0.15, 150);
  if (window < 2) return bottom;
  let scale = Math.min(record.scale, 512 / page.region.width, 256 / window);
  const redactions = record.edit.annotations.filter(
    (a) => a.type === "redact",
  ).length;
  const side = rasterSide(scale, redactions);
  scale = Math.min(scale, (side - 1) / page.region.width, (side - 1) / window);
  if (
    scale <= 0 ||
    Math.round(window * scale) < 2 ||
    Math.round(page.region.width * scale) < 1
  )
    return bottom;
  const region = {
    x: 0,
    y: bottom - window,
    width: page.region.width,
    height: window,
  };
  const canvas = await renderRegion(record, region, scale);
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let best = Infinity,
      row = -1;
    for (let y = 1; y < canvas.height; y++) {
      let change = 0;
      for (let x = 0; x < canvas.width * 4; x += 4) {
        const i = y * canvas.width * 4 + x,
          previous = i - canvas.width * 4;
        change +=
          Math.abs(data[i] - data[previous]) +
          Math.abs(data[i + 1] - data[previous + 1]) +
          Math.abs(data[i + 2] - data[previous + 2]);
      }
      if (change < best) {
        best = change;
        row = y;
      }
    }
    return row >= 0 && best / canvas.width < 12
      ? region.y + row / scale
      : bottom;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function rasterLength(
  start: number,
  end: number,
  pixels: number,
  scale: number,
): number {
  let length = Math.min(end - start, pixels / scale);
  // Division and addition can round outward past an integer pixel or the output edge.
  if (Math.ceil(length * scale) > pixels || start + length > end)
    length -=
      Number.EPSILON * Math.max(Math.abs(start), Math.abs(end), length) * 4;
  return length;
}

async function pdf(
  records: CaptureRecord[],
  settings: Settings,
): Promise<ExportFile[]> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  let fonts: Awaited<ReturnType<typeof doc.embedFont>>[] = [];
  if (settings.pdfText) {
    try {
      const urls = ["assets/local-font.ttf", "assets/emoji-font.ttf"];
      for (const url of urls) {
        const response = await fetch(chrome.runtime.getURL(url));
        if (!response.ok) throw new Error(url);
        fonts.push(
          await doc.embedFont(await response.arrayBuffer(), { subset: false }),
        );
      }
    } catch (error) {
      throw new Error(`Local PDF fonts unavailable: ${String(error)}`);
    }
  }
  for (const record of records) {
    const bounds = getOutputRect(record),
      meta = sanitizedMetadata(record);
    const first = pagePlan(bounds.width, bounds.height, settings)[0];
    let y = 0;
    while (y < bounds.height) {
      const plan = {
        ...first,
        region: {
          x: 0,
          y,
          width: bounds.width,
          height: Math.min(first.region.height, bounds.height - y),
        },
      };
      if (settings.smartSplit && y + plan.region.height < bounds.height)
        plan.region.height = (await smartBoundary(record, plan)) - y;
      if (settings.pdfPaper === "one")
        plan.height = plan.region.height * plan.factor;
      const page = doc.addPage([plan.width, plan.height]);
      const pixelWidth = Math.ceil(plan.region.width * record.scale);
      const pixelHeight = Math.ceil(plan.region.height * record.scale);
      if (
        !Number.isSafeInteger(pixelWidth) ||
        !Number.isSafeInteger(pixelHeight) ||
        pixelWidth < 1 ||
        pixelHeight < 1
      )
        throw new Error("Invalid PDF raster dimensions");
      const hasher = settings.provenance ? rgbHasher() : undefined;
      const tileSide = Math.min(
        2048,
        rasterSide(
          record.scale,
          record.edit.annotations.filter((a) => a.type === "redact").length,
        ),
      );
      const rows = Math.max(
        1,
        Math.min(tileSide, Math.floor(2_000_000 / pixelWidth)),
      );
      for (let py = 0; py < pixelHeight; py += rows) {
        const bandHeight = Math.min(rows, pixelHeight - py);
        const band =
          hasher && bandHeight > 1
            ? new Uint8Array(pixelWidth * bandHeight * 4)
            : undefined;
        for (let px = 0; px < pixelWidth; px += tileSide) {
          const pixelPartWidth = Math.min(tileSide, pixelWidth - px);
          const x = px / record.scale,
            partY = y + py / record.scale;
          const part = {
            x,
            y: partY,
            width: rasterLength(
              x,
              plan.region.width,
              pixelPartWidth,
              record.scale,
            ),
            height: rasterLength(
              partY,
              Math.min(bounds.height, y + plan.region.height),
              bandHeight,
              record.scale,
            ),
          };
          const canvas = await renderRegion(record, part, record.scale);
          try {
            if (canvas.width !== pixelPartWidth || canvas.height !== bandHeight)
              throw new Error("PDF raster alignment failed");
            if (hasher) {
              const context = canvas.getContext("2d");
              if (!context) throw new Error("Canvas unavailable");
              const pixels = context.getImageData(
                0,
                0,
                canvas.width,
                canvas.height,
              ).data;
              if (band) {
                for (let row = 0; row < bandHeight; row++)
                  band.set(
                    pixels.subarray(
                      row * pixelPartWidth * 4,
                      (row + 1) * pixelPartWidth * 4,
                    ),
                    (row * pixelWidth + px) * 4,
                  );
              } else hasher.update(pixels);
            }
            const image = await doc.embedPng(
              await (
                await blobOf(canvas, "image/png", settings.quality)
              ).arrayBuffer(),
            );
            page.drawImage(image, {
              x: plan.margin + part.x * plan.factor,
              y:
                plan.height -
                plan.margin -
                (part.y - y + part.height) * plan.factor,
              width: part.width * plan.factor,
              height: part.height * plan.factor,
            });
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
        if (hasher && band) hasher.update(band);
      }
      if (hasher) {
        const payload = provenancePayload(
          record,
          settings,
          hasher.digest(),
          plan.region,
        );
        page.node.set(
          PDFName.of("LocalCaptureProvenance"),
          PDFHexString.fromText(
            JSON.stringify({ ...payload, pixelWidth, pixelHeight }),
          ),
        );
      }
      if (settings.pdfLinks && settings.includeUrl)
        for (const link of meta.links) {
          const clipped = intersection(link.rect, plan.region);
          const parsed = new URL(link.href);
          parsed.username = "";
          parsed.password = "";
          parsed.search = "";
          parsed.hash = "";
          const href = safeUrl(parsed.href);
          if (!clipped || !href) continue;
          const x = plan.margin + clipped.x * plan.factor,
            top = plan.height - plan.margin - (clipped.y - y) * plan.factor;
          const annotation = doc.context.obj({
            Type: "Annot",
            Subtype: "Link",
            Rect: [
              x,
              top - clipped.height * plan.factor,
              x + clipped.width * plan.factor,
              top,
            ],
            Border: [0, 0, 0],
            A: { Type: "Action", S: "URI", URI: PDFString.of(href) },
          });
          page.node.addAnnot(doc.context.register(annotation));
        }
      if (settings.pdfText)
        for (const run of meta.text) {
          const r = ownedTextBounds(run.rect, plan.region);
          if (!r) continue;
          const glyphs: { text: string; font: (typeof fonts)[number] }[] = [];
          for (const item of new Intl.Segmenter(undefined, {
            granularity: "grapheme",
          }).segment(run.text.replace(/[\t\n\v\f\r\u2028\u2029]/g, " "))) {
            const points = Array.from(item.segment, (c) => c.codePointAt(0)!);
            const font = fonts.find((candidate) =>
              points.every((p) => candidate.getCharacterSet().includes(p)),
            );
            if (!font)
              throw new Error(
                `Local PDF fonts do not support text: ${item.segment}`,
              );
            glyphs.push({ text: item.segment, font });
          }
          const widthAtOne = glyphs.reduce(
            (sum, glyph) => sum + glyph.font.widthOfTextAtSize(glyph.text, 1),
            0,
          );
          const ascent = Math.max(
            0,
            ...glyphs.map((glyph) =>
              glyph.font.heightAtSize(1, { descender: false }),
            ),
          );
          const descent = Math.max(
            0,
            ...glyphs.map(
              (glyph) =>
                glyph.font.heightAtSize(1) -
                glyph.font.heightAtSize(1, { descender: false }),
            ),
          );
          const size = Math.min(
            (r.height * plan.factor) / (ascent + descent || 1),
            widthAtOne
              ? (r.width * plan.factor) / widthAtOne
              : r.height * plan.factor,
          );
          let x = plan.margin + r.x * plan.factor;
          for (const glyph of glyphs) {
            page.drawText(glyph.text, {
              x,
              y:
                plan.height -
                plan.margin -
                (r.y - y + r.height) * plan.factor +
                descent * size,
              size,
              font: glyph.font,
              opacity: 0,
            });
            x += glyph.font.widthOfTextAtSize(glyph.text, size);
          }
        }
      y += plan.region.height;
    }
  }
  doc.setProducer("LongCap");
  const data = await doc.save();
  return [
    {
      name: `${cleanFileName(records.length === 1 ? records[0].title : "combined")}.pdf`,
      blob: new Blob([data as BlobPart], { type: "application/pdf" }),
    },
  ];
}

export async function exportCapture(
  record: CaptureRecord,
  settings: Settings,
): Promise<ExportFile[]> {
  validateSettings(settings);
  const local = exportRecord(record, settings);
  return settings.format === "pdf"
    ? pdf([local], settings)
    : images(local, settings);
}
export async function exportCombined(
  records: CaptureRecord[],
  settings: Settings,
): Promise<ExportFile[]> {
  validateSettings(settings);
  if (!records.length) throw new Error("No captures to export");
  const local = records.map((record) => exportRecord(record, settings));
  if (settings.format === "pdf") return pdf(local, settings);
  const files: ExportFile[] = [];
  for (const record of local) files.push(...(await images(record, settings)));
  return files;
}
