import {
  makeRequest,
  type Link,
  type ScrollerInfo,
  type TextRun,
} from "./shared/contracts.js";
import { frameGeometry, frameIndex } from "./frame-geometry.js";

type ContentMessage = { channel: string; command: string; data?: unknown };
type PickerData = { token: string };
const root = globalThis as typeof globalThis & {
  __localCaptureInstalled?: boolean;
};

if (!root.__localCaptureInstalled) {
  root.__localCaptureInstalled = true;
  let selected: HTMLElement | null = null;
  let selectionToken = "";
  let scroller: HTMLElement | null = null;
  let autoScroller = false;
  let originalX = 0;
  let originalY = 0;
  let active = false;
  let imageWaitMs = 1500;
  let scrollbarStyles: Array<{
    element: HTMLElement;
    value: string;
    priority: string;
  }> = [];
  let scrollStyle:
    | { element: HTMLElement; value: string; priority: string }
    | undefined;
  let reverseY = false;
  let canvasRange:
    | { element: HTMLCanvasElement; min: number; max: number; original: number }
    | undefined;
  let hidden: Array<{
    element: HTMLElement;
    visibility: string;
    priority: string;
  }> = [];
  let lease: ReturnType<typeof setTimeout> | undefined;
  let pickerCleanup: (() => void) | undefined;
  let pickerToken = "";
  let pickedWindow: Window | null = null;
  let pickedWindowToken = "";
  async function mappedInfo() {
    const result = info();
    return {
      ...result,
      frameMatrix: [1, 0, 0, 1, 0, 0],
      windowWidth: innerWidth,
      windowHeight: innerHeight,
    };
  }

  function restore() {
    clearTimeout(lease);
    if (!active) return;
    for (const entry of hidden) {
      if (entry.visibility)
        entry.element.style.setProperty(
          "visibility",
          entry.visibility,
          entry.priority,
        );
      else entry.element.style.removeProperty("visibility");
    }
    hidden = [];
    if (canvasRange) {
      const current = Number(canvasRange.element.dataset.offset);
      if (Number.isFinite(current))
        canvasRange.element.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: canvasRange.original - current,
            bubbles: true,
            cancelable: true,
          }),
        );
      canvasRange = undefined;
    }
    if (scroller) scroller.scrollTo(originalX, originalY);
    else window.scrollTo(originalX, originalY);
    for (const entry of scrollbarStyles) {
      if (entry.value)
        entry.element.style.setProperty(
          "scrollbar-width",
          entry.value,
          entry.priority,
        );
      else entry.element.style.removeProperty("scrollbar-width");
    }
    scrollbarStyles = [];
    if (scrollStyle) {
      if (scrollStyle.value)
        scrollStyle.element.style.setProperty(
          "scroll-behavior",
          scrollStyle.value,
          scrollStyle.priority,
        );
      else scrollStyle.element.style.removeProperty("scroll-behavior");
      scrollStyle = undefined;
    }
    scroller = null;
    autoScroller = false;
    active = false;
  }

  function renew() {
    clearTimeout(lease);
    lease = setTimeout(restore, 6000);
  }

  function rectFor(element: Element) {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function info(): ScrollerInfo {
    const boundsRect = scroller ? rectFor(scroller) : null;
    const scaleX =
      scroller && boundsRect && scroller.offsetWidth
        ? boundsRect.width / scroller.offsetWidth
        : 1;
    const scaleY =
      scroller && boundsRect && scroller.offsetHeight
        ? boundsRect.height / scroller.offsetHeight
        : 1;
    const viewport =
      scroller && boundsRect
        ? {
            x: boundsRect.x + scroller.clientLeft * scaleX,
            y: boundsRect.y + scroller.clientTop * scaleY,
            width: scroller.clientWidth,
            height: scroller.clientHeight,
          }
        : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const x = scroller ? scroller.scrollLeft : scrollX;
    const y = canvasRange
      ? Number(canvasRange.element.dataset.offset) - canvasRange.min
      : scroller
        ? scroller.scrollTop +
          (reverseY ? scroller.scrollHeight - scroller.clientHeight : 0)
        : scrollY;
    const base = scroller ?? document.documentElement;
    const links: Link[] = [];
    const text: TextRun[] = [];
    const bounds = (element: Element) => {
      const r = element.getBoundingClientRect();
      return {
        x: (r.left - viewport.x) / scaleX + x,
        y: (r.top - viewport.y) / scaleY + y,
        width: r.width / scaleX,
        height: r.height / scaleY,
      };
    };
    for (const anchor of base.querySelectorAll("a[href]")) {
      if (links.length >= 5000) break;
      const href = (anchor as HTMLAnchorElement).href;
      try {
        const url = new URL(href);
        if (
          (url.protocol === "http:" || url.protocol === "https:") &&
          !url.username &&
          !url.password
        )
          links.push({ rect: bounds(anchor), href: url.href });
      } catch {
        continue;
      }
    }
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && text.length < 10000) {
      const node = walker.currentNode;
      const value = node.textContent?.trim();
      if (!value || !node.parentElement) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width && r.height)
        text.push({
          text: value.slice(0, 4096),
          rect: {
            x: (r.x - viewport.x) / scaleX + x,
            y: (r.y - viewport.y) / scaleY + y,
            width: r.width / scaleX,
            height: r.height / scaleY,
          },
        });
    }
    return {
      documentId: "",
      title: document.title,
      url: location.href,
      width: scroller
        ? scroller.scrollWidth
        : Math.max(
            document.documentElement.scrollWidth,
            document.body?.scrollWidth ?? 0,
          ),
      height: canvasRange
        ? canvasRange.max - canvasRange.min + canvasRange.element.clientHeight
        : scroller
          ? scroller.scrollHeight
          : Math.max(
              document.documentElement.scrollHeight,
              document.body?.scrollHeight ?? 0,
            ),
      viewport,
      scrollX: x,
      scrollY: y,
      scaleX,
      scaleY,
      windowWidth: innerWidth,
      windowHeight: innerHeight,
      embedded:
        autoScroller &&
        scaleX === 1 &&
        scaleY === 1 &&
        !!scroller &&
        scroller.scrollWidth <= scroller.clientWidth + 1,
      links,
      text,
      warnings: [
        ...(base.querySelector("iframe,frame")
          ? ["Embedded frames are captured only as visible."]
          : []),
        ...((base instanceof HTMLCanvasElement && !canvasRange) ||
        (!(base instanceof HTMLCanvasElement) && base.querySelector("canvas"))
          ? ["Canvas content is limited to its visible state."]
          : []),
      ],
    };
  }

  const waitedImages = new WeakSet<HTMLImageElement>();
  async function ready() {
    await Promise.all(
      Array.from(document.images)
        .filter((image) => !image.complete && !waitedImages.has(image))
        .map((image) => {
          waitedImages.add(image);
          return Promise.race([
            image.decode().catch(() => undefined),
            new Promise((resolve) =>
              setTimeout(resolve, Math.min(imageWaitMs, 4000)),
            ),
          ]);
        }),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }

  function stuck(element: HTMLElement) {
    const before = element.getBoundingClientRect();
    const value = element.style.getPropertyValue("position");
    const priority = element.style.getPropertyPriority("position");
    element.style.setProperty("position", "static", "important");
    const natural = element.getBoundingClientRect();
    if (value) element.style.setProperty("position", value, priority);
    else element.style.removeProperty("position");
    return (
      Math.abs(before.left - natural.left) > 0.5 ||
      Math.abs(before.top - natural.top) > 0.5
    );
  }

  function dominantScroller(): HTMLElement | null {
    const root = document.documentElement;
    if (root.scrollHeight > innerHeight + 1) return null;
    let best: HTMLElement | null = null;
    let bestArea = innerWidth * innerHeight * 0.5;
    for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
      if (element.scrollHeight <= element.clientHeight + 1) continue;
      const overflow = getComputedStyle(element).overflowY;
      if (overflow !== "auto" && overflow !== "scroll") continue;
      const area = element.clientWidth * element.clientHeight;
      if (area > bestArea) {
        best = element;
        bestArea = area;
      }
    }
    return best;
  }

  function pick(token: string) {
    pickerCleanup?.();
    pickerToken = token;
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      border: "2px solid #1473e6",
      background: "rgba(20,115,230,.12)",
      color: "#fff",
      font: "12px sans-serif",
    });
    const label = document.createElement("span");
    label.style.background = "#1473e6";
    overlay.append(label);
    document.documentElement.append(overlay);
    let candidate: HTMLElement | null = null;
    const move = (event: MouseEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target === overlay)
        return;
      candidate = event.target;
      let current: HTMLElement | null = candidate;
      while (current && current !== document.body) {
        const style = getComputedStyle(current);
        if (
          /(auto|scroll)/.test(style.overflowY + style.overflowX) &&
          (current.scrollHeight > current.clientHeight ||
            current.scrollWidth > current.clientWidth)
        ) {
          candidate = current;
          break;
        }
        current = current.parentElement;
      }
      const rect = candidate.getBoundingClientRect();
      Object.assign(overlay.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      label.textContent = `${candidate.tagName.toLowerCase()} ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      overlay.remove();
      pickerCleanup = undefined;
      pickerToken = "";
    };
    const click = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!candidate) return;
      if (candidate instanceof HTMLIFrameElement) {
        const child = candidate.contentWindow;
        let index = -1;
        for (let i = 0; i < window.length; i++)
          if (window.frames[i] === child) {
            index = i;
            break;
          }
        pickedWindow = child;
        pickedWindowToken = token;
        cleanup();
        void chrome.runtime.sendMessage(
          makeRequest("broker", index < 0 ? "pick-error" : "picked-frame", {
            token,
            index,
            error: "Cannot identify selected frame",
          }),
        );
        return;
      }
      selected = candidate;
      selectionToken = token;
      cleanup();
      void chrome.runtime.sendMessage(
        makeRequest("broker", "picked", { token }),
      );
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cleanup();
      void chrome.runtime.sendMessage(
        makeRequest("broker", "pick-error", {
          token,
          error: "Selection cancelled",
        }),
      );
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    pickerCleanup = cleanup;
    setTimeout(() => {
      if (pickerCleanup === cleanup) cleanup();
    }, 30000);
  }

  chrome.runtime.onMessage.addListener(
    (message: ContentMessage, sender, respond) => {
      if (
        sender.id !== chrome.runtime.id ||
        !message ||
        message.channel !== "local-capture" ||
        typeof message.command !== "string"
      )
        return;
      void (async () => {
        switch (message.command) {
          case "check-picked-frame": {
            const data = message.data as { token: string; index: number };
            if (
              !data ||
              data.token !== pickedWindowToken ||
              !pickedWindow ||
              window.frames[data.index] !== pickedWindow
            )
              throw new Error("Selected frame changed");
            return null;
          }
          case "select-frame": {
            const data = message.data as PickerData;
            if (!data || data.token !== pickerToken || !pickerCleanup)
              throw new Error("Frame picker expired");
            selected = document.documentElement;
            selectionToken = data.token;
            pickerCleanup();
            return null;
          }
          case "frame-link":
            return {
              index:
                window === window.top ? -1 : frameIndex(window.parent, window),
              width: innerWidth,
              height: innerHeight,
            };
          case "frame-geometry": {
            const data = message.data as {
              index: number;
              width: number;
              height: number;
            };
            return frameGeometry(data.index, data.width, data.height);
          }
          case "pick": {
            const data = message.data as PickerData;
            if (!data || typeof data.token !== "string")
              throw new Error("Invalid picker token");
            pick(data.token);
            return null;
          }
          case "prepare": {
            const data = message.data as
              | { mode?: string; token?: string; imageWaitMs?: number }
              | undefined;
            if (active) restore();
            if (data?.mode === "element") {
              if (
                !selected ||
                data.token !== selectionToken ||
                !selected.isConnected
              )
                throw new Error("Selected element is no longer available");
              if (selected instanceof HTMLIFrameElement)
                throw new Error(
                  "Frame capture is not supported for this selection",
                );
              for (
                let element: HTMLElement | null = selected;
                element;
                element = element.parentElement
              ) {
                const style = getComputedStyle(element);
                if (
                  (style.translate && style.translate !== "none") ||
                  (style.rotate && style.rotate !== "none") ||
                  (style.scale && style.scale !== "none") ||
                  (style.perspective && style.perspective !== "none")
                )
                  throw new Error("Unsupported transformed element ancestor");
                const transform = style.transform;
                if (transform !== "none") {
                  const matrix = new DOMMatrixReadOnly(transform);
                  if (
                    !matrix.is2D ||
                    matrix.b !== 0 ||
                    matrix.c !== 0 ||
                    matrix.a <= 0 ||
                    matrix.d <= 0
                  )
                    throw new Error(
                      "Rotated or skewed element capture is not supported",
                    );
                }
              }
              scroller =
                selected === document.documentElement ? null : selected;
              autoScroller = false;
            } else {
              scroller = dominantScroller();
              autoScroller = !!scroller;
            }
            originalX = scroller ? scroller.scrollLeft : scrollX;
            originalY = scroller ? scroller.scrollTop : scrollY;
            reverseY =
              !!scroller &&
              getComputedStyle(scroller).flexDirection === "column-reverse";
            active = true;
            // Scrollbars are browser chrome, not page content; hide the ones
            // the capture scrolls so they are not stitched into the image.
            for (const element of new Set([
              document.documentElement,
              ...(scroller ? [scroller] : []),
            ])) {
              scrollbarStyles.push({
                element,
                value: element.style.getPropertyValue("scrollbar-width"),
                priority: element.style.getPropertyPriority("scrollbar-width"),
              });
              element.style.setProperty("scrollbar-width", "none", "important");
            }
            const scrollElement = scroller ?? document.documentElement;
            scrollStyle = {
              element: scrollElement,
              value: scrollElement.style.getPropertyValue("scroll-behavior"),
              priority:
                scrollElement.style.getPropertyPriority("scroll-behavior"),
            };
            scrollElement.style.setProperty(
              "scroll-behavior",
              "auto",
              "important",
            );
            if (
              typeof data?.imageWaitMs === "number" &&
              Number.isFinite(data.imageWaitMs)
            )
              imageWaitMs = Math.max(0, Math.min(60000, data.imageWaitMs));
            if (
              scroller instanceof HTMLCanvasElement &&
              scroller.dataset.offset !== undefined
            ) {
              const element = scroller;
              const original = Number(element.dataset.offset);
              const wheel = (deltaY: number) =>
                element.dispatchEvent(
                  new WheelEvent("wheel", {
                    deltaY,
                    bubbles: true,
                    cancelable: true,
                  }),
                );
              if (!Number.isFinite(original))
                throw new Error("Invalid canvas position");
              canvasRange = { element, min: original, max: original, original };
              wheel(-10000000);
              const min = Number(element.dataset.offset);
              wheel(10000000);
              const max = Number(element.dataset.offset);
              wheel(original - max);
              if (
                ![min, max, Number(element.dataset.offset)].every(
                  Number.isFinite,
                ) ||
                max < min ||
                Number(element.dataset.offset) !== original
              )
                throw new Error("Canvas wheel position is not reversible");
              canvasRange = { element, min, max, original };
            }
            renew();
            await ready();
            return mappedInfo();
          }
          case "info":
            renew();
            return mappedInfo();
          case "heartbeat":
            renew();
            return null;
          case "scroll": {
            const data = message.data as
              | { x?: number; y?: number; hideFixed?: boolean }
              | undefined;
            if (
              !data ||
              typeof data.x !== "number" ||
              typeof data.y !== "number" ||
              !Number.isFinite(data.x) ||
              !Number.isFinite(data.y)
            )
              throw new Error("Invalid scroll position");
            if (data.hideFixed) {
              for (const element of document.querySelectorAll<HTMLElement>(
                "body *",
              )) {
                const position = getComputedStyle(element).position;
                if (
                  position === "sticky" &&
                  scroller &&
                  element !== scroller &&
                  scroller.contains(element)
                ) {
                  // Sticky content inside the captured scroller belongs to the
                  // page flow. Hide it only while it is displaced from its
                  // natural position, so it is not repeated across tiles.
                  if (
                    hidden.some((entry) => entry.element === element) ||
                    !stuck(element)
                  )
                    continue;
                }
                const rect = element.getBoundingClientRect();
                if (
                  (position === "fixed" || position === "sticky") &&
                  !hidden.some((entry) => entry.element === element) &&
                  !(scroller && element.contains(scroller)) &&
                  rect.right > 0 &&
                  rect.bottom > 0 &&
                  rect.left < innerWidth &&
                  rect.top < innerHeight &&
                  getComputedStyle(element).visibility !== "hidden"
                ) {
                  hidden.push({
                    element,
                    visibility: element.style.getPropertyValue("visibility"),
                    priority: element.style.getPropertyPriority("visibility"),
                  });
                  element.style.setProperty(
                    "visibility",
                    "hidden",
                    "important",
                  );
                }
              }
            }
            if (canvasRange) {
              const current = Number(canvasRange.element.dataset.offset);
              canvasRange.element.dispatchEvent(
                new WheelEvent("wheel", {
                  deltaY: data.y + canvasRange.min - current,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            } else if (scroller)
              scroller.scrollTo(
                data.x,
                data.y -
                  (reverseY
                    ? scroller.scrollHeight - scroller.clientHeight
                    : 0),
              );
            else window.scrollTo(data.x, data.y);
            renew();
            await ready();
            return mappedInfo();
          }
          case "restore":
            restore();
            return null;
          case "cancel-pick":
            pickerCleanup?.();
            return null;
          default:
            throw new Error("Unknown content command");
        }
      })().then(
        (value) => respond({ ok: true, value }),
        (error) => {
          restore();
          respond({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      return true;
    },
  );
}
