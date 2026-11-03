import {
  isRuntimeRequest,
  makeRequest,
  type CaptureJob,
  type RuntimeReply,
  type RuntimeRequest,
} from "./shared/contracts.js";
import { deleteBlobs, getJob, listJobs, putBlob, saveJob } from "./storage.js";
import { safeUrl } from "./geometry.js";
import {
  assertFrameChain,
  multiplyFrames,
  type FrameLink,
  type FrameStep,
} from "./frame-geometry.js";

const extensionRoot = chrome.runtime.getURL("/");
const live = new Set(["preparing", "capturing", "paused", "composing"]);
const epochs = new Map<number, number>();
const picks = new Map<string, { tabId: number; windowId: number }>();
const frameSnapshots = new Map<string, string>();
let offscreenPromise: Promise<void> | undefined;
let lastShot = 0;
let shotQueue: Promise<unknown> = Promise.resolve();
let startQueue: Promise<unknown> = Promise.resolve();

chrome.tabs.onActivated.addListener(({ windowId }) =>
  epochs.set(windowId, (epochs.get(windowId) ?? 0) + 1),
);

async function ensureHost() {
  if (!offscreenPromise)
    offscreenPromise = (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [chrome.runtime.getURL("offscreen.html")],
      });
      if (!contexts.length) {
        for (const job of await listJobs()) {
          if (live.has(job.state)) {
            job.state = "interrupted";
            job.error = "Capture host was closed";
            job.updatedAt = Date.now();
            await saveJob(job);
          }
        }
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: [
            chrome.offscreen.Reason.BLOBS,
            chrome.offscreen.Reason.WORKERS,
          ],
          justification: "Process local screenshots and PDF files.",
        });
      }
    })().finally(() => {
      offscreenPromise = undefined;
    });
  await offscreenPromise;
}

