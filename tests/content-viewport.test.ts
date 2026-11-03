import test from "node:test";
import assert from "node:assert/strict";

test("page preparation measures the viewport after a resize settles", async () => {
  type ContentReply = { ok: boolean; error?: string; value?: unknown };
  type ContentListener = (
    message: { channel: string; command: string; data?: unknown },
    sender: { id: string },
    respond: (reply: ContentReply) => void,
  ) => unknown;
  const style = {
    getPropertyValue: () => "",
    getPropertyPriority: () => "",
    setProperty() {},
    removeProperty() {},
  };
  const root = {
    style,
    scrollHeight: 5000,
    scrollWidth: 0,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const view = globalThis as unknown as {
    innerWidth: number;
    innerHeight: number;
  };
  let listener: ContentListener | undefined;
  Object.assign(globalThis, {
    HTMLElement: class {},
    HTMLCanvasElement: class {},
    NodeFilter: { SHOW_TEXT: 4 },
    innerWidth: 1440,
    innerHeight: 900,
    scrollX: 0,
    scrollY: 0,
    location: { href: "https://example.com/" },
    window: { scrollTo() {} },
    requestAnimationFrame: (callback: () => void) => callback(),
    getComputedStyle: () => ({ flexDirection: "row" }),
    document: {
      documentElement: root,
      body: root,
      title: "test",
      images: [],
      createTreeWalker: () => ({ nextNode: () => false }),
    },
    chrome: {
      runtime: {
        id: "extension",
        onMessage: {
          addListener: (fn: ContentListener) => {
            listener = fn;
          },
        },
        sendMessage: async () => ({}),
      },
    },
  });
  await import("../src/content.js");
  assert.ok(listener);
  // The window settles in steps, like a tab that was just brought forward.
  const steps: Array<[number, number, number]> = [
    [150, 1278, 872],
    [320, 1234, 872],
    [480, 1232, 872],
  ];
  const timers = steps.map(([delay, width, height]) =>
    setTimeout(() => {
      view.innerWidth = width;
      view.innerHeight = height;
    }, delay),
  );
  const started = performance.now();
  const reply = await new Promise<ContentReply>((resolve) =>
    listener!(
      {
        channel: "local-capture",
        command: "prepare",
        data: { mode: "page", imageWaitMs: 0 },
      },
      { id: "extension" },
      resolve,
    ),
  );
  for (const timer of timers) clearTimeout(timer);
  assert.equal(reply.ok, true, reply.error);
  const value = reply.value as { viewport: { width: number; height: number } };
  assert.deepEqual([value.viewport.width, value.viewport.height], [1232, 872]);
  assert.ok(performance.now() - started < 2500);
  listener!(
    { channel: "local-capture", command: "restore" },
    { id: "extension" },
    () => {},
  );
});
