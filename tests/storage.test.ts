import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import {
  DEFAULT_SETTINGS,
  emptyEdit,
  type CaptureRecord,
  type CaptureJob,
} from "../src/shared/contracts.js";
import {
  deleteBlobs,
  deleteCaptures,
  getBlob,
  getCapture,
  getJob,
  getSettings,
  listCaptures,
  listJobs,
  putBlob,
  putCapture,
  saveJob,
  saveSettings,
  updateCapture,
} from "../src/storage.js";

function freshDatabase(): void {
  Object.defineProperty(globalThis, "indexedDB", {
    value: new IDBFactory(),
    configurable: true,
  });
}

function capture(id: string, createdAt: number, blobKey = id): CaptureRecord {
  return {
    id,
    title: id,
    url: `https://example.com/${id}`,
    createdAt,
    width: 1,
    height: 1,
    scale: 1,
    tiles: [
      {
        id,
        blobKey,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        pixelWidth: 1,
        pixelHeight: 1,
      },
    ],
    links: [],
    text: [],
    edit: emptyEdit(),
    revision: 0,
    complete: true,
    warnings: [],
    source: "page",
  };
}

test("writes are durable and edits enforce optimistic revision", async () => {
  freshDatabase();
  await putCapture(capture("a", 1));
  assert.equal((await getCapture("a"))?.title, "a");
  const saved = await updateCapture("a", 0, { title: "renamed" });
  assert.equal(saved.revision, 1);
  await assert.rejects(updateCapture("a", 0, { title: "stale" }), /revision/i);
  await assert.rejects(updateCapture("missing", 0, {}), /not found/i);
  assert.equal((await getCapture("a"))?.title, "renamed");
  const job: CaptureJob = {
    id: "job",
    requestId: "r",
    tabId: 1,
    windowId: 1,
    documentId: "d",
    mode: "page",
    frameId: 0,
    state: "preparing",
    completed: 0,
    total: 1,
    createdAt: 1,
    updatedAt: 1,
    warnings: [],
  };
  await saveJob(job);
  assert.deepEqual(await getJob("job"), job);
  assert.deepEqual(await listJobs(), [job]);
});

test("cursor lists newest metadata with search and pagination", async () => {
  freshDatabase();
  const a = capture("a", 1);
  a.text = [
    { text: "Needle in page", rect: { x: 0, y: 0, width: 1, height: 1 } },
  ];
  const b = capture("b", 3);
  b.title = "NEEDLE title";
  const c = capture("c", 2);
  c.url = "https://example.com/needle";
  await Promise.all([putCapture(a), putCapture(b), putCapture(c)]);
  assert.deepEqual(
    (await listCaptures()).map((record) => record.id),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    (await listCaptures({ query: "needle", offset: 1, limit: 1 })).map(
      (record) => record.id,
    ),
    ["c"],
  );
  assert.deepEqual(await listCaptures({ limit: 0 }), []);
  await assert.rejects(listCaptures({ offset: -1 }));
});

test("deletion is explicit and preserves shared and independent blobs", async () => {
  freshDatabase();
  await putCapture(capture("a", 1, "shared"));
  await putCapture(capture("b", 2, "shared"));
  await putCapture(capture("c", 3, "owned"));
  await putBlob("shared", new Blob(["shared"]));
  await putBlob("owned", new Blob(["owned"]));
  await putBlob("other", new Blob(["other"]));
  await deleteCaptures(["a", "c", "missing"]);
  assert.equal(await getCapture("a"), undefined);
  assert.ok(await getCapture("b"));
  assert.equal(await getCapture("c"), undefined);
  assert.equal(await (await getBlob("shared"))?.text(), "shared");
  assert.equal(await getBlob("owned"), undefined);
  assert.equal(await (await getBlob("other"))?.text(), "other");
  await deleteBlobs(["other"]);
  assert.equal(await getBlob("other"), undefined);
  assert.ok(await getBlob("shared"));
});

test("quota errors reject writes and failed settings saves do not poison retries", async () => {
  freshDatabase();
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
  const original = Object.getOwnPropertyDescriptor(
    IDBObjectStore.prototype,
    "put",
  );
  assert.ok(original);
  Object.defineProperty(IDBObjectStore.prototype, "put", {
    ...original,
    value() {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  });
  try {
    await assert.rejects(putBlob("x", new Blob(["x"])), {
      name: "QuotaExceededError",
    });
    await assert.rejects(saveSettings({ ...DEFAULT_SETTINGS, quality: 0.5 }), {
      name: "QuotaExceededError",
    });
  } finally {
    Object.defineProperty(IDBObjectStore.prototype, "put", original);
  }
  assert.equal(await getBlob("x"), undefined);
  await saveSettings({ ...DEFAULT_SETTINGS, quality: 0.5 });
  assert.equal((await getSettings()).quality, 0.5);
});

test("aborted transactions never report successful writes", async () => {
  freshDatabase();
  const original = Object.getOwnPropertyDescriptor(
    IDBObjectStore.prototype,
    "put",
  );
  assert.ok(original);
  Object.defineProperty(IDBObjectStore.prototype, "put", {
    ...original,
    value(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = original.value.call(this, value, key);
      this.transaction.abort();
      return request;
    },
  });
  try {
    await assert.rejects(putBlob("aborted", new Blob(["not committed"])));
  } finally {
    Object.defineProperty(IDBObjectStore.prototype, "put", original);
  }
  assert.equal(await getBlob("aborted"), undefined);
});
