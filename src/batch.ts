import { safeUrl } from "./geometry.js";
import { getCapture, getJob } from "./storage.js";
import {
  callBroker,
  type CaptureJob,
  type CaptureRecord,
} from "./shared/contracts.js";

export interface BatchResult {
  url: string;
  state: "capturing" | "completed" | "failed" | "cancelled";
  capture?: CaptureRecord;
  error?: string;
}

export function parseBatchUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    if (
      /^(?:javascript|data|file|ftp|chrome|about|blob):/i.test(value) ||
      (/^[a-z][a-z\d+.-]*:/i.test(value) &&
        !/^https?:\/\//i.test(value) &&
        !/^[^/:]+:\d+(?:[/?#]|$)/.test(value))
    )
      throw new Error(`Unsupported URL: ${value}`);
    const url = safeUrl(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    );
    if (!url) throw new Error(`Invalid URL: ${value}`);
    urls.add(url);
    if (urls.size > 200)
      throw new Error("A batch can contain at most 200 URLs");
  }
  return [...urls];
}

function aborted(): DOMException {
  return new DOMException("Batch cancelled", "AbortError");
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw aborted();
}

export async function runBatchQueue(
  urls: string[],
  capture: (url: string, signal: AbortSignal) => Promise<CaptureRecord>,
  onUpdate: (result: BatchResult) => void,
  signal: AbortSignal,
): Promise<CaptureRecord[]> {
  const records: CaptureRecord[] = [];
  for (const url of urls) {
    if (signal.aborted) break;
    onUpdate({ url, state: "capturing" });
    try {
      const record = await capture(url, signal);
      if (signal.aborted) {
        onUpdate({ url, state: "cancelled" });
        break;
      }
      records.push(record);
      onUpdate({ url, state: "completed", capture: record });
    } catch (error) {
      if (signal.aborted) {
        onUpdate({ url, state: "cancelled" });
        break;
      }
      onUpdate({
        url,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return records;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(aborted());
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function navigate(
  tabId: number,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let loading = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      signal.removeEventListener("abort", cancel);
      error ? reject(error) : resolve();
    };
    const updated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tabId) return;
      if (info.status === "loading") loading = true;
      if (loading && info.status === "complete") finish();
    };
    const cancel = () => finish(aborted());
    const timer = setTimeout(
      () => finish(new Error("Page load timed out")),
      45_000,
    );
    chrome.tabs.onUpdated.addListener(updated);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    void chrome.tabs
      .update(tabId, { url, active: true })
      .catch((error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
  });
}

export async function waitForBatchJob(
  start: Promise<CaptureJob>,
  driver: {
    getJob: (id: string) => Promise<CaptureJob | undefined>;
    getCapture: (id: string) => Promise<CaptureRecord | undefined>;
    cancel: (id: string) => Promise<unknown>;
  },
  signal: AbortSignal,
): Promise<CaptureRecord> {
  const job = await start;
  let cancelPromise: Promise<unknown> | undefined;
  const cancel = () => {
    cancelPromise ??= driver.cancel(job.id);
    void cancelPromise.catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      checkAbort(signal);
      const current = await driver.getJob(job.id);
      checkAbort(signal);
      if (!current) throw new Error("Capture job disappeared");
      if (current.state === "completed") {
        if (!current.captureId)
          throw new Error("Completed capture has no result");
        const record = await driver.getCapture(current.captureId);
        checkAbort(signal);
        if (!record) throw new Error("Capture result not found");
        return record;
      }
      if (["failed", "cancelled", "interrupted"].includes(current.state))
        throw new Error(current.error || `Capture ${current.state}`);
      await wait(500, signal);
    }
    cancel();
    throw new Error("Capture timed out");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (cancelPromise) await cancelPromise;
  }
}

export async function runBatch(
  urls: string[],
  onUpdate: (result: BatchResult) => void,
  signal: AbortSignal,
): Promise<CaptureRecord[]> {
  checkAbort(signal);
  const window = await chrome.windows.create({
    url: "about:blank",
    focused: true,
    type: "normal",
  });
  if (window?.id === undefined)
    throw new Error("Could not create capture window");
  const windowId = window.id;
  try {
    checkAbort(signal);
    const tabs = await chrome.tabs.query({ windowId });
    const tabId = tabs[0]?.id;
    if (tabId === undefined) throw new Error("Could not create capture tab");
    return await runBatchQueue(
      urls,
      async (url, currentSignal) => {
        await chrome.windows.update(windowId, { focused: true });
        await navigate(tabId, url, currentSignal);
        checkAbort(currentSignal);
        return waitForBatchJob(
          callBroker<CaptureJob>("start", { tabId, mode: "page" }),
          {
            getJob,
            getCapture,
            cancel: (jobId) => callBroker("cancel", { jobId }),
          },
          currentSignal,
        );
      },
      onUpdate,
      signal,
    );
  } finally {
    await chrome.windows.remove(windowId);
  }
}
