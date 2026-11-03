import { mountBatch } from "./batch-ui.js";
import { EditorController } from "./editor-ui.js";
import { requestDownloadPermission, downloadFiles } from "./downloads.js";
import { exportCapture } from "./export.js";
import { safeUrl, validateSettings } from "./geometry.js";
import { getOutputRect, renderRegion } from "./render.js";
import { isTyping, showShortcutHelp } from "./shortcuts.js";
import {
  deleteBlobs,
  deleteCaptures,
  getCapture,
  getSettings,
  listCaptures,
  putBlob,
  saveSettings,
} from "./storage.js";
import {
  callBroker,
  type CaptureJob,
  type CaptureRecord,
  type Settings,
} from "./shared/contracts.js";

function node<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}
const notice = node<HTMLElement>("notice");
const toast = node<HTMLElement>("toast");
const list = node<HTMLElement>("captureList");
const search = node<HTMLInputElement>("search");
const more = node<HTMLButtonElement>("loadMore");
const all = node<HTMLInputElement>("selectAll");
const deleteButton = node<HTMLButtonElement>("deleteSelected");
const exportButton = node<HTMLButtonElement>("exportSelected");
const form = node<HTMLFormElement>("settingsForm");
const views = {
  history: node<HTMLElement>("historyView"),
  editor: node<HTMLElement>("editorView"),
  batch: node<HTMLElement>("batchView"),
  settings: node<HTMLElement>("settingsView"),
};
let editor: EditorController | null = null;
let editorId: string | null = null;
let navigation = Promise.resolve();
let records: CaptureRecord[] = [];
let selected = new Set<string>();
let offset = 0;
let hasMore = false;
let historyVersion = 0;
let job: CaptureJob | null = null;
let polling = false;
const thumbnailUrls = new Map<string, string>();
let thumbnailObserver: IntersectionObserver | null = null;
let thumbnailVersion = 0;
let focusSearch = false;
let goStarted = 0;

