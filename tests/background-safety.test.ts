import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { saveJob } from "../src/storage.js";
import type { CaptureJob } from "../src/shared/contracts.js";

test("restore only messages the original document while it is current", async () => {
  Object.defineProperty(globalThis, "indexedDB", {
    value: new IDBFactory(),
    configurable: true,
  });
  const job: CaptureJob = {
    id: "job",
    requestId: "request",
    tabId: 12,
    windowId: 3,
    documentId: "original",
    mode: "element",
    frameId: 4,
    state: "failed",
    completed: 1,
    total: 2,
    createdAt: 1,
    updatedAt: 1,
    warnings: [],
  };
  await saveJob(job);
  let current: { documentId: string } | null = { documentId: "replacement" };
  let lookupFailure = false;
  const calls: Array<{ tabId: number; command: unknown; documentId: string }> =
    [];
  let listener:
    | ((
        request: unknown,
        sender: unknown,
        respond: (reply: unknown) => void,
      ) => unknown)
    | undefined;
  const event = { addListener: () => {} };
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        id: "extension",
        getURL: (path: string) =>
          new URL(path, "chrome-extension://extension/").href,
        onMessage: {
          addListener: (value: typeof listener) => {
            listener = value;
          },
        },
        onConnect: event,
        onStartup: event,
      },
      tabs: {
        onActivated: event,
        sendMessage: async (
          tabId: number,
          message: { command: unknown },
          options: { documentId: string },
        ) => {
          calls.push({
            tabId,
            command: message.command,
            documentId: options.documentId,
          });
          return { ok: true, value: "restored" };
        },
      },
      webNavigation: {
        getFrame: async (details: { tabId: number; frameId: number }) => {
          assert.deepEqual(details, { tabId: 12, frameId: 4 });
          if (lookupFailure) throw new Error("lookup failed");
          return current;
        },
      },
      commands: { onCommand: event },
    },
  });
  await import("../src/background.js");
  assert.ok(listener);
  const restore = () =>
    new Promise<unknown>((resolve) => {
      assert.equal(
        listener!(
          {
            target: "broker",
            type: "content",
            requestId: "r",
            payload: { jobId: "job", command: "restore" },
          },
          {
            id: "extension",
            url: "chrome-extension://extension/offscreen.html",
          },
          resolve,
        ),
        true,
      );
    });
  assert.deepEqual(await restore(), { ok: true, value: null });
  current = null;
  assert.deepEqual(await restore(), { ok: true, value: null });
  assert.deepEqual(calls, []);
  lookupFailure = true;
  assert.deepEqual(await restore(), { ok: false, error: "lookup failed" });
  assert.deepEqual(calls, []);
  lookupFailure = false;
  current = { documentId: "original" };
  assert.deepEqual(await restore(), { ok: true, value: "restored" });
  assert.deepEqual(calls, [
    { tabId: 12, command: "restore", documentId: "original" },
  ]);
});
