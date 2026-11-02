import { getBlob } from "./storage.js";
import { intersection, safeUrl } from "./geometry.js";
import type {
  Annotation,
  CaptureRecord,
  Link,
  Rect,
  TextRun,
} from "./shared/contracts.js";

const BAR_HEIGHT = 48;
const MAX_PIXELS = 16_000_000;

export function redactionSamplingBounds(
  region: Rect,
  output: Rect,
  scale: number,
  count: number,
): Rect {
  const halo = count * (Math.ceil(Math.max(2, 8 * scale) * 4 + 12 * scale) + 2);
  const left = Math.max(0, Math.floor(region.x * scale) - halo);
  const top = Math.max(0, Math.floor(region.y * scale) - halo);
  const right = Math.min(
    Math.ceil(output.width * scale),
    Math.ceil((region.x + region.width) * scale) + halo,
  );
  const bottom = Math.min(
    Math.ceil(output.height * scale),
    Math.ceil((region.y + region.height) * scale) + halo,
  );
  return {
    x: left / scale,
    y: top / scale,
    width: (right - left) / scale,
    height: (bottom - top) / scale,
  };
}
export function redactionGridOrigin(
  regionStart: number,
  imageOrigin: number,
  scale: number,
): number {
  const cell = 12 * scale;
  const origin = (imageOrigin - regionStart) * scale;
  return origin + Math.floor(-origin / cell) * cell;
}
function validRect(rect: Rect): boolean {
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  );
}
function cropOf(record: CaptureRecord): Rect {
  if (![record.width, record.height].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("Invalid capture dimensions");
  const bounds = { x: 0, y: 0, width: record.width, height: record.height };
  if (!record.edit.crop) return bounds;
  if (!validRect(record.edit.crop)) throw new Error("Invalid crop");
  const crop = intersection(bounds, record.edit.crop);
  if (!crop) throw new Error("Crop does not intersect the capture");
  return crop;
}
export function getTemplateInsets(record: CaptureRecord): {
  top: number;
  bottom: number;
} {
  return {
    top:
      record.edit.template !== "none" && record.edit.template !== "barBottom"
        ? BAR_HEIGHT
        : 0,
    bottom: record.edit.template === "barBottom" ? BAR_HEIGHT : 0,
  };
}
export function getOutputRect(record: CaptureRecord): Rect {
  const crop = cropOf(record);
  const insets = getTemplateInsets(record);
  return {
    x: 0,
    y: 0,
    width: crop.width,
    height: crop.height + insets.top + insets.bottom,
  };
}
function inside(a: Rect, b: Rect): boolean {
  return (
    a.x >= b.x &&
    a.y >= b.y &&
    a.x + a.width <= b.x + b.width &&
    a.y + a.height <= b.y + b.height
  );
}
export function sanitizedMetadata(record: CaptureRecord): {
  links: Link[];
  text: TextRun[];
} {
  const crop = cropOf(record);
  const masks = record.edit.annotations
    .filter((a) => a.type === "redact")
    .map((a) => a.rect);
  if (masks.some((mask) => !validRect(mask)))
    throw new Error("Invalid redaction");
  const visible = (rect: Rect) =>
    inside(rect, crop) && !masks.some((mask) => intersection(rect, mask));
  const translate = (rect: Rect): Rect => ({
    ...rect,
    x: rect.x - crop.x,
    y: rect.y - crop.y + getTemplateInsets(record).top,
  });
  const links = record.links.flatMap((link) => {
    const href = safeUrl(link.href);
    const clipped = intersection(link.rect, crop);
    return href &&
      clipped &&
      !masks.some((mask) => intersection(link.rect, mask))
      ? [{ href, rect: translate(clipped) }]
      : [];
  });
  const text = record.text
    .filter((run) => visible(run.rect))
    .map((run) => ({ ...run, rect: translate(run.rect) }));
  const url = safeUrl(record.url);
  if (record.edit.template !== "none" && url) {
    links.push({
      href: url,
      rect: {
        x: 0,
        y: record.edit.template === "barBottom" ? crop.height : 0,
        width: crop.width,
        height: BAR_HEIGHT,
      },
    });
  }
  return { links, text };
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  return ctx;
}
function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
function pathPoints(ctx: CanvasRenderingContext2D, a: Annotation): void {
  const points = a.points?.length
    ? a.points
    : [
        { x: a.rect.x, y: a.rect.y },
        { x: a.rect.x + a.rect.width, y: a.rect.y + a.rect.height },
      ];
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}
function arrowHead(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  x: number,
  y: number,
  size: number,
): void {
  const angle = Math.atan2(y - fromY, x - fromX);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(
    x - size * Math.cos(angle - Math.PI / 6),
    y - size * Math.sin(angle - Math.PI / 6),
  );
  ctx.moveTo(x, y);
  ctx.lineTo(
    x - size * Math.cos(angle + Math.PI / 6),
    y - size * Math.sin(angle + Math.PI / 6),
  );
  ctx.stroke();
}
function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation): void {
  const r = a.rect;
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.fill;
  ctx.lineWidth = a.lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (a.type) {
    case "rect":
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.width, r.height);
      ctx.fill();
      ctx.stroke();
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(
        r.x + r.width / 2,
        r.y + r.height / 2,
        Math.abs(r.width / 2),
        Math.abs(r.height / 2),
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.stroke();
      break;
    case "line":
    case "pen":
      pathPoints(ctx, a);
      break;
    case "marker":
      ctx.globalAlpha = 0.35;
      pathPoints(ctx, a);
      break;
    case "arrow": {
      pathPoints(ctx, a);
      const points =
        a.points?.length && a.points.length >= 2
          ? a.points
          : [
              { x: r.x, y: r.y },
              { x: r.x + r.width, y: r.y + r.height },
            ];
      const first = points[0],
        second = points[1],
        last = points[points.length - 1],
        previous = points[points.length - 2];
      const size = Math.max(8, a.lineWidth * 4);
      arrowHead(ctx, previous.x, previous.y, last.x, last.y, size);
      if (a.heads === "both")
        arrowHead(ctx, second.x, second.y, first.x, first.y, size);
      break;
    }
    case "highlight":
      ctx.fillStyle = a.color;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(r.x, r.y, r.width, r.height);
      break;
    case "text": {
      const fontSize = a.fontSize ?? 16;
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillStyle = a.color;
      (a.text ?? "")
        .split("\n")
        .forEach((line, i) =>
          ctx.fillText(line, r.x, r.y + i * fontSize * 1.2),
        );
      break;
    }
    case "badge": {
      ctx.beginPath();
      ctx.ellipse(
        r.x + r.width / 2,
        r.y + r.height / 2,
        Math.abs(r.width / 2),
        Math.abs(r.height / 2),
        0,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = a.color;
      ctx.fill();
      ctx.fillStyle = a.fill;
      ctx.font = `bold ${a.fontSize ?? Math.max(1, r.height * 0.6)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        String(a.number ?? ""),
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      break;
    }
    case "redact":
      break;
  }
  ctx.restore();
}
function drawRedaction(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  crop: Rect,
  top: number,
  region: Rect,
  scale: number,
): void {
  if (!validRect(a.rect)) throw new Error("Invalid redaction");
  const mask = intersection(a.rect, crop);
  if (!mask) return;
  const output = {
    x: mask.x - crop.x,
    y: mask.y - crop.y + top,
    width: mask.width,
    height: mask.height,
  };
  const visible = intersection(output, region);
  if (!visible) return;
  const x = (visible.x - region.x) * scale;
  const y = (visible.y - region.y) * scale;
  const w = visible.width * scale,
    h = visible.height * scale;
  const copy = canvasOf(ctx.canvas.width, ctx.canvas.height);
  context(copy).drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, y, w, h);
  if (a.mode === "pixel") {
    const cell = 12 * scale;
    const gridX = redactionGridOrigin(region.x, -crop.x, scale);
    const gridY = redactionGridOrigin(region.y, top - crop.y, scale);
    const columns = Math.ceil((copy.width - gridX) / cell);
    const rows = Math.ceil((copy.height - gridY) / cell);
    if (columns * rows > MAX_PIXELS || columns > 32767 || rows > 32767)
      throw new Error("Pixel grid exceeds canvas limits");
    const small = canvasOf(columns, rows);
    context(small).drawImage(
      copy,
      -gridX / cell,
      -gridY / cell,
      copy.width / cell,
      copy.height / cell,
    );
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, gridX, gridY, columns * cell, rows * cell);
  } else {
    ctx.filter = `blur(${Math.max(2, 8 * scale)}px)`;
    ctx.drawImage(copy, 0, 0);
  }
  ctx.restore();
}
const BITMAP_CACHE_LIMIT = 12;
interface CachedTile {
  bitmap: Promise<ImageBitmap>;
  refs: number;
  evicted: boolean;
}
const bitmapCache = new Map<string, CachedTile>();
function closeTile(entry: CachedTile): void {
  void entry.bitmap.then((bitmap) => bitmap.close()).catch(() => undefined);
}
function releaseTile(entry: CachedTile): void {
  entry.refs--;
  if (entry.evicted && entry.refs <= 0) closeTile(entry);
}
function evict(key: string, entry: CachedTile): void {
  if (bitmapCache.get(key) === entry) bitmapCache.delete(key);
  entry.evicted = true;
  if (entry.refs <= 0) closeTile(entry);
}
/** Acquire a decoded tile; the caller must call release() after drawing. */
function tileBitmap(blobKey: string): CachedTile {
  let entry = bitmapCache.get(blobKey);
  if (entry) {
    bitmapCache.delete(blobKey);
  } else {
    const created: CachedTile = {
      bitmap: (async () => {
        const blob = await getBlob(blobKey);
        if (!blob) throw new Error(`Missing capture tile: ${blobKey}`);
        return createImageBitmap(blob);
      })(),
      refs: 0,
      evicted: false,
    };
    created.bitmap.catch(() => evict(blobKey, created));
    entry = created;
  }
  entry.refs++;
  bitmapCache.set(blobKey, entry);
  while (bitmapCache.size > BITMAP_CACHE_LIMIT) {
    const [oldKey, old] = bitmapCache.entries().next().value as [
      string,
      CachedTile,
    ];
    evict(oldKey, old);
  }
  return entry;
}
export function clearTileBitmaps(): void {
  for (const [key, entry] of [...bitmapCache]) evict(key, entry);
}
export async function renderRegion(
  record: CaptureRecord,
  region: Rect,
  scale: number,
): Promise<HTMLCanvasElement> {
  if (
    ![region.x, region.y, region.width, region.height, scale].every(
      Number.isFinite,
    ) ||
    region.width <= 0 ||
    region.height <= 0 ||
    scale <= 0
  )
    throw new Error("Invalid render region or scale");
  const output = getOutputRect(record);
  if (!inside(region, output)) throw new Error("Render region exceeds output");
  const requested = region;
  const redactions = record.edit.annotations.filter((a) => a.type === "redact");
  for (const annotation of redactions)
    if (!validRect(annotation.rect)) throw new Error("Invalid redaction");
  region = redactionSamplingBounds(region, output, scale, redactions.length);
  const width = Math.round(region.width * scale),
    height = Math.round(region.height * scale);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width * height > MAX_PIXELS ||
    width > 32767 ||
    height > 32767
  )
    throw new Error("Render region exceeds canvas limits");
  const canvas = canvasOf(width, height),
    ctx = context(canvas),
    crop = cropOf(record),
    top = getTemplateInsets(record).top;
  ctx.scale(scale, scale);
  ctx.translate(-region.x, -region.y);
  ctx.fillStyle = "#fff";
  ctx.fillRect(region.x, region.y, region.width, region.height);
  const contentRegion = intersection(region, {
    x: 0,
    y: top,
    width: crop.width,
    height: crop.height,
  });
  if (contentRegion) {
    const sourceRegion = {
      x: contentRegion.x + crop.x,
      y: contentRegion.y - top + crop.y,
      width: contentRegion.width,
      height: contentRegion.height,
    };
    for (const tile of record.tiles) {
      if (!validRect(tile)) throw new Error("Invalid capture tile dimensions");
      const part = intersection(tile, sourceRegion);
      if (!part) continue;
      if (
        ![tile.pixelWidth, tile.pixelHeight].every(
          (n) => Number.isSafeInteger(n) && n > 0,
        ) ||
        tile.pixelWidth * tile.pixelHeight > MAX_PIXELS
      )
        throw new Error("Decoded tile exceeds canvas limits");
      const entry = tileBitmap(tile.blobKey);
      let bitmap: ImageBitmap;
      try {
        bitmap = await entry.bitmap;
      } catch (error) {
        releaseTile(entry);
        throw error;
      }
      try {
        if (
          bitmap.width * bitmap.height > MAX_PIXELS ||
          bitmap.width !== tile.pixelWidth ||
          bitmap.height !== tile.pixelHeight
        )
          throw new Error("Invalid decoded tile dimensions");
        // Snap destination edges to whole device pixels so neighbouring tiles
        // share an exact edge (no antialiased seam at fractional zoom).
        const x0 = Math.round((part.x - crop.x - region.x) * scale),
          y0 = Math.round((part.y - crop.y + top - region.y) * scale),
          x1 = Math.round((part.x + part.width - crop.x - region.x) * scale),
          y1 = Math.round(
            (part.y + part.height - crop.y + top - region.y) * scale,
          );
        if (x1 > x0 && y1 > y0) {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          if (scale < 0.5) ctx.imageSmoothingQuality = "high";
          ctx.drawImage(
            bitmap,
            ((part.x - tile.x) * bitmap.width) / tile.width,
            ((part.y - tile.y) * bitmap.height) / tile.height,
            (part.width * bitmap.width) / tile.width,
            (part.height * bitmap.height) / tile.height,
            x0,
            y0,
            x1 - x0,
            y1 - y0,
          );
          ctx.restore();
        }
      } finally {
        releaseTile(entry);
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, crop.width, crop.height);
    ctx.clip();
    ctx.translate(-crop.x, top - crop.y);
    for (const annotation of record.edit.annotations) {
      if (annotation.type === "redact")
        drawRedaction(ctx, annotation, crop, top, region, scale);
      else drawAnnotation(ctx, annotation);
    }
    ctx.restore();
  }
  if (record.edit.template !== "none") {
    const y = record.edit.template === "barBottom" ? crop.height : 0;
    ctx.fillStyle = "#e9e9e9";
    ctx.fillRect(0, y, crop.width, BAR_HEIGHT);
    ctx.fillStyle = "#333";
    ctx.font = "14px sans-serif";
    ctx.textBaseline = "middle";
    let prefix = "";
    if (record.edit.template === "mac") prefix = "● ● ●   ";
    if (record.edit.template === "windows") prefix = "□   ";
    const url = safeUrl(record.url) ?? "";
    let date = "";
    if (
      record.edit.dateFormat !== "none" &&
      Number.isFinite(record.createdAt)
    ) {
      const value = new Date(record.createdAt);
      if (!Number.isNaN(value.getTime()))
        date =
          record.edit.dateFormat === "iso"
            ? value.toISOString()
            : record.edit.dateFormat === "date"
              ? value.toLocaleDateString()
              : value.toLocaleString();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, crop.width, BAR_HEIGHT);
    ctx.clip();
    ctx.fillText(
      [prefix + url, date].filter(Boolean).join("  "),
      10,
      y + BAR_HEIGHT / 2,
    );
    ctx.restore();
  }
  const result = canvasOf(
    Math.ceil(requested.width * scale),
    Math.ceil(requested.height * scale),
  );
  context(result).drawImage(
    canvas,
    (requested.x - region.x) * scale,
    (requested.y - region.y) * scale,
    requested.width * scale,
    requested.height * scale,
    0,
    0,
    requested.width * scale,
    requested.height * scale,
  );
  return result;
}
