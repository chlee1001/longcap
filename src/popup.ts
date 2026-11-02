import { safeUrl } from "./geometry.js";
import { deleteBlobs, putBlob } from "./storage.js";
import {
  callBroker,
  type CaptureJob,
  type CaptureRecord,
} from "./shared/contracts.js";

function element<T extends HTMLElement>(
  id: string,
  type: { new (...args: never[]): T },
): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing element: ${id}`);
  return node;
}
const notice = element("notice", HTMLElement);
const pageButton = element("capturePage", HTMLButtonElement);
const elementButton = element("captureElement", HTMLButtonElement);
const panel = element("jobPanel", HTMLElement);
const state = element("jobState", HTMLElement);
const progress = element("jobProgress", HTMLProgressElement);
const pause = element("jobPause", HTMLButtonElement);
const resume = element("jobResume", HTMLButtonElement);
const cancel = element("jobCancel", HTMLButtonElement);
const input = element("importPdfInput", HTMLInputElement);
let tab: chrome.tabs.Tab | undefined;
let job: CaptureJob | null = null;
let polling = false;
let autoResumed = false;

function report(error: unknown): void {
  notice.textContent = error instanceof Error ? error.message : String(error);
}
const stateLabels: Record<string, string> = {
  preparing: "준비 중",
  capturing: "페이지를 찍는 중",
  paused: "일시정지됨",
  composing: "이미지를 만드는 중",
};
function displayJob(): void {
  const active = !!job && job.state in stateLabels;
  panel.hidden = !active;
  if (!job || !active) return;
  state.textContent = `${stateLabels[job.state]}${job.error ? `: ${job.error}` : ""}`;
  progress.value = job.total
    ? Math.round((100 * job.completed) / job.total)
    : 0;
  pause.disabled = job.state !== "capturing";
  resume.disabled = job.state !== "paused";
  cancel.disabled = !["preparing", "capturing", "paused", "composing"].includes(
    job.state,
  );
}
async function refresh(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    job = await callBroker<CaptureJob | null>("status");
    if (job?.state === "paused" && !autoResumed) {
      autoResumed = true;
      await callBroker("resume", { jobId: job.id });
      job = await callBroker<CaptureJob | null>("status");
    }
    displayJob();
  } catch (error) {
    report(error);
  } finally {
    polling = false;
  }
}
async function findTab(): Promise<void> {
  const explicit = new URLSearchParams(location.search).get("tabId");
  if (explicit !== null) {
    if (!/^\d+$/.test(explicit)) throw new Error("Invalid target tab");
    tab = await chrome.tabs.get(Number(explicit));
  } else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const eligible = tab?.id !== undefined && !!tab.url && !!safeUrl(tab.url);
  pageButton.disabled = elementButton.disabled = !eligible;
  if (!eligible)
    notice.textContent = "HTTP(S) 페이지에서만 캡처할 수 있습니다.";
}
function start(mode: "page" | "element"): void {
  notice.textContent = "";
  if (tab?.id === undefined || !tab.url || !safeUrl(tab.url)) {
    report(new Error("HTTP(S) target tab is unavailable"));
    return;
  }
  const tabId = tab.id;
  const url = new URL(tab.url);
  const origin = url.origin;
  void chrome.permissions
    .request({ origins: [`${url.protocol}//${url.hostname}/*`] })
    .then(async (granted) => {
      if (!granted) throw new Error("사이트 권한이 필요합니다.");
      const current = await chrome.tabs.get(tabId);
      if (
        !current.url ||
        !safeUrl(current.url) ||
        new URL(current.url).origin !== origin
      )
        throw new Error("대상 탭이 변경되었습니다.");
      if (mode === "page")
        job = await callBroker<CaptureJob>("start", { tabId, mode });
      else await callBroker("pick", { tabId });
      displayJob();
      await refresh();
    })
    .catch(report);
}
pageButton.addEventListener("click", () => start("page"));
elementButton.addEventListener("click", () => start("element"));
element("openLibrary", HTMLButtonElement).addEventListener("click", () => {
  void callBroker("open-app").catch(report);
});
for (const [button, command] of [
  [pause, "pause"],
  [resume, "resume"],
  [cancel, "cancel"],
] as const) {
  button.addEventListener("click", () => {
    if (!job) return;
    void callBroker(command, { jobId: job.id }).then(refresh).catch(report);
  });
}
input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (!file) return;
  void (async () => {
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    )
      throw new Error("PDF 파일을 선택하세요.");
    const blobKey = `import:${crypto.randomUUID()}`;
    await putBlob(blobKey, file);
    let record: CaptureRecord;
    try {
      record = await callBroker<CaptureRecord>("import-pdf", {
        blobKey,
        title: file.name,
      });
    } finally {
      await deleteBlobs([blobKey]);
    }
    await callBroker("open-app", { id: record.id });
  })()
    .catch(report)
    .finally(() => {
      input.value = "";
    });
});
const port = chrome.runtime.connect({ name: "local-capture-popup" });
pageButton.disabled = elementButton.disabled = true;
void findTab().catch(report);
void refresh();
const timer = setInterval(() => {
  void refresh();
}, 500);
window.addEventListener(
  "pagehide",
  () => {
    clearInterval(timer);
    port.disconnect();
  },
  { once: true },
);