function clearThumbnails(): void {
  thumbnailVersion++;
  thumbnailObserver?.disconnect();
  for (const url of thumbnailUrls.values()) URL.revokeObjectURL(url);
  thumbnailUrls.clear();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function notify(message: string, error = false): void {
  if (error) {
    notice.textContent = message;
    notice.dataset.error = "true";
    return;
  }
  notice.textContent = "";
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2500);
}
function report(error: unknown): void {
  notify(error instanceof Error ? error.message : String(error), true);
}
function show(view: keyof typeof views): void {
  for (const [name, section] of Object.entries(views))
    section.hidden = name !== view;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-nav]",
  )) {
    if (button.dataset.nav === view)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (view === "history" && focusSearch) {
    focusSearch = false;
    search.focus();
  }
}
function selection(): void {
  all.checked =
    records.length > 0 && records.every((record) => selected.has(record.id));
  all.indeterminate =
    !all.checked && records.some((record) => selected.has(record.id));
  deleteButton.disabled = exportButton.disabled = selected.size === 0;
}
function renderHistory(): void {
  clearThumbnails();
  list.replaceChildren();
  const version = thumbnailVersion;
  const visibleRecords = new Map<Element, CaptureRecord>();
  thumbnailObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const record = visibleRecords.get(entry.target);
      if (!record || !record.tiles.length) continue;
      void (async () => {
        const output = getOutputRect(record);
        const region = {
          x: 0,
          y: 0,
          width: output.width,
          height: Math.min(output.height, (output.width * 200) / 320),
        };
        const canvas = await renderRegion(record, region, 320 / output.width);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (!blob || version !== thumbnailVersion) return;
        const url = URL.createObjectURL(blob);
        thumbnailUrls.set(record.id, url);
        const image = document.createElement("img");
        image.src = url;
        image.alt = "";
        entry.target.append(image);
      })().catch(() => {});
    }
  });
  if (!records.length) {
    const empty = document.createElement("p");
    empty.textContent = "캡처가 없습니다.";
    list.append(empty);
  }
  for (const record of records) {
    const card = document.createElement("article");
    card.className = "capture-card";
    const thumbnail = document.createElement("div");
    thumbnail.className = "capture-thumbnail";
    thumbnail.setAttribute("aria-hidden", "true");
    visibleRecords.set(thumbnail, record);
    thumbnailObserver.observe(thumbnail);
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected.has(record.id);
    check.setAttribute("aria-label", `${record.title} 선택`);
    check.addEventListener("change", () => {
      if (check.checked) selected.add(record.id);
      else selected.delete(record.id);
      selection();
    });
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = record.title || "제목 없음";
    open.addEventListener("click", () =>
      navigate(`capture=${encodeURIComponent(record.id)}`),
    );
    const url = document.createElement("p");
    url.textContent = record.url;
    const date = document.createElement("p");
    date.className = "meta";
    date.textContent = new Date(record.createdAt).toLocaleString();
    const partial = !record.complete || record.warnings.length > 0;
    card.append(thumbnail, check, open, url, date);
    if (partial) {
      const tag = document.createElement("span");
      tag.className = "tag partial";
      tag.textContent = "부분 캡처";
      card.append(tag);
    }
    if (!record.complete || record.warnings.length) {
      const warning = document.createElement("p");
      warning.textContent = `부분 캡처 또는 경고: ${record.warnings.join(", ")}`;
      card.append(warning);
    }
    list.append(card);
  }
  more.hidden = !hasMore;
  selection();
}
async function loadHistory(reset: boolean): Promise<void> {
  const version = ++historyVersion;
  if (reset) {
    offset = 0;
    records = [];
    hasMore = false;
    selected.clear();
    renderHistory();
  }
  more.disabled = true;
  try {
    const page = await listCaptures({
      query: search.value.trim(),
      limit: 50,
      offset,
    });
    if (version !== historyVersion) return;
    records.push(...page);
    offset += page.length;
    hasMore = page.length === 50;
    renderHistory();
  } finally {
    if (version === historyVersion) more.disabled = false;
  }
}
function navigate(hash: string): void {
  if (location.hash.slice(1) === hash) {
    queueNavigation();
    return;
  }
  location.hash = hash;
}
function queueNavigation(): void {
  const hash = location.hash.slice(1);
  navigation = navigation
    .then(async () => {
      if (location.hash.slice(1) !== hash) return;
      const params = new URLSearchParams(hash);
      const id = params.get("capture");
      const view: keyof typeof views = id
        ? "editor"
        : hash === "batch"
          ? "batch"
          : hash === "settings"
            ? "settings"
            : "history";
      if (editor && (view !== "editor" || id !== editorId)) {
        try {
          await editor.close();
        } catch (error) {
          focusSearch = false;
          history.replaceState(
            null,
            "",
            `#capture=${encodeURIComponent(editorId!)}`,
          );
          report(error);
          return;
        }
        editor = null;
        editorId = null;
      }
      if (view === "editor" && id && id !== editorId) {
        const record = await getCapture(id);
        if (!record) {
          notify("캡처를 찾을 수 없습니다.", true);
          history.replaceState(null, "", "#history");
          show("history");
          await loadHistory(true);
          return;
        }
        const settings = await getSettings();
        editor = new EditorController(record, settings, notify);
        editorId = id;
        show(view);
        editor.fit();
      }
      show(view);
      if (view === "history") await loadHistory(true);
      if (view === "settings") await loadSettings();
    })
    .catch((error) => {
      focusSearch = false;
      report(error);
      if (editorId)
        history.replaceState(
          null,
          "",
          `#capture=${encodeURIComponent(editorId)}`,
        );
      else {
        history.replaceState(null, "", "#history");
        show("history");
      }
    });
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-nav]"))
  button.addEventListener("click", () =>
    navigate(button.dataset.nav ?? "history"),
  );
node<HTMLButtonElement>("shortcutHelp").addEventListener(
  "click",
  showShortcutHelp,
);
document
  .querySelector<HTMLAnchorElement>(".skip-link")
  ?.addEventListener("click", (event) => {
    event.preventDefault();
    node<HTMLElement>("main").focus();
  });
