import test from "node:test";
import assert from "node:assert/strict";

test("element preparation rejects individual transforms and perspective before changing capture state", async () => {
  type PickerEvent = {
    target?: ElementMock;
    preventDefault?(): void;
    stopImmediatePropagation?(): void;
  };
  type ContentReply = { ok: boolean; error?: string; value?: unknown };
  type ContentListener = (
    message: { channel: string; command: string; data?: unknown },
    sender: { id: string },
    respond: (reply: ContentReply) => void,
  ) => unknown;
  const handlers = new Map<string, (event: PickerEvent) => void>();
  const changes: string[] = [];
  const scrolls: number[][] = [];
  const style = {
    getPropertyValue: () => "smooth",
    getPropertyPriority: () => "",
    setProperty: (name: string, value: string) =>
      changes.push(`${name}:${value}`),
    removeProperty: (name: string) => changes.push(`${name}:removed`),
  };
  class ElementMock {
    parentElement: ElementMock | null = null;
    isConnected = true;
    tagName = "DIV";
    style = style;
    scrollLeft = 3;
    scrollTop = 4;
    scrollWidth = 200;
    scrollHeight = 200;
    clientWidth = 100;
    clientHeight = 100;
    clientLeft = 0;
    clientTop = 0;
    offsetWidth = 100;
    offsetHeight = 100;
    append() {}
    remove() {}
    scrollTo(x: number, y: number) {
      scrolls.push([x, y]);
    }
    getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 100,
        bottom: 100,
        width: 100,
        height: 100,
      };
    }
    querySelectorAll() {
      return [];
    }
    querySelector() {
      return null;
    }
  }
  const ancestor = new ElementMock();
  const selected = new ElementMock();
  selected.parentElement = ancestor;
  let changedElement: ElementMock | null = null;
  let changedProperty = "";
  let changedValue = "";
  let listener: ContentListener | undefined;
  const originalSetTimeout = globalThis.setTimeout;
  Object.assign(globalThis, {
    HTMLElement: ElementMock,
    HTMLIFrameElement: class extends ElementMock {},
    HTMLCanvasElement: class extends ElementMock {},
    NodeFilter: { SHOW_TEXT: 4 },
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 0,
    location: { href: "https://example.com/" },
    window: { scrollTo: (x: number, y: number) => scrolls.push([x, y]) },
    requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout: (...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args);
      timer.unref();
      return timer;
    },
    getComputedStyle: (element: ElementMock) => ({
      transform: "none",
      translate: "none",
      rotate: "none",
      scale: "none",
      perspective: "none",
      overflowX: "visible",
      overflowY: "visible",
      flexDirection: "row",
      ...(element === changedElement
        ? { [changedProperty]: changedValue }
        : {}),
    }),
    document: {
      documentElement: ancestor,
      body: ancestor,
      title: "test",
      images: [],
      createElement: () => new ElementMock(),
      createTreeWalker: () => ({ nextNode: () => false }),
      addEventListener: (name: string, handler: (event: PickerEvent) => void) =>
        handlers.set(name, handler),
      removeEventListener: (name: string) => handlers.delete(name),
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
  try {
    await import("../src/content.js");
    const send = (command: string, data?: unknown) => {
      const handler = listener;
      assert.ok(handler);
      return new Promise<ContentReply>((resolve) =>
        handler(
          { channel: "local-capture", command, data },
          { id: "extension" },
          resolve,
        ),
      );
    };
    assert.equal((await send("pick", { token: "token" })).ok, true);
    handlers.get("mousemove")!({ target: selected });
    handlers.get("click")!({
      preventDefault() {},
      stopImmediatePropagation() {},
    });
    const prepare = () =>
      send("prepare", { mode: "element", token: "token", imageWaitMs: 0 });
    assert.equal((await prepare()).ok, true);
    assert.deepEqual(changes, [
      "scrollbar-width:none",
      "scrollbar-width:none",
      "scroll-behavior:auto",
    ]);
    const prepared = changes.length;
    for (const element of [selected, ancestor]) {
      for (const [property, value] of [
        ["translate", "1px"],
        ["rotate", "10deg"],
        ["scale", "2"],
        ["perspective", "500px"],
      ]) {
        changedElement = element;
        changedProperty = property;
        changedValue = value;
        const beforeChanges = changes.length;
        const beforeScrolls = scrolls.length;
        const reply = await prepare();
        assert.equal(reply.ok, false);
        assert.match(
          reply.error ?? "",
          /Unsupported transformed element ancestor/,
        );
        if (beforeChanges === prepared) {
          assert.deepEqual(changes.slice(beforeChanges), [
            "scrollbar-width:smooth",
            "scrollbar-width:smooth",
            "scroll-behavior:smooth",
          ]);
          assert.deepEqual(scrolls.slice(beforeScrolls), [[3, 4]]);
        } else {
          assert.equal(changes.length, beforeChanges);
          assert.equal(scrolls.length, beforeScrolls);
        }
      }
    }
    assert.equal((await send("restore")).ok, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
