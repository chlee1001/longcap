import { parseBatchUrls, runBatch, type BatchResult } from "./batch.js";
import { requestDownloadPermission, downloadFiles } from "./downloads.js";
import { exportCombined } from "./export.js";
import { getSettings } from "./storage.js";
import type { CaptureRecord } from "./shared/contracts.js";

export function mountBatch(
  notify: (message: string, error?: boolean) => void,
): void {
  const urls = document.getElementById("batchUrls") as HTMLTextAreaElement;
  const tabs = document.getElementById("useOpenTabs") as HTMLButtonElement;
  const start = document.getElementById("startBatch") as HTMLButtonElement;
  const stop = document.getElementById("stopBatch") as HTMLButtonElement;
  const save = document.getElementById("saveBatchPdf") as HTMLButtonElement;
  const results = document.getElementById("batchResults") as HTMLOListElement;
  const state = document.getElementById("batchState") as HTMLElement;
  let controller: AbortController | null = null;
  let records: CaptureRecord[] = [];
  let failures = 0;
  let saving = false;
  const rows = new Map<string, HTMLLIElement>();
  const message = (error: unknown) =>
    notify(error instanceof Error ? error.message : String(error), true);
  function buttons(): void {
    start.disabled = !!controller || saving;
    tabs.disabled = !!controller || saving;
    urls.disabled = !!controller || saving;
    stop.disabled = !controller || controller.signal.aborted;
    save.disabled = !!controller || saving || records.length === 0;
  }
  function update(result: BatchResult): void {
    if (result.capture && result.state === "completed")
      records.push(result.capture);
    if (result.state === "failed") failures++;
    let row = rows.get(result.url);
    if (!row) {
      row = document.createElement("li");
      rows.set(result.url, row);
      results.append(row);
    }
    row.textContent = `${result.url} — ${result.state}${result.error ? `: ${result.error}` : ""}${result.capture && !result.capture.complete ? " (부분 캡처)" : ""}`;
  }
  tabs.addEventListener("click", () => {
    void chrome.permissions
      .request({ permissions: ["tabs"] })
      .then(async (granted) => {
        if (!granted)
          throw new Error("열린 탭을 읽으려면 탭 권한이 필요합니다.");
        const open = await chrome.tabs.query({});
        urls.value = open
          .map((tab) => tab.url ?? "")
          .filter((url) => /^https?:\/\//i.test(url))
          .join("\n");
        if (!urls.value) notify("가져올 HTTP(S) 탭이 없습니다.");
      })
      .catch(message);
  });
  start.addEventListener("click", () => {
    let list: string[];
    try {
      list = parseBatchUrls(urls.value);
      if (!list.length) throw new Error("캡처할 URL을 입력하세요.");
    } catch (error) {
      message(error);
      return;
    }
    controller = new AbortController();
    const current = controller;
    records = [];
    failures = 0;
    results.replaceChildren();
    rows.clear();
    state.textContent = "권한 확인 중";
    buttons();
    void chrome.permissions
      .request({ origins: ["<all_urls>"] })
      .then(async (granted) => {
        if (!granted)
          throw new Error(
            "Chrome에서 일괄 캡처하려면 모든 사이트 접근 권한이 필요합니다.",
          );
        if (current.signal.aborted) {
          state.textContent = "중지됨";
          return;
        }
        state.textContent = "캡처 중";
        await runBatch(list, update, current.signal);
        state.textContent = current.signal.aborted
          ? `중지됨. ${records.length}개 완료`
          : `종료. ${records.length}개 저장됨, ${failures}개 실패`;
      })
      .catch((error) => {
        state.textContent = "일괄 캡처 실패";
        message(error);
      })
      .finally(() => {
        controller = null;
        buttons();
      });
  });
  stop.addEventListener("click", () => {
    controller?.abort();
    state.textContent = "중지 중";
    buttons();
  });
  save.addEventListener("click", () => {
    saving = true;
    buttons();
    void requestDownloadPermission()
      .then(async (granted) => {
        if (!granted) throw new Error("다운로드 권한이 필요합니다.");
        const settings = { ...(await getSettings()), format: "pdf" as const };
        const files = await exportCombined(records, settings);
        await downloadFiles(files, settings);
        notify("PDF 저장이 완료되었습니다.");
      })
      .catch(message)
      .finally(() => {
        saving = false;
        buttons();
      });
  });
  buttons();
}
