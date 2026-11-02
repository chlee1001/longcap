import {
  emptyEdit,
  isRuntimeRequest,
  callBroker,
  type CaptureJob,
  type CaptureRecord,
  type ScrollerInfo,
  type Tile,
} from "./shared/contracts.js";
import {
  deleteBlobs,
  getBlob,
  getJob,
  getSettings,
  putBlob,
  putCapture,
  saveJob,
} from "./storage.js";
import { planTiles, sanitizeSourceUrl } from "./geometry.js";
import { importPdf } from "./pdf-input.js";

interface Running {
  job: CaptureJob;
  paused: boolean;
  cancelled: boolean;
  wake?: () => void;
  pauseDone?: Promise<void>;
  pauseResolve?: () => void;
  pauseReject?: (error: Error) => void;
}
type MappedInfo = ScrollerInfo & { frameMatrix: number[] };
const running = new Map<string, Running>();
let processing = false;
const extensionRoot = chrome.runtime.getURL("/");

async function command<T>(jobId: string, command: string, data?: unknown) {
  return callBroker<T>("content", { jobId, command, data }, jobId);
}
async function save(run: Running, state?: CaptureJob["state"]) {
  if (state) run.job.state = state;
  run.job.updatedAt = Date.now();
  await saveJob(run.job);
}
async function runCapture(run: Running) {
  const { job } = run;
  let tiles: Tile[] = [];
  let captured = 0;
  let chromeTop: Tile | undefined;
  let chromeBottom: Tile | undefined;
  const chromeSides: Tile[] = [];
  const scratch: string[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let prepared = false;
  let committed = false;
  try {
    const settings = await getSettings();
    const prepare = async () => {
      try {
        const info = await command<ScrollerInfo>(job.id, "prepare", {
          mode: job.mode,
          token: job.token,
          imageWaitMs: settings.imageWaitMs,
        });
        prepared = true;
        return info;
      } catch (error) {
        if (run.paused || run.cancelled) return undefined;
        throw error;
      }
    };
    const pause = async () => {
      while (run.paused && !run.cancelled) {
        if (prepared) {
          await command(job.id, "restore");
          prepared = false;
        }
        await save(run, "paused");
        run.pauseResolve?.();
        run.pauseResolve = undefined;
        run.pauseReject = undefined;
        if (run.paused && !run.cancelled)
          await new Promise<void>((resolve) => {
            run.wake = resolve;
          });
      }
    };
    let initial: ScrollerInfo;
    for (;;) {
      if (run.cancelled) {
        await save(run, "cancelled");
        return;
      }
      await pause();
      if (run.cancelled) {
        await save(run, "cancelled");
        return;
      }
      const result = await prepare();
      if (!result || run.paused || run.cancelled) continue;
      initial = result;
      break;
    }
    if (
      ![
        initial.width,
        initial.height,
        initial.viewport.width,
        initial.viewport.height,
        initial.windowWidth,
        initial.windowHeight,
      ].every((value) => Number.isFinite(value) && value > 0)
    )
      throw new Error("Invalid capture geometry");
    const plan = planTiles(
      initial.width,
      initial.height,
      initial.viewport.width,
      initial.viewport.height,
      settings.maxTiles,
    );
    const links = new Map(
      initial.links.map((link) => [JSON.stringify(link), link]),
    );
    const text = new Map(initial.text.map((run) => [JSON.stringify(run), run]));
    job.total = plan.tiles.length;
    job.warnings.push(...initial.warnings);
    if (!plan.complete) job.warnings.push("Maximum tile count reached.");
    if (!run.paused && !run.cancelled) await save(run, "capturing");
    heartbeat = setInterval(() => {
      if (!run.paused && !run.cancelled && prepared)
        void command(job.id, "heartbeat").catch(() => undefined);
    }, 2000);
    const started = Date.now();
    let scale = 1;
    for (let index = 0; index < plan.tiles.length; index++) {
      if (run.cancelled) break;
      if (run.paused) {
        await pause();
        if (run.cancelled) break;
        const resumed = await prepare();
        if (!resumed || run.paused || run.cancelled) {
          index--;
          continue;
        }
        if (
          resumed.width !== initial.width ||
          resumed.height !== initial.height ||
          resumed.viewport.width !== initial.viewport.width ||
          resumed.viewport.height !== initial.viewport.height
        )
          throw new Error("Layout changed while paused");
        await save(run, "capturing");
      }
      if (Date.now() - started > settings.maxDurationMs) {
        job.warnings.push("Maximum capture duration reached.");
        break;
      }
      const tile = plan.tiles[index];
      let current: MappedInfo;
      try {
        current = await command<MappedInfo>(job.id, "scroll", {
          x: tile.scrollX,
          y: tile.scrollY,
          hideFixed: index > 0,
        });
      } catch (error) {
        if (run.paused || run.cancelled) {
          index--;
          continue;
        }
        throw error;
      }
      if (run.paused || run.cancelled) {
        index--;
        continue;
      }
      if (
        current.width !== initial.width ||
        current.height < initial.height ||
        current.viewport.width !== initial.viewport.width ||
        current.viewport.height !== initial.viewport.height
      ) {
        job.warnings.push("Page layout changed during capture.");
        break;
      }
      if (current.height > initial.height) {
        const oldHeight = initial.height;
        const remaining = settings.maxTiles - plan.tiles.length;
        if (remaining <= 0) {
          plan.complete = false;
          job.warnings.push("Page grew beyond the maximum tile count.");
        } else {
          const extra = planTiles(
            initial.width,
            current.height - oldHeight,
            initial.viewport.width,
            initial.viewport.height,
            remaining,
          );
          for (const added of extra.tiles)
            plan.tiles.push({
              ...added,
              y: added.y + oldHeight,
              scrollY: Math.min(
                added.y + oldHeight,
                Math.max(0, current.height - initial.viewport.height),
              ),
            });
          if (!extra.complete) {
            plan.complete = false;
            job.warnings.push("Page grew beyond the maximum tile count.");
          }
          job.total = plan.tiles.length;
        }
        initial.height = current.height;
      }
      for (const link of current.links)
        if (links.size < 5000) links.set(JSON.stringify(link), link);
      for (const run of current.text)
        if (text.size < 10000) text.set(JSON.stringify(run), run);
      if (run.paused || run.cancelled) {
        index--;
        continue;
      }
      let shot: { blobKey: string };
      try {
        shot = await callBroker<{ blobKey: string }>(
          "shot",
          { jobId: job.id, seq: index },
          job.id,
        );
      } catch (error) {
        if (run.paused || run.cancelled) {
          index--;
          continue;
        }
        throw error;
      }
      scratch.push(shot.blobKey);
      if (run.paused || run.cancelled) {
        await deleteBlobs([shot.blobKey]);
        scratch.pop();
        index--;
        continue;
      }
      const blob = await getBlob(shot.blobKey);
      if (!blob) throw new Error("Screenshot data is missing");
      const header = await blob.slice(0, 24).arrayBuffer();
      if (header.byteLength !== 24) throw new Error("Invalid screenshot");
      const view = new DataView(header);
      if (
        view.getUint32(0) !== 0x89504e47 ||
        view.getUint32(4) !== 0x0d0a1a0a ||
        view.getUint32(12) !== 0x49484452 ||
        view.getUint32(16) * view.getUint32(20) * 4 > 128 * 1024 * 1024
      )
        throw new Error(
          "Screenshot exceeds decoded memory limit or has invalid PNG data",
        );
      const bitmap = await createImageBitmap(blob);
      try {
        if (bitmap.width * bitmap.height * 4 > 128 * 1024 * 1024)
          throw new Error("Screenshot exceeds decoded memory limit");
        const sx = bitmap.width / current.windowWidth,
          sy = bitmap.height / current.windowHeight;
        scale = sx;
        if (
          !Array.isArray(current.frameMatrix) ||
          current.frameMatrix.length !== 6 ||
          !current.frameMatrix.every(Number.isFinite)
        )
          throw new Error("Invalid frame mapping");
        const matrix = new DOMMatrix(current.frameMatrix);
        const crop = async (
          local: { x: number; y: number; width: number; height: number },
          place: { x: number; y: number; width: number; height: number },
          key: string,
        ): Promise<Tile> => {
          const corners = [
            [local.x, local.y],
            [local.x + local.width, local.y],
            [local.x, local.y + local.height],
            [local.x + local.width, local.y + local.height],
          ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
          const pixelWidth = Math.ceil(
            local.width * Math.hypot(matrix.a * sx, matrix.b * sy),
          );
          const pixelHeight = Math.ceil(
            local.height * Math.hypot(matrix.c * sx, matrix.d * sy),
          );
          if (
            corners.some(
              (point) =>
                point.x < -1 ||
                point.y < -1 ||
                point.x > current.windowWidth + 1 ||
                point.y > current.windowHeight + 1,
            ) ||
            pixelWidth * pixelHeight > 16000000 ||
            pixelWidth > 32767 ||
            pixelHeight > 32767 ||
            !pixelWidth ||
            !pixelHeight
          )
            throw new Error("Tile exceeds visible screenshot or raster limit");
          const canvas = new OffscreenCanvas(pixelWidth, pixelHeight);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Cannot create screenshot canvas");
          const transform = new DOMMatrix()
            .scale(pixelWidth / local.width, pixelHeight / local.height)
            .translate(-local.x, -local.y)
            .multiply(matrix.inverse())
            .scale(1 / sx, 1 / sy);
          if (
            ![
              transform.a,
              transform.b,
              transform.c,
              transform.d,
              transform.e,
              transform.f,
            ].every(Number.isFinite)
          )
            throw new Error("Frame transform is singular");
          context.setTransform(transform);
          context.drawImage(bitmap, 0, 0);
          const png = await canvas.convertToBlob({ type: "image/png" });
          canvas.width = 0;
          canvas.height = 0;
          const blobKey = `capture:${job.id}:${key}`;
          await putBlob(blobKey, png);
          return {
            id: crypto.randomUUID(),
            blobKey,
            ...place,
            pixelWidth,
            pixelHeight,
          };
        };
        if (initial.embedded && index === 0) {
          const v = current.viewport;
          const top = v.y + v.height;
          chromeTop = await crop(
            { x: 0, y: 0, width: current.windowWidth, height: top },
            { x: 0, y: 0, width: current.windowWidth, height: top },
            "chrome-top",
          );
          tiles.push(chromeTop);
          // Beside the scroller the page does not grow; continue the last
          // device-pixel row there (column borders, backgrounds) down the
          // extra scrolled height, sized when the capture finishes.
          const row = 1 / sy;
          for (const [x, width] of [
            [0, v.x],
            [v.x + v.width, current.windowWidth - v.x - v.width],
          ])
            if (width > 0.5) {
              const side = await crop(
                { x, y: top - row, width, height: row },
                { x, y: top, width, height: row },
                `chrome-side-${chromeSides.length}`,
              );
              chromeSides.push(side);
              tiles.push(side);
            }
          if (current.windowHeight - top > 0.5) {
            const strip = {
              x: 0,
              y: top,
              width: current.windowWidth,
              height: current.windowHeight - top,
            };
            chromeBottom = await crop(strip, strip, "chrome-bottom");
            tiles.push(chromeBottom);
          }
        }
        tiles.push(
          await crop(
            {
              x:
                current.viewport.x +
                (tile.x - current.scrollX) * current.scaleX,
              y:
                current.viewport.y +
                (tile.y - current.scrollY) * current.scaleY,
              width: tile.width * current.scaleX,
              height: tile.height * current.scaleY,
            },
            { x: tile.x, y: tile.y, width: tile.width, height: tile.height },
            String(index),
          ),
        );
        captured++;
      } finally {
        bitmap.close();
        await deleteBlobs([shot.blobKey]);
        scratch.pop();
      }
      job.completed = captured;
      await save(run);
    }
    if (run.cancelled) {
      await save(run, "cancelled");
      return;
    }
    if (!tiles.length) throw new Error("No screenshot tiles were captured");
    while (run.paused) {
      await pause();
      if (run.cancelled) {
        await save(run, "cancelled");
        return;
      }
      const resumed = await prepare();
      if (!resumed || run.paused || run.cancelled) continue;
      if (
        resumed.width !== initial.width ||
        resumed.height !== initial.height ||
        resumed.viewport.width !== initial.viewport.width ||
        resumed.viewport.height !== initial.viewport.height
      )
        throw new Error("Layout changed while paused");
    }
    if (run.cancelled) {
      await save(run, "cancelled");
      return;
    }
    await save(run, "composing");
    let width = initial.width;
    let height = initial.height;
    let linkList = [...links.values()];
    let textList = [...text.values()];
    if (initial.embedded && chromeTop) {
      // Place the scroller content inside the window chrome captured from the
      // first screenshot; the area below the scroller moves down by the extra
      // scrolled height.
      const v = initial.viewport;
      const extra = Math.max(0, initial.height - v.height);
      const shift = <T extends { x: number; y: number }>(rect: T): T => ({
        ...rect,
        x: rect.x + v.x,
        y: rect.y + v.y,
      });
      const chrome = new Set<Tile>([chromeTop, ...chromeSides]);
      if (chromeBottom) chrome.add(chromeBottom);
      for (let i = 0; i < tiles.length; i++)
        if (!chrome.has(tiles[i])) tiles[i] = shift(tiles[i]);
      if (chromeBottom) chromeBottom.y += extra;
      for (const side of chromeSides) side.height = extra;
      if (extra <= 0) {
        await deleteBlobs(chromeSides.map((side) => side.blobKey));
        tiles = tiles.filter((tile) => !chromeSides.includes(tile));
      }
      linkList = linkList.map((link) => ({ ...link, rect: shift(link.rect) }));
      textList = textList.map((run) => ({ ...run, rect: shift(run.rect) }));
      width = initial.windowWidth;
      height = initial.windowHeight + extra;
    }
    const record: CaptureRecord = {
      id: job.id,
      title: initial.title,
      url: sanitizeSourceUrl(initial.url),
      createdAt: Date.now(),
      width,
      height,
      scale,
      tiles,
      links: linkList,
      text: textList,
      edit: emptyEdit(),
      revision: 0,
      complete:
        plan.complete &&
        captured === plan.tiles.length &&
        job.warnings.length === 0,
      warnings: [...job.warnings],
      source: job.mode === "element" ? "element" : "page",
    };
    await putCapture(record);
    committed = true;
    job.captureId = record.id;
    await save(run, "completed");
  } catch (error) {
    job.error = error instanceof Error ? error.message : String(error);
    await save(run, run.cancelled ? "cancelled" : "failed");
  } finally {
    run.pauseReject?.(new Error("Capture stopped before pausing"));
    if (heartbeat) clearInterval(heartbeat);
    try {
      if (prepared) await command(job.id, "restore").catch(() => undefined);
      await deleteBlobs(scratch);
      if (!committed) await deleteBlobs(tiles.map((tile) => tile.blobKey));
    } finally {
      running.delete(job.id);
      processing = false;
    }
  }
}
function payloadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid payload");
  return value as Record<string, unknown>;
}
async function dispatch(type: string, value: unknown) {
  const payload = payloadObject(value);
  if (type === "import-pdf") {
    if (
      typeof payload.blobKey !== "string" ||
      typeof payload.title !== "string" ||
      typeof payload.url !== "string"
    )
      throw new Error("Invalid PDF input");
    if (processing) throw new Error("Another capture or PDF import is active");
    processing = true;
    try {
      const blob = await getBlob(payload.blobKey);
      if (!blob) throw new Error("PDF input is missing");
      return await importPdf(
        blob,
        payload.title,
        payload.url,
        await getSettings(),
      );
    } finally {
      processing = false;
    }
  }
  if (typeof payload.jobId !== "string")
    throw new Error("Invalid job identifier");
  const jobId = payload.jobId;
  if (type === "start") {
    if (processing) throw new Error("Another capture or PDF import is active");
    processing = true;
    try {
      const job = await getJob(jobId);
      if (!job || job.state !== "preparing")
        throw new Error("Invalid capture job");
      const run: Running = { job, paused: false, cancelled: false };
      running.set(jobId, run);
      void runCapture(run);
      return job;
    } catch (error) {
      processing = false;
      throw error;
    }
  }
  const run = running.get(jobId);
  if (!run) throw new Error("Capture is not running");
  if (type === "pause") {
    if (run.job.state === "composing") throw new Error("Capture is finishing");
    if (run.paused) throw new Error("Capture is already paused");
    run.paused = true;
    run.pauseDone = new Promise<void>((resolve, reject) => {
      run.pauseResolve = resolve;
      run.pauseReject = reject;
    });
    await run.pauseDone;
  } else if (type === "resume") {
    if (!run.paused) throw new Error("Capture is not paused");
    await run.pauseDone;
    run.paused = false;
    run.wake?.();
  } else if (type === "cancel") {
    if (run.job.state === "composing") throw new Error("Capture is finishing");
    run.cancelled = true;
    run.paused = false;
    run.wake?.();
    await save(run, "cancelled");
  } else throw new Error("Unknown host command");
  return run.job;
}
chrome.runtime.onMessage.addListener((request: unknown, sender, respond) => {
  if (!isRuntimeRequest(request) || request.target !== "host") return;
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== `${extensionRoot}background.js` ||
    sender.tab
  ) {
    respond({ ok: false, error: "Unauthorized sender" });
    return;
  }
  void dispatch(request.type, request.payload).then(
    (result) => respond({ ok: true, value: result }),
    (error) =>
      respond({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
  return true;
});
