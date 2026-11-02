import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBatchUrls,
  runBatchQueue,
  waitForBatchJob,
  type BatchResult,
} from "../src/batch.js";
import {
  emptyEdit,
  type CaptureJob,
  type CaptureRecord,
} from "../src/shared/contracts.js";

const record = (id: string): CaptureRecord => ({
  id,
  title: id,
  url: "",
  createdAt: 0,
  width: 1,
  height: 1,
  scale: 1,
  tiles: [],
  links: [],
  text: [],
  edit: emptyEdit(),
  revision: 0,
  complete: true,
  warnings: [],
  source: "page",
});

test("batch URLs normalize, deduplicate and reject unsafe input", () => {
  assert.deepEqual(
    parseBatchUrls(
      " # comment\nexample.com\nhttps://example.com/\nhttp://localhost:8080/a\n\n",
    ),
    ["https://example.com/", "http://localhost:8080/a"],
  );
  assert.deepEqual(parseBatchUrls("localhost:8080/test"), [
    "https://localhost:8080/test",
  ]);
  for (const invalid of [
    "javascript:alert(1)",
    "javascript:123",
    "file:///tmp/a",
    "https://user:pass@example.com",
    "https://",
    "data:text/plain,a",
  ])
    assert.throws(() => parseBatchUrls(invalid));
  assert.throws(() =>
    parseBatchUrls(
      Array.from({ length: 201 }, (_, i) => `https://site${i}.example`).join(
        "\n",
      ),
    ),
  );
});

test("batch continues after failure and keeps successful records in order", async () => {
  const updates: BatchResult[] = [];
  const seen: string[] = [];
  const result = await runBatchQueue(
    ["a", "b", "c"],
    async (url) => {
      seen.push(url);
      if (url === "b") throw new Error("broken");
      return record(url);
    },
    (update) => updates.push(update),
    new AbortController().signal,
  );
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(
    result.map((item) => item.id),
    ["a", "c"],
  );
  assert.deepEqual(
    updates.map((item) => item.state),
    ["capturing", "completed", "capturing", "failed", "capturing", "completed"],
  );
  assert.equal(updates[3].error, "broken");
});

test("batch ignores a late successful capture after cancellation and never starts the next URL", async () => {
  const controller = new AbortController();
  const updates: BatchResult[] = [];
  const seen: string[] = [];
  let resolveCapture!: (value: CaptureRecord) => void;
  const pending = runBatchQueue(
    ["first", "second"],
    (url) => {
      seen.push(url);
      return new Promise((resolve) => {
        resolveCapture = resolve;
      });
    },
    (update) => updates.push(update),
    controller.signal,
  );
  controller.abort();
  resolveCapture(record("late"));
  assert.deepEqual(await pending, []);
  assert.deepEqual(seen, ["first"]);
  assert.deepEqual(
    updates.map((item) => item.state),
    ["capturing", "cancelled"],
  );
});

test("cancellation during a pending start cancels its eventual job without polling", async () => {
  const controller = new AbortController();
  let resolveStart!: (job: CaptureJob) => void;
  const start = new Promise<CaptureJob>((resolve) => {
    resolveStart = resolve;
  });
  const cancelled: string[] = [];
  let polls = 0;
  const result = waitForBatchJob(
    start,
    {
      getJob: async () => {
        polls++;
        return undefined;
      },
      getCapture: async () => undefined,
      cancel: async (id) => {
        cancelled.push(id);
      },
    },
    controller.signal,
  );
  controller.abort();
  resolveStart({
    id: "job",
    requestId: "request",
    tabId: 1,
    windowId: 1,
    documentId: "doc",
    mode: "page",
    frameId: 0,
    state: "capturing",
    completed: 0,
    total: 1,
    createdAt: 0,
    updatedAt: 0,
    warnings: [],
  });
  await assert.rejects(result, { name: "AbortError" });
  assert.deepEqual(cancelled, ["job"]);
  assert.equal(polls, 0);
});