document.addEventListener("keydown", (event) => {
  if (event.isComposing || isTyping(event.target)) {
    goStarted = 0;
    return;
  }
  if (document.querySelector("dialog[open]")) {
    goStarted = 0;
    if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey)
      showShortcutHelp();
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "a" &&
    !views.history.hidden
  ) {
    event.preventDefault();
    all.click();
    return;
  }
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    (event.shiftKey && event.key !== "?")
  ) {
    goStarted = 0;
    return;
  }
  const now = Date.now();
  const destination =
    now - goStarted <= 1000
      ? { h: "history", b: "batch", s: "settings" }[
          event.key as "h" | "b" | "s"
        ]
      : undefined;
  goStarted = event.key === "g" ? now : 0;
  if (destination) {
    navigate(destination);
  } else if (event.key === "?") {
    showShortcutHelp();
  } else if (event.key === "/") {
    event.preventDefault();
    if (views.history.hidden) {
      focusSearch = true;
      navigate("history");
    } else search.focus();
  } else if (
    event.key === "Escape" &&
    !views.editor.hidden &&
    views.editor.dataset.mode === "view"
  ) {
    node<HTMLButtonElement>("backToLibrary").click();
  } else if (
    event.key === "Delete" &&
    !views.history.hidden &&
    selected.size > 0
  ) {
    deleteButton.click();
  }
});
node<HTMLButtonElement>("backToLibrary").addEventListener("click", () =>
  navigate("history"),
);
window.addEventListener("hashchange", queueNavigation);
window.addEventListener("popstate", queueNavigation);
search.addEventListener("input", () => {
  void loadHistory(true).catch(report);
});
more.addEventListener("click", () => {
  void loadHistory(false).catch(report);
});
all.addEventListener("change", () => {
  for (const record of records) {
    if (all.checked) selected.add(record.id);
    else selected.delete(record.id);
  }
  renderHistory();
});
deleteButton.addEventListener("click", () => {
  const ids = [...selected];
  if (!ids.length || !confirm(`${ids.length}개 캡처를 삭제하시겠습니까?`))
    return;
  void deleteCaptures(ids)
    .then(async () => {
      notify("삭제되었습니다.");
      await loadHistory(true);
    })
    .catch(report);
});
exportButton.addEventListener("click", () => {
  const ids = [...selected];
  if (!ids.length) return;
  exportButton.disabled = true;
  void requestDownloadPermission()
    .then(async (granted) => {
      if (!granted) throw new Error("다운로드 권한이 필요합니다.");
      const settings = await getSettings();
      for (const id of ids) {
        const record = await getCapture(id);
        if (!record) throw new Error("선택한 캡처를 찾을 수 없습니다.");
        await downloadFiles(await exportCapture(record, settings), settings);
      }
      notify("내보내기가 완료되었습니다.");
    })
    .catch(report)
    .finally(selection);
});
const numeric = new Set<keyof Settings>([
  "quality",
  "imageWaitMs",
  "maxTiles",
  "maxDurationMs",
]);
const boolean = new Set<keyof Settings>([
  "landscape",
  "smartSplit",
  "pdfLinks",
  "pdfText",
  "provenance",
  "includeUrl",
  "saveAs",
  "clipboardFit",
]);
async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  for (const key of Object.keys(settings) as (keyof Settings)[]) {
    const input = form.elements.namedItem(key) as
      | HTMLInputElement
      | HTMLSelectElement;
    if (boolean.has(key))
      (input as HTMLInputElement).checked = settings[key] as boolean;
    else input.value = String(settings[key]);
  }
  const usage = await navigator.storage.estimate();
  node<HTMLElement>("storageUsage").textContent =
    `저장소 사용량: ${usage.usage ?? 0} 바이트 / ${usage.quota ?? 0} 바이트`;
}
const includeUrl = form.elements.namedItem("includeUrl") as HTMLInputElement;
if (includeUrl.parentElement)
  includeUrl.parentElement.lastChild!.textContent = " 내보낸 파일 URL 공개";
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const values: Record<string, unknown> = {};
    for (const input of Array.from(form.elements)) {
      if (
        !(
          input instanceof HTMLInputElement ||
          input instanceof HTMLSelectElement
        ) ||
        !input.name
      )
        continue;
      const key = input.name as keyof Settings;
      if (numeric.has(key) && !input.value.trim())
        throw new Error(`${input.name} 값을 입력하세요.`);
      values[key] = boolean.has(key)
        ? (input as HTMLInputElement).checked
        : numeric.has(key)
          ? Number(input.value)
          : input.value;
    }
    const settings = validateSettings(values);
    await saveSettings(settings);
    notify("설정이 저장되었습니다.");
  })().catch(report);
});
const pdfFile = node<HTMLInputElement>("pdfFile");
node<HTMLButtonElement>("importPdfButton").addEventListener("click", () =>
  pdfFile.click(),
);
const pdfUrlLabel = document.createElement("label");
pdfUrlLabel.textContent = "PDF URL";
const pdfUrl = document.createElement("input");
pdfUrl.type = "url";
pdfUrl.placeholder = "https://example.com/document.pdf";
pdfUrlLabel.append(pdfUrl);
const importUrl = document.createElement("button");
importUrl.type = "button";
importUrl.textContent = "URL에서 PDF 가져오기";
const pdfUrlRow = document.createElement("div");
pdfUrlRow.className = "toolbar";
pdfUrlRow.append(pdfUrlLabel, importUrl);
views.history.insertBefore(pdfUrlRow, list);
importUrl.addEventListener("click", () => {
  const value = safeUrl(pdfUrl.value.trim());
  if (!value) {
    notify("올바른 HTTP(S) PDF URL을 입력하세요.", true);
    return;
  }
  const url = new URL(value);
  importUrl.disabled = true;
  void chrome.permissions
    .request({ origins: [`${url.protocol}//${url.hostname}/*`] })
    .then(async (granted) => {
      if (!granted) throw new Error("사이트 권한이 필요합니다.");
      const title = url.pathname.split("/").pop() || "document.pdf";
      const record = await callBroker<CaptureRecord>("import-pdf", {
        url: value,
        title,
      });
      navigate(`capture=${encodeURIComponent(record.id)}`);
    })
    .catch(report)
    .finally(() => {
      importUrl.disabled = false;
    });
});
pdfFile.addEventListener("change", () => {
  const file = pdfFile.files?.[0];
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
    navigate(`capture=${encodeURIComponent(record.id)}`);
  })()
    .catch(report)
    .finally(() => {
      pdfFile.value = "";
    });
});
const panel = node<HTMLElement>("jobPanel");
const jobState = node<HTMLElement>("jobState");
const progress = node<HTMLProgressElement>("jobProgress");
const pause = node<HTMLButtonElement>("jobPause");
const resume = node<HTMLButtonElement>("jobResume");
const cancel = node<HTMLButtonElement>("jobCancel");
function displayJob(): void {
  const live = ["preparing", "capturing", "paused", "composing"];
  panel.hidden = !job || !live.includes(job.state);
  if (!job || panel.hidden) return;
  jobState.textContent = `${job.state}${job.error ? `: ${job.error}` : ""}${job.warnings.length ? ` (${job.warnings.join(", ")})` : ""}`;
  progress.value = job.total
    ? Math.round((job.completed * 100) / job.total)
    : 0;
  pause.disabled = job.state !== "capturing";
  resume.disabled = job.state !== "paused";
  cancel.disabled = !["preparing", "capturing", "paused", "composing"].includes(
    job.state,
  );
}
async function refreshJob(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    job = await callBroker<CaptureJob | null>("status");
    displayJob();
  } catch (error) {
    report(error);
  } finally {
    polling = false;
  }
}
for (const [button, command] of [
  [pause, "pause"],
  [resume, "resume"],
  [cancel, "cancel"],
] as const) {
  button.addEventListener("click", () => {
    if (job)
      void callBroker(command, { jobId: job.id })
        .then(refreshJob)
        .catch(report);
  });
}
mountBatch(notify);
queueNavigation();
void refreshJob();
const timer = setInterval(() => {
  void refreshJob();
}, 500);
window.addEventListener(
  "pagehide",
  () => {
    clearInterval(timer);
    clearThumbnails();
  },
  { once: true },
);
