import test from "node:test";
import assert from "node:assert/strict";
import {
  assertFrameChain,
  frameGeometry,
  frameIndex,
  multiplyFrames,
} from "../src/frame-geometry.js";

test("frame index uses actual WindowProxy and chain checks bind both documents", () => {
  const child = {} as Window;
  const other = {} as Window;
  const parent = { length: 2, frames: [other, child] } as unknown as Window;
  assert.equal(frameIndex(parent, child), 1);
  assert.throws(() => frameIndex(parent, {} as Window), /Cannot identify/);
  assertFrameChain(
    { documentId: "child", parentFrameId: 7 },
    { documentId: "parent" },
    "child",
    7,
    "parent",
  );
  for (const [c, p] of [
    [{ documentId: "other", parentFrameId: 7 }, { documentId: "parent" }],
    [{ documentId: "child", parentFrameId: 8 }, { documentId: "parent" }],
    [{ documentId: "child", parentFrameId: 7 }, { documentId: "other" }],
    [
      { documentId: "child", parentFrameId: 7, parentDocumentId: "other" },
      { documentId: "parent" },
    ],
    [null, { documentId: "parent" }],
  ] as const)
    assert.throws(
      () => assertFrameChain(c, p, "child", 7, "parent"),
      /Frame chain changed/,
    );
});

test("frame geometry rejects transformed wrappers and maps untransformed frames", () => {
  const child = {};
  const wrapper = {
    parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
  };
  const frame = {
    contentWindow: child,
    parentElement: wrapper,
    offsetWidth: 202,
    offsetHeight: 102,
    clientWidth: 200,
    clientHeight: 100,
    clientLeft: 1,
    clientTop: 1,
    getBoundingClientRect: () => ({
      left: 20,
      top: 30,
      right: 222,
      bottom: 132,
      width: 202,
      height: 102,
    }),
  };
  let transform = "none";
  let padding = {
    paddingTop: "0px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
  };
  Object.assign(globalThis, {
    window: { length: 1, frames: [child] },
    innerWidth: 800,
    innerHeight: 600,
    document: { querySelectorAll: () => [frame] },
    getComputedStyle: (element: unknown) => ({
      transform: element === wrapper ? transform : "none",
      translate: "none",
      rotate: "none",
      scale: "none",
      perspective: "none",
      zoom: "1",
      overflowX: "visible",
      overflowY: "visible",
      ...padding,
    }),
  });
  assert.deepEqual(frameGeometry(0, 200, 100), {
    matrix: [1, 0, 0, 1, 21, 31],
    width: 800,
    height: 600,
  });
  assert.deepEqual(
    multiplyFrames([2, 0, 0, 2, 10, 20], [1, 0, 0, 1, 21, 31]),
    [2, 0, 0, 2, 52, 82],
  );
  for (const side of [
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
  ] as const) {
    padding = {
      paddingTop: "0px",
      paddingRight: "0px",
      paddingBottom: "0px",
      paddingLeft: "0px",
      [side]: "0.5px",
    };
    assert.throws(
      () => frameGeometry(0, 200, 100),
      /Unsupported frame padding/,
    );
  }
  padding = {
    paddingTop: "0px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
  };
  for (const value of [
    "matrix(2, 0, 0, 2, 0, 0)",
    "matrix(0, 1, -1, 0, 0, 0)",
  ]) {
    transform = value;
    assert.throws(() => frameGeometry(0, 200, 100), /Unsupported transformed/);
  }
});

test("forged parent postMessage cannot change authenticated frame link", async () => {
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> =
    [];
  const child: {
    top?: unknown;
    parent?: unknown;
    addEventListener: (
      type: string,
      listener: (event: { source: unknown; data: unknown }) => void,
    ) => void;
  } = { addEventListener: (_type, listener) => listeners.push(listener) };
  const parent = { length: 1, frames: [child] };
  child.top = parent;
  child.parent = parent;
  let onMessage:
    | ((
        message: unknown,
        sender: unknown,
        respond: (reply: unknown) => void,
      ) => unknown)
    | undefined;
  Object.assign(globalThis, {
    window: child,
    innerWidth: 400,
    innerHeight: 300,
    chrome: {
      runtime: {
        id: "extension",
        onMessage: {
          addListener: (listener: typeof onMessage) => {
            onMessage = listener;
          },
        },
      },
    },
  });
  await import("../src/content.js");
  for (const source of [parent, {}, null])
    for (const listener of listeners)
      listener({
        source,
        data: {
          localCaptureMap: "response",
          nonce: "observed",
          matrix: [1, 0, 0, 1, 999, 999],
        },
      });
  assert.ok(onMessage);
  assert.equal(
    onMessage(
      { channel: "local-capture", command: "frame-link" },
      { id: "other-extension" },
      () => assert.fail("unauthorized sender"),
    ),
    undefined,
  );
  const reply = await new Promise<unknown>((resolve) =>
    onMessage!(
      { channel: "local-capture", command: "frame-link" },
      { id: "extension" },
      resolve,
    ),
  );
  assert.deepEqual(reply, {
    ok: true,
    value: { index: 0, width: 400, height: 300 },
  });
});
