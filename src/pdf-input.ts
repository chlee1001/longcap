import {
  getDocument,
  GlobalWorkerOptions,
  PDFWorker,
  Util,
  type RenderTask,
} from "pdfjs-dist";
import {
  emptyEdit,
  type CaptureRecord,
  type Link,
  type Settings,
  type TextRun,
  type Tile,
} from "./shared/contracts.js";
import { deleteBlobs, putBlob, putCapture } from "./storage.js";
import { safeUrl, sanitizeSourceUrl } from "./geometry.js";

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.mjs");

export async function importPdf(
  blob: Blob,
  title: string,
  url: string,
  settings: Settings,
): Promise<CaptureRecord> {
  if (
    !Number.isFinite(blob.size) ||
    blob.size <= 0 ||
    blob.size > 128 * 1024 * 1024
  )
    throw new Error("PDF input exceeds size limit or is empty");
  let task: ReturnType<typeof getDocument> | undefined;
  let worker: PDFWorker | undefined;
  let render: RenderTask | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error("PDF import exceeded maximum duration"));
      render?.cancel();
    }, settings.maxDurationMs);
  });
  const wait = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([promise, deadline]);
  const checkDeadline = () => {
    if (expired) throw new Error("PDF import exceeded maximum duration");
  };
  const id = crypto.randomUUID();
  const tiles: Tile[] = [];
  const links: Link[] = [];
  const text: TextRun[] = [];
  const warnings: string[] = [];
  let width = 0,
    height = 0,
    pixels = 0,
    pagesRendered = 0;
  try {
    const data = await wait(blob.arrayBuffer());
    worker = new PDFWorker();
    task = getDocument({
      worker,
      data: new Uint8Array(data),
      cMapUrl: chrome.runtime.getURL("cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL("standard_fonts/"),
      wasmUrl: chrome.runtime.getURL("wasm/"),
      iccUrl: chrome.runtime.getURL("iccs/"),
      useSystemFonts: false,
    });
    const pdf = await wait(task.promise);
    const limit = Math.min(pdf.numPages, 400);
    for (let index = 1; index <= limit; index++) {
      const page = await wait(pdf.getPage(index));
      const viewport = page.getViewport({ scale: 1 });
      const w = Math.ceil(viewport.width),
        h = Math.ceil(viewport.height);
      if (
        !Number.isSafeInteger(w) ||
        !Number.isSafeInteger(h) ||
        w <= 0 ||
        h <= 0 ||
        pixels + w * h > 200000000
      ) {
        warnings.push(`PDF page ${index} exceeds the total pixel limit.`);
        break;
      }
      const columns = Math.ceil(w / 4000),
        rows = Math.ceil(h / 4000);
      if (tiles.length + columns * rows > settings.maxTiles) {
        warnings.push(`PDF page ${index} exceeds the tile limit.`);
        break;
      }
      for (let y = 0; y < h; y += 4000)
        for (let x = 0; x < w; x += 4000) {
          const tileWidth = Math.min(4000, w - x),
            tileHeight = Math.min(4000, h - y);
          const canvas = document.createElement("canvas");
          canvas.width = tileWidth;
          canvas.height = tileHeight;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Cannot create PDF canvas");
          render = page.render({
            canvas,
            canvasContext: context,
            viewport,
            transform: [1, 0, 0, 1, -x, -y],
            intent: "print",
          });
          await wait(render.promise);
          render = undefined;
          const png = await wait(
            new Promise<Blob>((resolve, reject) =>
              canvas.toBlob(
                (result) =>
                  result
                    ? resolve(result)
                    : reject(new Error("PDF raster encoding failed")),
                "image/png",
              ),
            ),
          );
          canvas.width = 0;
          canvas.height = 0;
          const key = `capture:${id}:${tiles.length}`;
          await putBlob(key, png);
          tiles.push({
            id: crypto.randomUUID(),
            blobKey: key,
            x,
            y: height + y,
            width: Math.min(tileWidth, viewport.width - x),
            height: Math.min(tileHeight, viewport.height - y),
            pixelWidth: tileWidth,
            pixelHeight: tileHeight,
          });
          checkDeadline();
        }
      if (settings.pdfLinks) {
        for (const annotation of await wait(page.getAnnotations())) {
          const href =
            typeof annotation.url === "string" ? safeUrl(annotation.url) : null;
          if (
            !href ||
            !Array.isArray(annotation.rect) ||
            annotation.rect.length !== 4 ||
            !annotation.rect.every(
              (value: unknown) =>
                typeof value === "number" && Number.isFinite(value),
            )
          )
            continue;
          const [x1, y1, x2, y2] = annotation.rect;
          const [a, b, c, d, e, f] = viewport.transform;
          const corners = [
            [x1, y1],
            [x1, y2],
            [x2, y1],
            [x2, y2],
          ].map(([x, y]) => ({ x: a * x + c * y + e, y: b * x + d * y + f }));
          const left = Math.min(...corners.map((point) => point.x)),
            right = Math.max(...corners.map((point) => point.x));
          const top = Math.min(...corners.map((point) => point.y)),
            bottom = Math.max(...corners.map((point) => point.y));
          links.push({
            href,
            rect: {
              x: left,
              y: height + top,
              width: right - left,
              height: bottom - top,
            },
          });
        }
      }
      if (settings.pdfText) {
        const content = await wait(page.getTextContent());
        for (const item of content.items) {
          if (!("str" in item) || !item.str || text.length >= 10000) continue;
          const matrix = Util.transform(viewport.transform, item.transform);
          const fontHeight = Math.hypot(matrix[2], matrix[3]);
          text.push({
            text: item.str,
            rect: {
              x: matrix[4],
              y: height + matrix[5] - fontHeight,
              width: item.width,
              height: fontHeight,
            },
          });
        }
      }
      width = Math.max(width, viewport.width);
      height += viewport.height;
      pixels += w * h;
      pagesRendered++;
      page.cleanup();
    }
    if (pagesRendered < pdf.numPages && !warnings.length)
      warnings.push("PDF page limit reached.");
    if (!tiles.length) throw new Error("No PDF pages could be rendered");
    checkDeadline();
    clearTimeout(timer!);
    const record: CaptureRecord = {
      id,
      title,
      url: sanitizeSourceUrl(url),
      createdAt: Date.now(),
      width,
      height,
      scale: 1,
      tiles,
      links,
      text,
      edit: emptyEdit(),
      revision: 0,
      complete: pagesRendered === pdf.numPages,
      warnings,
      source: "pdf",
    };
    await putCapture(record);
    return record;
  } catch (error) {
    await deleteBlobs(tiles.map((tile) => tile.blobKey));
    throw error;
  } finally {
    clearTimeout(timer!);
    if (expired) {
      const cleanup = task?.destroy();
      worker?.destroy();
      void cleanup?.catch(() => undefined);
    } else {
      try {
        await task?.destroy();
      } finally {
        worker?.destroy();
      }
    }
  }
}
