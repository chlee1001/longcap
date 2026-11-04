import test from "node:test";
import assert from "node:assert/strict";

test("page preparation lays out large nested scroll panels and restores them", async () => {
  type ContentReply = { ok: boolean; error?: string; value?: unknown };
  type ContentListener = (
    message: { channel: string; command: string; data?: unknown },
    sender: { id: string },
    respond: (reply: ContentReply) => void,
  ) => unknown;
  const rootStyle = {
    getPropertyValue: () => "",
    getPropertyPriority: () => "",
    setProperty() {},
    removeProperty() {},
  };
  const inline = new Map<string, Map<string, string>>();
  const log: string[] = [];
  function panelStyle(name: string, initial: Record<string, string>) {
    const values = new Map(Object.entries(initial));
    inline.set(name, values);
    return {
      getPropertyValue: (property: string) => values.get(property) ?? "",
      getPropertyPriority: () => "",
      setProperty: (property: string, value: string, priority: string) => {
        values.set(property, value);
        log.push(`${name} ${property}:${value}${priority ? "!" : ""}`);
      },
      removeProperty: (property: string) => {
        values.delete(property);
        log.push(`${name} ${property}:removed`);
      },
    };
  }
  const root = {
    style: rootStyle,
    scrollHeight: 5000,
    scrollWidth: 0,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const panel = {
    tagName: "ASIDE",
    style: panelStyle("panel", { "max-height": "800px" }),
    scrollHeight: 3000,
    clientHeight: 800,
    clientWidth: 700,
    scrollTop: 120,
  };
  const small = {
    tagName: "DIV",
    style: panelStyle("small", {}),
    scrollHeight: 400,
    clientHeight: 100,
    clientWidth: 100,
    scrollTop: 0,
  };
  const field = {
    tagName: "TEXTAREA",
    style: panelStyle("field", {}),
    scrollHeight: 3000,
    clientHeight: 800,
    clientWidth: 700,
    scrollTop: 0,
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
    getComputedStyle: (element: unknown) => ({
      flexDirection: "row",
      overflowY: element === root ? "visible" : "auto",
      position: element === panel ? "sticky" : "static",
    }),
    document: {
      documentElement: root,
      body: {
        ...root,
        querySelectorAll: () => [panel, small, field],
      },
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
  const send = (command: string, data?: unknown) =>
    new Promise<ContentReply>((resolve) =>
      listener!(
        { channel: "local-capture", command, data },
        { id: "extension" },
        resolve,
      ),
    );
  const prepared = await send("prepare", { mode: "page", imageWaitMs: 0 });
  assert.equal(prepared.ok, true, prepared.error);
  assert.deepEqual(log, [
    "panel overflow:visible!",
    "panel height:auto!",
    "panel max-height:none!",
    "panel position:static!",
  ]);
  panel.scrollTop = 0;
  log.length = 0;
  assert.equal((await send("restore")).ok, true);
  assert.deepEqual(log, [
    "panel overflow:removed",
    "panel height:removed",
    "panel max-height:800px",
    "panel position:removed",
  ]);
  assert.equal(panel.scrollTop, 120);
});
