import test from "node:test";
import assert from "node:assert/strict";
import { downloadFiles, requestDownloadPermission } from "../src/downloads.js";
import { DEFAULT_SETTINGS } from "../src/shared/contracts.js";

test("permission, paths, completion and interruption", async () => {
  let listener: ((change: chrome.downloads.DownloadDelta) => void) | undefined;
  let permitted = true,
    interrupt = false;
  const calls: chrome.downloads.DownloadOptions[] = [];
  Object.assign(globalThis, {
    chrome: {
      permissions: {
        request: async () => permitted,
        contains: async () => permitted,
      },
      downloads: {
        onChanged: {
          addListener: (fn: typeof listener) => {
            listener = fn;
          },
          removeListener: () => {
            listener = undefined;
          },
        },
        download: async (options: chrome.downloads.DownloadOptions) => {
          calls.push(options);
          setTimeout(
            () =>
              listener?.({
                id: calls.length,
                state: { current: interrupt ? "interrupted" : "complete" },
              }),
            0,
          );
          return calls.length;
        },
        search: async ({ id }: { id: number }) => [
          { id, state: "in_progress" },
        ],
      },
    },
  });
  assert.equal(await requestDownloadPermission(), true);
  const file = { name: "ok.png", blob: new Blob(["a"]) };
  await downloadFiles([file, file], {
    ...DEFAULT_SETTINGS,
    folder: "captures/nested",
    saveAs: true,
  });
  assert.deepEqual(
    calls.map((c) => c.saveAs),
    [true, false],
  );
  assert.equal(calls[0].filename, "captures/nested/ok.png");
  await assert.rejects(
    downloadFiles([{ ...file, name: "../x" }], DEFAULT_SETTINGS),
    /path/,
  );
  await assert.rejects(
    downloadFiles([file], { ...DEFAULT_SETTINGS, folder: "../x" }),
    /path/,
  );
  interrupt = true;
  await assert.rejects(downloadFiles([file], DEFAULT_SETTINGS), /interrupted/);
  permitted = false;
  assert.equal(await requestDownloadPermission(), false);
  await assert.rejects(downloadFiles([file], DEFAULT_SETTINGS), /permission/);
});

test("a download that never completes times out and releases its URL", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const revoke = context.mock.method(URL, "revokeObjectURL");
  let removed = false;
  Object.assign(globalThis, {
    chrome: {
      permissions: { contains: async () => true },
      downloads: {
        onChanged: {
          addListener: () => {},
          removeListener: () => {
            removed = true;
          },
        },
        download: async () => 99,
        search: () => new Promise(() => {}),
      },
    },
  });
  const download = downloadFiles(
    [{ name: "test.png", blob: new Blob(["a"]) }],
    DEFAULT_SETTINGS,
  );
  const assertion = assert.rejects(download, /timed out/);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  context.mock.timers.tick(60_000);
  await assertion;
  assert.equal(removed, true);
  assert.equal(revoke.mock.callCount(), 1);
});

test("reconciles terminal events before the download ID is returned", async (context) => {
  const revoke = context.mock.method(URL, "revokeObjectURL");
  for (const state of ["complete", "interrupted", "in_progress"] as const) {
    const events: {
      listener?: (change: chrome.downloads.DownloadDelta) => void;
    } = {};
    let returnId!: (id: number) => void;
    let searchedId: number | undefined;
    const idReady = new Promise<number>((resolve) => {
      returnId = resolve;
    });
    Object.assign(globalThis, {
      chrome: {
        permissions: { contains: async () => true },
        downloads: {
          onChanged: {
            addListener: (fn: typeof events.listener) => {
              events.listener = fn;
            },
            removeListener: () => {
              events.listener = undefined;
            },
          },
          download: () => idReady,
          search: async ({ id }: { id: number }) => {
            searchedId = id;
            return [
              {
                id,
                state,
                error: state === "in_progress" ? "NETWORK_FAILED" : undefined,
              },
            ];
          },
        },
      },
    });
    const download = downloadFiles(
      [{ name: "test.png", blob: new Blob(["a"]) }],
      DEFAULT_SETTINGS,
    );
    await Promise.resolve();
    assert.ok(events.listener);
    events.listener?.({ id: 42, state: { current: state } });
    returnId(42);
    if (state === "interrupted") await assert.rejects(download, /interrupted/);
    else if (state === "in_progress")
      await assert.rejects(download, /NETWORK_FAILED/);
    else await download;
    assert.equal(searchedId, 42);
    assert.equal(events.listener, undefined);
  }
  assert.equal(revoke.mock.callCount(), 3);
});

test("only the owned post-ID event settles a download", async (context) => {
  const revoke = context.mock.method(URL, "revokeObjectURL");
  const events: {
    listener?: (change: chrome.downloads.DownloadDelta) => void;
  } = {};
  let searchStarted!: () => void;
  const searching = new Promise<void>((resolve) => {
    searchStarted = resolve;
  });
  Object.assign(globalThis, {
    chrome: {
      permissions: { contains: async () => true },
      downloads: {
        onChanged: {
          addListener: (fn: typeof events.listener) => {
            events.listener = fn;
          },
          removeListener: () => {
            events.listener = undefined;
          },
        },
        download: async () => 42,
        search: () => {
          searchStarted();
          return new Promise(() => {});
        },
      },
    },
  });
  let settled = false;
  const download = downloadFiles(
    [{ name: "test.png", blob: new Blob(["a"]) }],
    DEFAULT_SETTINGS,
  );
  void download.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await searching;
  events.listener?.({ id: 43, state: { current: "complete" } });
  events.listener?.({ id: 43, state: { current: "interrupted" } });
  await Promise.resolve();
  assert.equal(settled, false);
  events.listener?.({ id: 42, state: { current: "complete" } });
  await download;
  assert.equal(events.listener, undefined);
  assert.equal(revoke.mock.callCount(), 1);
});

test("search errors and missing owned records fail and clean up", async (context) => {
  const revoke = context.mock.method(URL, "revokeObjectURL");
  for (const missing of [false, true]) {
    let listener:
      | ((change: chrome.downloads.DownloadDelta) => void)
      | undefined;
    Object.assign(globalThis, {
      chrome: {
        permissions: { contains: async () => true },
        downloads: {
          onChanged: {
            addListener: (fn: typeof listener) => {
              listener = fn;
            },
            removeListener: () => {
              listener = undefined;
            },
          },
          download: async () => 42,
          search: async () => {
            if (!missing) throw new Error("search failed");
            return [{ id: 43, state: "complete" }];
          },
        },
      },
    });
    await assert.rejects(
      downloadFiles(
        [{ name: "test.png", blob: new Blob(["a"]) }],
        DEFAULT_SETTINGS,
      ),
      missing ? /not found/ : /search failed/,
    );
    assert.equal(listener, undefined);
  }
  assert.equal(revoke.mock.callCount(), 2);
});
