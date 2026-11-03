import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { EditorController } from "../src/editor-ui.js";
import { clipboardScale } from "../src/editor-safety.js";
import { exportRecord } from "../src/export.js";
import { redactionSamplingBounds } from "../src/render.js";
import { getCapture, putCapture } from "../src/storage.js";
import {
  DEFAULT_SETTINGS,
  emptyEdit,
  type CaptureRecord,
} from "../src/shared/contracts.js";

function capture(): CaptureRecord {
  return {
    id: "editor-test",
    title: "before",
    url: "https://user:pass@example.com/path?token=secret#private",
    createdAt: 0,
    width: 100,
    height: 100,
    scale: 1,
    tiles: [],
    links: [],
    text: [],
    edit: emptyEdit(),
    revision: 0,
    complete: true,
    warnings: [],
    source: "page",
  };
}

class Control extends EventTarget {
  value = "";
  textContent = "";
  title = "";
  setAttribute(): void {}
  style: Record<string, string> = {};
  clientWidth = 0;
  clientHeight = 0;
  scrollLeft = 0;
  scrollTop = 0;
  width = 0;
  height = 0;
  replaceChildren(): void {}
}

test("editor guards dirty, saving and rejected saves, and removes the guard on close", async () => {
  const originals = new Map(
    ["window", "document", "ResizeObserver", "indexedDB"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const controls = new Map<string, Control>();
  const control = (id: string) => {
    let node = controls.get(id);
    if (!node) {
      node = new Control();
      controls.set(id, node);
    }
    return node;
  };
  const windowMock = new EventTarget();
  const documentMock = new EventTarget() as EventTarget & {
    getElementById: typeof control;
    querySelectorAll: () => never[];
  };
  documentMock.getElementById = control;
  documentMock.querySelectorAll = () => [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
  });
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    Object.defineProperty(event, "returnValue", {
      configurable: true,
      writable: true,
      value: "unchanged",
    });
    windowMock.dispatchEvent(event);
    return event;
  };
  try {
    const record = capture();
    await putCapture(record);
    const editor = new EditorController(record, DEFAULT_SETTINGS, () => {});
    assert.equal(unload().defaultPrevented, false);
    control("captureTitle").value = "edited";
    control("captureTitle").dispatchEvent(new Event("input"));
    const dirty = unload();
    assert.equal(dirty.defaultPrevented, true);
    assert.equal(dirty.returnValue, "");
    const internals = editor as unknown as {
      record: CaptureRecord;
      flush(): Promise<void>;
    };
    const saving = internals.flush();
    assert.equal(unload().defaultPrevented, true);
    control("captureTitle").value = "latest";
    control("captureTitle").dispatchEvent(new Event("input"));
    await saving;
    assert.equal((await getCapture(record.id))?.title, "latest");
    assert.equal(unload().defaultPrevented, false);
    control("captureTitle").value = "failed";
    control("captureTitle").dispatchEvent(new Event("input"));
    const savedRevision = internals.record.revision;
    internals.record.revision = -1;
    await assert.rejects(editor.close());
    assert.equal(unload().defaultPrevented, true);
    internals.record.revision = savedRevision;
    const closing = editor.close();
    assert.equal(unload().defaultPrevented, true);
    await closing;
    assert.equal(unload().defaultPrevented, false);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("clipboard fitting respects actual rounded canvas and sampling bounds", () => {
  for (const [width, height, nativeScale, masks] of [
    [1200, 40000, 1, 0],
    [1200, 40000, 1, 3],
    [723.25, 14325.75, 2.75, 4],
    [50000.5, 15.3, 3, 1],
  ]) {
    const output = { x: 0, y: 0, width, height };
    const scale = clipboardScale(output, nativeScale, true, masks);
    const w = Math.ceil(width * scale),
      h = Math.ceil(height * scale);
    const sampling = redactionSamplingBounds(output, output, scale, masks);
    const sw = Math.round(sampling.width * scale),
      sh = Math.round(sampling.height * scale);
    assert.ok(scale > 0 && scale <= nativeScale);
    assert.ok(w <= 32767 && h <= 32767 && w * h <= 16_000_000);
    assert.ok(sw <= 32767 && sh <= 32767 && sw * sh <= 16_000_000);
    assert.throws(
      () => clipboardScale(output, nativeScale, false, masks),
      /clipboard size limit/,
    );
  }
  assert.equal(
    clipboardScale({ x: 0, y: 0, width: 10.5, height: 20.25 }, 2, false, 2),
    2,
  );
});

test("the shared export record strips private URL components for templates", () => {
  const record = capture();
  record.edit.template = "mac";
  assert.equal(
    exportRecord(record, { ...DEFAULT_SETTINGS, includeUrl: true }).url,
    "https://example.com/path",
  );
  assert.equal(
    exportRecord(record, { ...DEFAULT_SETTINGS, includeUrl: false }).url,
    "",
  );
  assert.match(record.url, /token=secret/);
});
