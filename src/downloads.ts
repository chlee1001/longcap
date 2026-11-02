import type { ExportFile, Settings } from "./shared/contracts.js";

export function requestDownloadPermission(): Promise<boolean> {
  return chrome.permissions.request({ permissions: ["downloads"] });
}

function downloadPath(folder: string, name: string): string {
  const invalid = (part: string) =>
    !part ||
    part === "." ||
    part === ".." ||
    /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(part) ||
    /[. ]$/.test(part);
  if (invalid(name) || (folder && folder.split("/").some(invalid)))
    throw new Error("Invalid download path");
  return folder ? `${folder}/${name}` : name;
}

export async function downloadFiles(
  files: ExportFile[],
  settings: Settings,
): Promise<void> {
  const paths = files.map((file) => downloadPath(settings.folder, file.name));
  if (!(await chrome.permissions.contains({ permissions: ["downloads"] })))
    throw new Error("Downloads permission is required");
  for (let index = 0; index < files.length; index++) {
    const url = URL.createObjectURL(files[index].blob);
    let listener: ((delta: chrome.downloads.DownloadDelta) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let id: number | undefined;
      let resolve!: () => void;
      let reject!: (reason: Error) => void;
      const finished = new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      listener = (delta) => {
        if (delta.id !== id) return;
        if (delta.error?.current || delta.state?.current === "interrupted")
          reject(
            new Error(
              `Download interrupted: ${delta.error?.current ?? "unknown error"}`,
            ),
          );
        else if (delta.state?.current === "complete") resolve();
      };
      chrome.downloads.onChanged.addListener(listener);
      id = await chrome.downloads.download({
        url,
        filename: paths[index],
        saveAs: settings.saveAs && index === 0,
      });
      timer = setTimeout(() => reject(new Error("Download timed out")), 60_000);
      chrome.downloads.search({ id }).then(
        (items) => {
          const item = items.find((candidate) => candidate.id === id);
          if (!item) {
            reject(new Error(`Download ${id} not found`));
            return;
          }
          listener?.({
            id: item.id,
            state: { current: item.state },
            error: item.error ? { current: item.error } : undefined,
          });
        },
        (error: unknown) =>
          reject(error instanceof Error ? error : new Error(String(error))),
      );
      await finished;
    } finally {
      if (timer) clearTimeout(timer);
      if (listener) chrome.downloads.onChanged.removeListener(listener);
      URL.revokeObjectURL(url);
    }
  }
}