async function host(type: string, payload?: unknown, jobId?: string) {
  await ensureHost();
  const reply = (await chrome.runtime.sendMessage(
    makeRequest("host", type, payload, jobId),
  )) as RuntimeReply;
  if (!reply?.ok)
    throw new Error(reply?.error || "Capture host did not respond");
  return reply.value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid payload");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512)
    throw new Error("Invalid identifier");
  return value;
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("Invalid numeric identifier");
  return value as number;
}
async function documentId(tabId: number, frameId: number) {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
  if (!frame?.documentId) throw new Error("Cannot determine target document");
  return frame.documentId;
}
async function verify(job: CaptureJob) {
  const [tab] = await chrome.tabs.query({
    active: true,
    windowId: job.windowId,
  });
  if (
    tab?.id !== job.tabId ||
    (await documentId(job.tabId, job.frameId)) !== job.documentId
  )
    throw new Error("Target tab or document changed");
}
async function content<T>(
  tabId: number,
  docId: string,
  command: string,
  data?: unknown,
): Promise<T> {
  const reply = (await chrome.tabs.sendMessage(
    tabId,
    { channel: "local-capture", command, data },
    { documentId: docId },
  )) as RuntimeReply<T>;
  if (!reply?.ok)
    throw new Error(reply?.error || "Content script did not respond");
  return reply.value as T;
}
async function frameMapping(job: CaptureJob) {
  await verify(job);
  const frames = await chrome.webNavigation.getAllFrames({ tabId: job.tabId });
  if (!frames) throw new Error("Frame chain unavailable");
  const target = frames.find(
    (item) =>
      item.frameId === job.frameId && item.documentId === job.documentId,
  );
  if (!target) throw new Error("Target frame changed");
  let frame: chrome.webNavigation.GetAllFrameResultDetails = target;
  let matrix = [1, 0, 0, 1, 0, 0];
  let width = 0,
    height = 0;
  const observed: unknown[] = [];
  const visited = new Set<number>();
  while (frame.frameId !== 0) {
    if (visited.has(frame.frameId) || visited.size >= 100)
      throw new Error("Invalid frame chain");
    visited.add(frame.frameId);
    const child: chrome.webNavigation.GetAllFrameResultDetails = frame;
    const parent: chrome.webNavigation.GetAllFrameResultDetails | undefined =
      frames.find((item) => item.frameId === child.parentFrameId);
    if (!parent?.documentId || !child.documentId)
      throw new Error("Frame parent unavailable");
    const link = await content<FrameLink>(
      job.tabId,
      child.documentId,
      "frame-link",
    );
    const step = await content<FrameStep>(
      job.tabId,
      parent.documentId,
      "frame-geometry",
      link,
    );
    const linkAfter = await content<FrameLink>(
      job.tabId,
      child.documentId,
      "frame-link",
    );
    const stepAfter = await content<FrameStep>(
      job.tabId,
      parent.documentId,
      "frame-geometry",
      linkAfter,
    );
    if (
      JSON.stringify(link) !== JSON.stringify(linkAfter) ||
      JSON.stringify(step) !== JSON.stringify(stepAfter)
    )
      throw new Error("Frame geometry changed");
    const currentChild = await chrome.webNavigation.getFrame({
      tabId: job.tabId,
      frameId: child.frameId,
    });
    const currentParent = await chrome.webNavigation.getFrame({
      tabId: job.tabId,
      frameId: parent.frameId,
    });
    assertFrameChain(
      currentChild,
      currentParent,
      child.documentId,
      parent.frameId,
      parent.documentId,
    );
    observed.push([
      child.frameId,
      child.documentId,
      parent.frameId,
      parent.documentId,
      link,
      step,
    ]);
    matrix = multiplyFrames(step.matrix, matrix);
    width = step.width;
    height = step.height;
    frame = parent;
  }
  await verify(job);
  return { matrix, width, height, snapshot: JSON.stringify(observed) };
}
async function inject(tabId: number, frameId = 0) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ["content.js"],
  });
}
async function startCapture(
  payload: Record<string, unknown>,
  requestId: string,
) {
  const tabId = number(payload.tabId);
  if (payload.mode !== "page" && payload.mode !== "element")
    throw new Error("Invalid capture mode");
  const frameId = payload.frameId === undefined ? 0 : number(payload.frameId);
  const token = payload.mode === "element" ? id(payload.token) : undefined;
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId === undefined)
    throw new Error("Target window is unavailable");
  const job: CaptureJob = {
    id: crypto.randomUUID(),
    requestId,
    tabId,
    windowId: tab.windowId,
    documentId: await documentId(tabId, frameId),
    mode: payload.mode,
    frameId,
    token,
    state: "preparing",
    completed: 0,
    total: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    warnings: [],
  };
  await verify(job);
  await ensureHost();
  const jobs = await listJobs();
  if (jobs.some((existing) => live.has(existing.state)))
    throw new Error("Another capture is already active");
  if (frameId !== 0) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    let parent = frames?.find(
      (frame) => frame.frameId === frameId,
    )?.parentFrameId;
    const seen = new Set<number>();
    while (parent !== undefined && parent >= 0) {
      if (seen.has(parent) || seen.size >= 100)
        throw new Error("Invalid frame chain");
      seen.add(parent);
      await inject(tabId, parent);
      parent = frames?.find((frame) => frame.frameId === parent)?.parentFrameId;
    }
  }
  await inject(tabId, frameId);
  await saveJob(job);
  try {
    await host("start", { jobId: job.id }, job.id);
  } catch (error) {
    job.state = "failed";
    job.error = String(error);
    job.updatedAt = Date.now();
    await saveJob(job);
    throw error;
  }
  return job;
}
async function openResultWhenDone(job: CaptureJob): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const current = await getJob(job.id);
    if (!current) return;
    if (current.state === "completed" && current.captureId) {
      let index: number | undefined;
      try {
        index = (await chrome.tabs.get(current.tabId)).index + 1;
      } catch {
        index = undefined;
      }
      await chrome.tabs.create({
        url: chrome.runtime.getURL(
          `app.html#capture=${encodeURIComponent(current.captureId)}`,
        ),
        index,
      });
      return;
    }
    if (!live.has(current.state)) return;
  }
}
function start(payload: Record<string, unknown>, requestId: string) {
  const result = startQueue.then(async () => {
    const job = await startCapture(payload, requestId);
    void openResultWhenDone(job).catch(console.error);
    return job;
  });
  startQueue = result.catch(() => undefined);
  return result;
}
async function pick(payload: Record<string, unknown>) {
  const tabId = number(payload.tabId);
  const tab = await chrome.tabs.get(tabId);
  const [active] = await chrome.tabs.query({
    active: true,
    windowId: tab.windowId,
  });
  if (active?.id !== tabId) throw new Error("Target tab is not active");
  const token = crypto.randomUUID();
  picks.set(token, { tabId, windowId: tab.windowId });
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  let installed = 0;
  for (const frame of frames ?? []) {
    try {
      await inject(tabId, frame.frameId);
      const reply = (await chrome.tabs.sendMessage(
        tabId,
        { channel: "local-capture", command: "pick", data: { token } },
        { documentId: frame.documentId },
      )) as RuntimeReply;
      if (reply?.ok) installed++;
    } catch {
      /* Frames without host permission cannot be injected. */
    }
  }
  if (!installed) {
    picks.delete(token);
    throw new Error("Picker could not be installed");
  }
  setTimeout(() => picks.delete(token), 30000);
  return { token };
}
async function shot(job: CaptureJob, seq: number) {
  const operation = async () => {
    const deadline = Date.now() + 5000;
    let failure: unknown;
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
      try {
        const wait = 550 - (Date.now() - lastShot);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const current = await getJob(job.id);
        if (!current || current.state !== "capturing")
          throw new Error("Capture is no longer active");
        await verify(current);
        if (
          current.frameId !== 0 &&
          (await frameMapping(current)).snapshot !==
            frameSnapshots.get(current.id)
        )
          throw new Error("Frame geometry changed before screenshot");
        const epoch = epochs.get(current.windowId) ?? 0;
        lastShot = Date.now();
        const dataUrl = await chrome.tabs.captureVisibleTab(current.windowId, {
          format: "png",
        });
        await verify(current);
        if (
          current.frameId !== 0 &&
          (await frameMapping(current)).snapshot !==
            frameSnapshots.get(current.id)
        )
          throw new Error("Frame geometry changed during screenshot");
        const after = await getJob(job.id);
        if (
          !after ||
          after.state !== "capturing" ||
          epoch !== (epochs.get(current.windowId) ?? 0)
        )
          throw new Error("Target changed during capture");
        const blob = await (await fetch(dataUrl)).blob();
        const blobKey = `shot:${job.id}:${seq}`;
        await putBlob(blobKey, blob);
        return { blobKey };
      } catch (error) {
        failure = error;
      }
    }
    throw failure instanceof Error ? failure : new Error("Screenshot failed");
  };
  const result = shotQueue.then(operation, operation);
  shotQueue = result.catch(() => undefined);
  return result;
}
async function dispatch(
  request: RuntimeRequest,
  sender: chrome.runtime.MessageSender,
) {
  const payload = object(request.payload ?? {});
  const isExtensionPage =
    sender.id === chrome.runtime.id &&
    !!sender.url &&
    sender.url.startsWith(extensionRoot);
  const isHost =
    isExtensionPage &&
    new URL(sender.url!).pathname.endsWith("/offscreen.html");
  if (
    request.type === "picked" ||
    request.type === "pick-error" ||
    request.type === "picked-frame"
  ) {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab?.id === undefined ||
      sender.frameId === undefined ||
      !sender.documentId
    )
      throw new Error("Invalid picker sender");
    const token = id(payload.token);
    const pending = picks.get(token);
    if (
      !pending ||
      pending.tabId !== sender.tab.id ||
      (await documentId(pending.tabId, sender.frameId)) !== sender.documentId
    )
      throw new Error("Expired picker selection");
    picks.delete(token);
    let selectedFrameId = sender.frameId;
    let selectedDocumentId = sender.documentId;
    let pickError =
      request.type === "pick-error"
        ? typeof payload.error === "string"
          ? payload.error.slice(0, 512)
          : "Selection failed"
        : "";
    if (request.type === "picked-frame") {
      try {
        const index = number(payload.index);
        await content(pending.tabId, sender.documentId, "check-picked-frame", {
          token,
          index,
        });
        const frames = await chrome.webNavigation.getAllFrames({
          tabId: pending.tabId,
        });
        const children =
          frames?.filter(
            (frame) =>
              frame.parentFrameId === sender.frameId && frame.documentId,
          ) ?? [];
        let match: (typeof children)[number] | undefined;
        for (const child of children) {
          try {
            const link = await content<FrameLink>(
              pending.tabId,
              child.documentId!,
              "frame-link",
            );
            if (link.index === index) {
              if (match) throw new Error("Ambiguous frame index");
              match = child;
            }
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "Ambiguous frame index"
            )
              throw error;
          }
        }
        if (!match?.documentId)
          throw new Error("Frame is inaccessible or lacks host permission");
        await content(pending.tabId, match.documentId, "select-frame", {
          token,
        });
        const link = await content<FrameLink>(
          pending.tabId,
          match.documentId,
          "frame-link",
        );
        await content(pending.tabId, sender.documentId, "check-picked-frame", {
          token,
          index,
        });
        const child = await chrome.webNavigation.getFrame({
          tabId: pending.tabId,
          frameId: match.frameId,
        });
        const parent = await chrome.webNavigation.getFrame({
          tabId: pending.tabId,
          frameId: sender.frameId,
        });
        assertFrameChain(
          child,
          parent,
          match.documentId,
          sender.frameId,
          sender.documentId,
        );
        if (link.index !== index)
          throw new Error("Frame order changed during selection");
        selectedFrameId = match.frameId;
        selectedDocumentId = match.documentId;
      } catch (error) {
        pickError = error instanceof Error ? error.message : String(error);
      }
    }
    for (const frame of (await chrome.webNavigation.getAllFrames({
      tabId: pending.tabId,
    })) ?? []) {
      void chrome.tabs
        .sendMessage(
          pending.tabId,
          { channel: "local-capture", command: "cancel-pick" },
          { documentId: frame.documentId },
        )
        .catch(() => undefined);
    }
    if (pickError) {
      const now = Date.now();
      const job: CaptureJob = {
        id: crypto.randomUUID(),
        requestId: request.requestId,
        tabId: pending.tabId,
        windowId: pending.windowId,
        documentId: selectedDocumentId,
        frameId: selectedFrameId,
        mode: "element",
        state: "failed",
        completed: 0,
        total: 0,
        createdAt: now,
        updatedAt: now,
        error: pickError.slice(0, 512),
        warnings: [],
      };
      await saveJob(job);
      return job;
    }
    return start(
      {
        tabId: pending.tabId,
        mode: "element",
        frameId: selectedFrameId,
        token,
      },
      request.requestId,
    );
  }
  if (!isExtensionPage) throw new Error("Unauthorized sender");
  switch (request.type) {
    case "start":
      return start(payload, request.requestId);
    case "pick":
      return pick(payload);
    case "status":
      await ensureHost();
      return (
        (await listJobs()).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
      );
    case "pause":
    case "resume":
    case "cancel": {
      const jobId = id(payload.jobId);
      if (!(await getJob(jobId))) throw new Error("Unknown job");
      return host(request.type, { jobId }, jobId);
    }
    case "content": {
      if (!isHost) throw new Error("Unauthorized sender");
      const job = await getJob(id(payload.jobId));
      const command = id(payload.command);
      if (
        !["prepare", "info", "scroll", "restore", "heartbeat"].includes(command)
      )
        throw new Error("Invalid content command");
      if (!job || (!live.has(job.state) && command !== "restore"))
        throw new Error("Inactive job");
      if (command === "restore") {
        frameSnapshots.delete(job.id);
        const frame = await chrome.webNavigation.getFrame({
          tabId: job.tabId,
          frameId: job.frameId,
        });
        if (!frame || frame.documentId !== job.documentId) return null;
      } else await verify(job);
      const value = await content<unknown>(
        job.tabId,
        job.documentId,
        command,
        payload.data,
      );
      if (
        job.frameId !== 0 &&
        ["prepare", "info", "scroll"].includes(command)
      ) {
        const mapping = await frameMapping(job);
        frameSnapshots.set(job.id, mapping.snapshot);
        return {
          ...object(value),
          frameMatrix: mapping.matrix,
          windowWidth: mapping.width,
          windowHeight: mapping.height,
        };
      }
      return value;
    }
    case "shot": {
      if (!isHost) throw new Error("Unauthorized sender");
      const job = await getJob(id(payload.jobId));
      if (!job) throw new Error("Unknown job");
      return shot(job, number(payload.seq));
    }
    case "import-pdf": {
      const title = id(payload.title);
      const url = typeof payload.url === "string" ? payload.url : "";
      if (payload.blobKey !== undefined)
        return host("import-pdf", { blobKey: id(payload.blobKey), title, url });
      const safe = safeUrl(url);
      if (!safe) throw new Error("Invalid PDF URL");
      const parsed = new URL(safe);
      if (
        !(await chrome.permissions.contains({
          origins: [`${parsed.origin}/*`],
        }))
      )
        throw new Error("PDF origin permission is required");
      const response = await fetch(safe, {
        credentials: "include",
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(`PDF request failed (${response.status})`);
      const maxBytes = 128 * 1024 * 1024;
      const length = Number(response.headers.get("content-length"));
      if (length > maxBytes)
        throw new Error("PDF exceeds the input size limit");
      if (!response.body) throw new Error("PDF response has no body");
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new Error("PDF exceeds the input size limit");
          }
          chunks.push(new Uint8Array(part.value));
        }
      } finally {
        reader.releaseLock();
      }
      const blob = new Blob(chunks, { type: "application/pdf" });
      const blobKey = `pdf-input:${crypto.randomUUID()}`;
      await putBlob(blobKey, blob);
      try {
        return await host("import-pdf", { blobKey, title, url: safe });
      } finally {
        await deleteBlobs([blobKey]);
      }
    }
    case "open-app": {
      const capture =
        payload.id === undefined
          ? ""
          : `#capture=${encodeURIComponent(id(payload.id))}`;
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`app.html${capture}`),
      });
      return null;
    }
    default:
      throw new Error("Unknown request");
  }
}
chrome.runtime.onMessage.addListener((request: unknown, sender, respond) => {
  if (!isRuntimeRequest(request) || request.target !== "broker") return;
  void dispatch(request, sender).then(
    (value) => respond({ ok: true, value }),
    (error) =>
      respond({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (
    port.name !== "local-capture-popup" ||
    port.sender?.id !== chrome.runtime.id
  )
    return;
  port.onDisconnect.addListener(() => {
    void (async () => {
      const job = (await listJobs()).find(
        (item) => item.state === "capturing" || item.state === "preparing",
      );
      if (job) await host("pause", { jobId: job.id }, job.id);
    })().catch(() => undefined);
  });
});
chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    if (command === "open-library") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
      return;
    }
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab?.id === undefined) return;
    if (command === "capture-page")
      await start({ tabId: tab.id, mode: "page" }, crypto.randomUUID());
    else if (command === "pick-element") await pick({ tabId: tab.id });
  })().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    for (const job of await listJobs())
      if (live.has(job.state)) {
        job.state = "interrupted";
        job.error = "Browser restarted during capture";
        job.updatedAt = Date.now();
        await saveJob(job);
      }
  })().catch(console.error);
});
