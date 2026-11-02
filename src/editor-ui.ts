import type {
  Annotation,
  CaptureRecord,
  EditDocument,
  Point,
  Rect,
  Settings,
  Tool,
} from "./shared/contracts.js";
import {
  EditorHistory,
  hitTest,
  moveAnnotation,
  nextBadge,
  normalizedRect,
  resizeAnnotation,
} from "./editor-model.js";
import {
  clearTileBitmaps,
  getOutputRect,
  getTemplateInsets,
  renderRegion,
} from "./render.js";
import { updateCapture } from "./storage.js";
import { exportCapture, exportRecord } from "./export.js";
import { downloadFiles, requestDownloadPermission } from "./downloads.js";
import { clipboardScale, guardUnsavedChanges } from "./editor-safety.js";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing editor control: ${id}`);
  return node as T;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("PNG encoding failed")),
      "image/png",
    ),
  );
}

type Gesture = {
  start: Point;
  current: Point;
  base: EditDocument;
  original?: Annotation;
  corner?: number;
  points: Point[];
  duplicate: boolean;
  id: string;
};

export class EditorController {
  private record: CaptureRecord;
  private history: EditorHistory;
  private readonly abort = new AbortController();
  private readonly viewport = element<HTMLDivElement>("editorViewport");
  private scrollFrame = 0;
  private chain = 0;
  private thumb: HTMLCanvasElement | null = null;
  private thumbKey = "";
  private thumbTimer: ReturnType<typeof setTimeout> | undefined;
  private thumbToken = 0;
  private rendered: {
    zoom: number;
    left: number;
    width: number;
    top: number;
    height: number;
  } | null = null;
  private readonly surface = element<HTMLDivElement>("editorSurface");
  private readonly canvas = element<HTMLCanvasElement>("editorCanvas");
  private readonly title = element<HTMLInputElement>("captureTitle");
  private readonly status = element<HTMLElement>("saveState");
  private readonly layers = element<HTMLUListElement>("layers");
  private readonly observer: ResizeObserver;
  private tool: Tool = "select";
  private selected: string | null = null;
  private clipboard: Annotation | null = null;
  private gesture: Gesture | null = null;
  private draft: EditDocument | null = null;
  private zoom = 1;
  private version = 0;
  private savedVersion = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private disposed = false;
  private renderToken = 0;

  constructor(
    record: CaptureRecord,
    private readonly settings: Settings,
    private readonly notify: (message: string, error?: boolean) => void,
  ) {
    this.record = structuredClone(record);
    this.history = new EditorHistory(record.edit);
    guardUnsavedChanges(
      window,
      () =>
        this.version !== this.savedVersion ||
        this.saving !== null ||
        this.draft !== null,
      this.abort.signal,
    );
    this.title.value = record.title;
    element<HTMLSelectElement>("exportFormat").value = settings.format;
    this.listen(this.title, "input", () => this.changed());
    this.listen(element("undo"), "click", () => {
      if (this.history.canUndo) {
        this.history.undo();
        this.selected = null;
        this.changed();
      }
    });
    this.listen(element("redo"), "click", () => {
      if (this.history.canRedo) {
        this.history.redo();
        this.selected = null;
        this.changed();
      }
    });
    this.listen(element("duplicate"), "click", () => this.duplicate());
    this.listen(element("deleteObject"), "click", () => this.remove());
    this.listen(element("bringForward"), "click", () => this.reorder(1));
    this.listen(element("sendBackward"), "click", () => this.reorder(-1));
    this.listen(element<HTMLSelectElement>("zoom"), "change", () => {
      this.zoom = Number(element<HTMLSelectElement>("zoom").value);
      this.redraw();
    });
    this.listen(element("fit"), "click", () => this.fit());
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "#toolButtons [data-tool]",
    )) {
      this.listen(button, "click", () => {
        this.tool = button.dataset.tool as Tool;
        this.gesture = null;
        this.draft = null;
        this.sync();
        this.redraw();
      });
    }
    for (const id of [
      "strokeColor",
      "fillColor",
      "fillNone",
      "lineWidth",
      "fontSize",
      "redactMode",
      "arrowHeads",
    ]) {
      this.listen(element(id), "change", () => this.applyStyle());
    }
    this.listen(element("applyText"), "click", () =>
      this.updateSelected((a) => ({
        ...a,
        text: element<HTMLTextAreaElement>("annotationText").value,
      })),
    );
    this.listen(element<HTMLSelectElement>("urlTemplate"), "change", () => {
      const edit = this.history.value;
      edit.template = element<HTMLSelectElement>("urlTemplate")
        .value as EditDocument["template"];
      this.commit(edit);
    });
    this.listen(element<HTMLSelectElement>("dateFormat"), "change", () => {
      const edit = this.history.value;
      edit.dateFormat = element<HTMLSelectElement>("dateFormat")
        .value as EditDocument["dateFormat"];
      this.commit(edit);
    });
    this.listen(this.viewport, "scroll", () => {
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0;
        this.chain = 0;
        this.redraw(true);
      });
    });
    this.listen(this.canvas, "pointerdown", (event) =>
      this.pointerDown(event as PointerEvent),
    );
    this.listen(this.canvas, "pointermove", (event) =>
      this.pointerMove(event as PointerEvent),
    );
    this.listen(this.canvas, "pointerup", (event) =>
      this.pointerUp(event as PointerEvent),
    );
    this.listen(this.canvas, "pointercancel", () => {
      this.gesture = null;
      this.draft = null;
      this.redraw();
    });
    this.listen(document, "keydown", (event) =>
      this.key(event as KeyboardEvent),
    );
    this.listen(element("editToggle"), "click", () => {
      const section = element("editorView"),
        editing = section.dataset.mode !== "edit";
      section.dataset.mode = editing ? "edit" : "view";
      element("editToggle").textContent = editing ? "완료" : "편집";
      element("editToggle").setAttribute("aria-pressed", String(editing));
      this.selected = null;
      this.gesture = null;
      this.draft = null;
      this.sync();
      this.fit();
    });
    this.listen(element("exportButton"), "click", () => {
      const permission = requestDownloadPermission();
      void this.exportFile(permission).catch((error) =>
        this.notify(message(error), true),
      );
    });
    this.listen(element("copyButton"), "click", () => this.copyImage());
    this.listen(element("printButton"), "click", () => {
      void this.print().catch((error) => this.notify(message(error), true));
    });
    this.observer = new ResizeObserver(() => this.redraw());
    this.observer.observe(this.viewport);
    this.status.textContent = "저장됨";
    this.sync();
    this.redraw();
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
  ): void {
    target.addEventListener(type, listener, { signal: this.abort.signal });
  }
  private input(id: string): HTMLInputElement {
    return element<HTMLInputElement>(id);
  }
  private style(): Pick<
    Annotation,
    "color" | "fill" | "lineWidth" | "fontSize" | "mode" | "heads"
  > {
    return {
      color: this.input("strokeColor").value,
      fill: this.input("fillNone").checked
        ? "transparent"
        : this.input("fillColor").value,
      lineWidth: Math.max(
        1,
        Math.min(24, Number(this.input("lineWidth").value) || 1),
      ),
      fontSize: Math.max(
        12,
        Math.min(96, Number(this.input("fontSize").value) || 12),
      ),
      mode:
        element<HTMLSelectElement>("redactMode").value === "pixel"
          ? "pixel"
          : "blur",
      heads:
        element<HTMLSelectElement>("arrowHeads").value === "both"
          ? "both"
          : "end",
    };
  }
  private applyStyle(): void {
    this.updateSelected((a) => ({
      ...a,
      ...this.style(),
      fill:
        a.type === "badge" && this.input("fillNone").checked
          ? "#ffffff"
          : this.style().fill,
    }));
  }
  private updateSelected(update: (a: Annotation) => Annotation): void {
    const edit = this.history.value,
      index = edit.annotations.findIndex((a) => a.id === this.selected);
    if (index < 0) return;
    edit.annotations[index] = update(edit.annotations[index]);
    this.commit(edit);
  }
  private commit(edit: EditDocument): void {
    if (JSON.stringify(edit) === JSON.stringify(this.history.value)) return;
    this.history.commit(edit);
    this.changed();
  }
  private changed(): void {
    this.version++;
    this.status.textContent = "저장되지 않음";
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 250);
    this.sync();
    this.redraw();
  }
  private async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.saving) {
      await this.saving;
      if (this.savedVersion === this.version) return;
    }
    if (this.savedVersion === this.version) return;
    const work = async () => {
      while (this.savedVersion !== this.version) {
        const version = this.version,
          edit = this.history.value,
          title = this.title.value;
        this.status.textContent = "저장 중";
        try {
          this.record = await updateCapture(
            this.record.id,
            this.record.revision,
            { edit, title },
          );
        } catch (error) {
          this.status.textContent = `저장 오류: ${message(error)}`;
          this.notify(message(error), true);
          throw error;
        }
        this.savedVersion = version;
      }
      this.status.textContent = "저장됨";
    };
    this.saving = work();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }
  close(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closing = this.flush()
      .then(() => {
        this.disposed = true;
        this.renderToken++;
        this.abort.abort();
        this.observer.disconnect();
        clearTimeout(this.saveTimer);
        clearTimeout(this.thumbTimer);
        this.thumbToken++;
        if (this.thumb) {
          this.thumb.width = 0;
          this.thumb.height = 0;
        }
        this.canvas.width = 0;
        this.canvas.height = 0;
        clearTileBitmaps();
      })
      .finally(() => {
        this.closing = null;
      });
    return this.closing;
  }
  private viewRecord(): CaptureRecord {
    const edit = structuredClone(this.draft ?? this.history.value);
    if (this.tool === "crop") {
      edit.crop = null;
      edit.template = "none";
    }
    return exportRecord({ ...this.record, edit }, this.settings);
  }
  private point(event: PointerEvent): Point {
    const bounds = this.surface.getBoundingClientRect(),
      record = this.viewRecord(),
      crop = record.edit.crop ?? {
        x: 0,
        y: 0,
        width: record.width,
        height: record.height,
      };
    return {
      x: (event.clientX - bounds.left) / this.zoom + crop.x,
      y:
        (event.clientY - bounds.top) / this.zoom +
        crop.y -
        getTemplateInsets(record).top,
    };
  }
  private corners(rect: Rect): Point[] {
    return [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height },
    ];
  }
  private bounded(point: Point): Point {
    return {
      x: Math.max(0, Math.min(this.record.width, point.x)),
      y: Math.max(0, Math.min(this.record.height, point.y)),
    };
  }
  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.viewport.focus({ preventScroll: true });
    this.canvas.setPointerCapture(event.pointerId);
    const point = this.bounded(this.point(event)),
      base = this.history.value;
    let original: Annotation | undefined, corner: number | undefined;
    if (this.tool === "select") {
      original = base.annotations.find((a) => a.id === this.selected);
      const handle = original
        ? this.corners(original.rect).findIndex(
            (p) => Math.hypot(p.x - point.x, p.y - point.y) <= 8 / this.zoom,
          )
        : -1;
      if (handle >= 0) corner = handle;
      else original = hitTest(base.annotations, point);
      this.selected = original?.id ?? null;
    }
    this.gesture = {
      start: point,
      current: point,
      base,
      original,
      corner,
      points: [point],
      duplicate: event.altKey && !!original && corner === undefined,
      id: crypto.randomUUID(),
    };
    this.sync();
    this.redraw();
  }
  private pointerMove(event: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    g.current = this.bounded(this.point(event));
    if (this.tool === "pen" || this.tool === "marker") g.points.push(g.current);
    const edit = structuredClone(g.base);
    if (this.tool === "select" && g.original) {
      let result: Annotation;
      if (g.corner !== undefined) {
        const rect = normalizedRect(
          this.corners(g.original.rect)[(g.corner + 2) % 4],
          g.current,
        );
        result = resizeAnnotation(g.original, {
          ...rect,
          width: Math.max(1, rect.width),
          height: Math.max(1, rect.height),
        });
      } else
        result = moveAnnotation(
          g.original,
          g.current.x - g.start.x,
          g.current.y - g.start.y,
        );
      if (g.duplicate) {
        result.id = g.id;
        if (result.type === "badge")
          result.number = nextBadge(edit.annotations);
        edit.annotations.push(result);
      } else
        edit.annotations = edit.annotations.map((a) =>
          a.id === result.id ? result : a,
        );
    } else if (this.tool !== "select" && this.tool !== "crop") {
      const annotation = this.annotation(g);
      if (annotation.rect.width > 0 && annotation.rect.height > 0)
        edit.annotations.push(annotation);
    }
    this.draft = edit;
    this.redraw();
  }
  /** Fit the whole output into the viewport (max 100%), shown as an extra zoom option. */
  fit(): void {
    const output = getOutputRect(this.viewRecord()),
      select = element<HTMLSelectElement>("zoom"),
      available = this.viewport.clientWidth;
    if (available <= 0 || output.width <= 0) return;
    const want = Math.min(
      1,
      available / output.width,
      this.viewport.clientHeight / output.height,
    );
    this.zoom = Math.max(0.01, want);
    select.querySelector("option[data-fit]")?.remove();
    if (
      !Array.from(select.options).some((o) => Number(o.value) === this.zoom)
    ) {
      const option = document.createElement("option");
      option.dataset.fit = "";
      option.value = String(this.zoom);
      option.textContent = `${Math.floor(this.zoom * 100)}%`;
      select.append(option);
    }
    select.value = String(this.zoom);
    this.redraw();
  }
  private annotation(g: Gesture): Annotation {
    const type = this.tool;
    if (type === "select" || type === "crop")
      throw new Error("Invalid annotation tool");
    const points =
      type === "pen" || type === "marker" ? g.points : [g.start, g.current];
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y);
    let rect = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
    };
    if (
      (type === "text" || type === "badge") &&
      Math.hypot(g.current.x - g.start.x, g.current.y - g.start.y) < 3
    )
      rect = {
        x: g.start.x,
        y: g.start.y,
        width: type === "badge" ? 36 : 180,
        height: type === "badge" ? 36 : this.style().fontSize! * 1.2,
      };
    const style = this.style();
    return {
      id: g.id,
      type,
      rect,
      ...style,
      fill:
        type === "badge" && style.fill === "transparent"
          ? "#ffffff"
          : style.fill,
      ...(type === "line" ||
      type === "arrow" ||
      type === "pen" ||
      type === "marker"
        ? { points: structuredClone(points) }
        : {}),
      ...(type === "text"
        ? { text: element<HTMLTextAreaElement>("annotationText").value }
        : {}),
      ...(type === "badge" ? { number: nextBadge(g.base.annotations) } : {}),
    };
  }
  private pointerUp(event: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    this.pointerMove(event);
    if (this.tool === "crop") {
      const rect = normalizedRect(g.start, g.current);
      if (rect.width >= 1 && rect.height >= 1) {
        const edit = this.history.value;
        edit.crop = rect;
        this.commit(edit);
      }
    } else if (this.tool === "select") {
      if (
        this.draft &&
        g.original &&
        Math.hypot(g.current.x - g.start.x, g.current.y - g.start.y) > 0
      ) {
        if (g.duplicate)
          this.selected =
            this.draft.annotations[this.draft.annotations.length - 1].id;
        this.commit(this.draft);
      }
    } else {
      const edit = this.history.value,
        annotation = this.annotation(g);
      edit.annotations.push(annotation);
      this.selected = annotation.id;
      this.commit(edit);
    }
    this.gesture = null;
    this.draft = null;
    this.sync();
    this.redraw();
  }
  private duplicate(): void {
    const edit = this.history.value,
      source = edit.annotations.find((a) => a.id === this.selected);
    if (!source) return;
    const copy = moveAnnotation(source, 10, 10);
    copy.id = crypto.randomUUID();
    if (copy.type === "badge") copy.number = nextBadge(edit.annotations);
    edit.annotations.push(copy);
    this.selected = copy.id;
    this.commit(edit);
  }
  private remove(): void {
    const edit = this.history.value;
    const count = edit.annotations.length;
    edit.annotations = edit.annotations.filter((a) => a.id !== this.selected);
    this.selected = null;
    if (edit.annotations.length !== count) this.commit(edit);
  }
  private reorder(direction: number): void {
    const edit = this.history.value,
      index = edit.annotations.findIndex((a) => a.id === this.selected),
      next = index + direction;
    if (index < 0 || next < 0 || next >= edit.annotations.length) return;
    [edit.annotations[index], edit.annotations[next]] = [
      edit.annotations[next],
      edit.annotations[index],
    ];
    this.commit(edit);
  }
  private key(event: KeyboardEvent): void {
    if (element("editorView").dataset.mode !== "edit") return;
    const target = event.target;
    if (
      event.isComposing ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    )
      return;
    const mod = event.ctrlKey || event.metaKey,
      key = event.key.toLowerCase();
    if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey ? this.history.canRedo : this.history.canUndo) {
        event.shiftKey ? this.history.redo() : this.history.undo();
        this.selected = null;
        this.changed();
      }
    } else if (mod && key === "y") {
      event.preventDefault();
      if (this.history.canRedo) {
        this.history.redo();
        this.selected = null;
        this.changed();
      }
    } else if (mod && key === "c") {
      const a = this.history.value.annotations.find(
        (item) => item.id === this.selected,
      );
      if (a) {
        event.preventDefault();
        this.clipboard = structuredClone(a);
      }
    } else if (mod && key === "v" && this.clipboard) {
      event.preventDefault();
      const edit = this.history.value,
        a = moveAnnotation(this.clipboard, 10, 10);
      a.id = crypto.randomUUID();
      if (a.type === "badge") a.number = nextBadge(edit.annotations);
      edit.annotations.push(a);
      this.selected = a.id;
      this.clipboard = structuredClone(a);
      this.commit(edit);
    } else if (key === "delete" || key === "backspace") {
      if (this.selected) {
        event.preventDefault();
        this.remove();
      }
    } else if (
      ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key) &&
      this.selected
    ) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      this.updateSelected((a) =>
        moveAnnotation(
          a,
          key === "arrowleft" ? -step : key === "arrowright" ? step : 0,
          key === "arrowup" ? -step : key === "arrowdown" ? step : 0,
        ),
      );
    }
  }
  private sync(): void {
    const edit = this.history.value,
      selected = edit.annotations.find((a) => a.id === this.selected);
    element<HTMLButtonElement>("undo").disabled = !this.history.canUndo;
    element<HTMLButtonElement>("redo").disabled = !this.history.canRedo;
    for (const id of [
      "duplicate",
      "deleteObject",
      "bringForward",
      "sendBackward",
    ])
      element<HTMLButtonElement>(id).disabled = !selected;
    element<HTMLSelectElement>("urlTemplate").value = edit.template;
    element<HTMLSelectElement>("dateFormat").value = edit.dateFormat;
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "#toolButtons [data-tool]",
    ))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.tool === this.tool),
      );
    if (selected) {
      if (/^#[0-9a-f]{6}$/i.test(selected.color))
        this.input("strokeColor").value = selected.color;
      this.input("fillNone").checked = selected.fill === "transparent";
      if (/^#[0-9a-f]{6}$/i.test(selected.fill))
        this.input("fillColor").value = selected.fill;
      this.input("lineWidth").value = String(selected.lineWidth);
      this.input("fontSize").value = String(selected.fontSize ?? 24);
      element<HTMLSelectElement>("redactMode").value = selected.mode ?? "blur";
      element<HTMLSelectElement>("arrowHeads").value = selected.heads ?? "end";
      if (selected.type === "text")
        element<HTMLTextAreaElement>("annotationText").value =
          selected.text ?? "";
    }
    this.layers.replaceChildren();
    for (const annotation of [...edit.annotations].reverse()) {
      const li = document.createElement("li"),
        button = document.createElement("button");
      button.type = "button";
      button.textContent =
        annotation.type === "badge"
          ? `badge ${annotation.number}`
          : annotation.type === "text"
            ? `text ${annotation.text ?? ""}`
            : annotation.type;
      button.setAttribute(
        "aria-pressed",
        String(annotation.id === this.selected),
      );
      button.addEventListener(
        "click",
        () => {
          this.selected = annotation.id;
          this.tool = "select";
          this.sync();
          this.redraw();
        },
        { signal: this.abort.signal },
      );
      li.append(button);
      this.layers.append(li);
    }
  }
  private redraw(fromScroll = false): void {
    if (this.disposed) return;
    const token = this.renderToken + 1,
      record = this.viewRecord(),
      output = getOutputRect(record),
      dpr = window.devicePixelRatio || 1;
    this.surface.style.width = `${output.width * this.zoom}px`;
    this.surface.style.height = `${output.height * this.zoom}px`;
    element("dims").textContent =
      `${Math.round(output.width * record.scale)}×${Math.round(output.height * record.scale)} px`;
    if (this.rendered && this.rendered.zoom !== this.zoom) {
      // A stale canvas from another zoom must not extend the scroll area.
      this.canvas.style.top = "0px";
      this.canvas.style.height = "0px";
      this.rendered = null;
    }
    if (!fromScroll) this.scheduleThumb(record, output);
    const total = output.height * this.zoom,
      viewH = this.viewport.clientHeight,
      left = this.viewport.scrollLeft,
      scrollTop = Math.min(
        this.viewport.scrollTop,
        Math.max(0, output.height * this.zoom - this.viewport.clientHeight),
      ),
      width = Math.min(
        this.viewport.clientWidth,
        Math.max(0, output.width * this.zoom - left),
      );
    const rendered = this.rendered;
    if (
      fromScroll &&
      rendered &&
      rendered.zoom === this.zoom &&
      rendered.left === left &&
      rendered.width === width &&
      scrollTop >= rendered.top &&
      Math.min(scrollTop + viewH, total) <= rendered.top + rendered.height + 1
    )
      return;
    this.renderToken = token;
    const maxHeight = Math.min(
      32767 / dpr,
      8_000_000 / Math.max(1, width * dpr * dpr),
    );
    const pad = Math.max(0, Math.min(viewH / 2, (maxHeight - viewH) / 2)),
      top = Math.max(0, scrollTop - pad),
      height = Math.min(total, scrollTop + viewH + pad) - top;
    if (width <= 0 || height <= 0) return;
    const scale = this.zoom * dpr,
      region = {
        x: left / this.zoom,
        y: top / this.zoom,
        width: Math.min(width / this.zoom, output.width - left / this.zoom),
        height: Math.min(height / this.zoom, output.height - top / this.zoom),
      };
    void renderRegion(record, region, scale)
      .then((image) => {
        if (token !== this.renderToken || this.disposed) {
          image.width = 0;
          image.height = 0;
          return;
        }
        this.canvas.width = image.width;
        this.canvas.height = image.height;
        this.canvas.style.left = `${left}px`;
        this.canvas.style.top = `${top}px`;
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        this.rendered = { zoom: this.zoom, left, width, top, height };
        const nowTop = this.viewport.scrollTop,
          nowLeft = this.viewport.scrollLeft;
        if (
          (nowLeft !== left ||
            nowTop < top ||
            Math.min(nowTop + this.viewport.clientHeight, total) >
              top + height + 1) &&
          this.chain++ < 2
        )
          queueMicrotask(() => this.redraw());
        const ctx = this.canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable");
        ctx.drawImage(image, 0, 0);
        image.width = 0;
        image.height = 0;
        const crop = record.edit.crop ?? {
            x: 0,
            y: 0,
            width: record.width,
            height: record.height,
          },
          inset = getTemplateInsets(record).top;
        const drawRect = (rect: Rect, handles: boolean) => {
          const x = (rect.x - crop.x - region.x) * scale,
            y = (rect.y - crop.y + inset - region.y) * scale,
            w = rect.width * scale,
            h = rect.height * scale;
          ctx.save();
          ctx.strokeStyle = "#006ee6";
          ctx.lineWidth = dpr;
          ctx.setLineDash([5 * dpr, 4 * dpr]);
          ctx.strokeRect(x, y, w, h);
          ctx.setLineDash([]);
          if (handles)
            for (const p of [
              { x, y },
              { x: x + w, y },
              { x: x + w, y: y + h },
              { x, y: y + h },
            ]) {
              ctx.fillStyle = "#fff";
              ctx.fillRect(p.x - 4 * dpr, p.y - 4 * dpr, 8 * dpr, 8 * dpr);
              ctx.strokeRect(p.x - 4 * dpr, p.y - 4 * dpr, 8 * dpr, 8 * dpr);
            }
          ctx.restore();
        };
        if (this.tool === "crop") {
          const r = this.gesture
            ? normalizedRect(this.gesture.start, this.gesture.current)
            : this.history.value.crop;
          if (r) drawRect(r, false);
        } else if (this.tool === "select") {
          const a = (this.draft ?? this.history.value).annotations.find(
            (item) => item.id === this.selected,
          );
          if (a) drawRect(a.rect, true);
        }
      })
      .catch((error) => {
        if (token === this.renderToken && !this.disposed)
          this.notify(message(error), true);
      });
  }
  /** Low-resolution whole-page backdrop so fast scrolling never shows blank. */
  private scheduleThumb(record: CaptureRecord, output: Rect): void {
    const key = JSON.stringify([record.edit, output, record.id]);
    if (key === this.thumbKey) return;
    this.thumbKey = key;
    clearTimeout(this.thumbTimer);
    const token = ++this.thumbToken;
    this.thumbTimer = setTimeout(
      () => {
        const scale = Math.min(
          1,
          Math.sqrt(5_000_000 / (output.width * output.height)),
        );
        void renderRegion(record, output, scale)
          .then((image) => {
            if (token !== this.thumbToken || this.disposed) {
              image.width = 0;
              image.height = 0;
              return;
            }
            if (!this.thumb) {
              this.thumb = document.createElement("canvas");
              this.thumb.className = "editor-thumb";
              this.surface.prepend(this.thumb);
            }
            this.thumb.width = image.width;
            this.thumb.height = image.height;
            this.thumb.getContext("2d")?.drawImage(image, 0, 0);
            image.width = 0;
            image.height = 0;
          })
          .catch(() => undefined);
      },
      this.thumb ? 400 : 0,
    );
  }
  private async snapshot(): Promise<CaptureRecord> {
    await this.flush();
    return structuredClone(this.record);
  }
  private async exportFile(permission: Promise<boolean>): Promise<void> {
    if (!(await permission))
      throw new Error("Downloads permission is required");
    const record = await this.snapshot(),
      settings = {
        ...this.settings,
        format: element<HTMLSelectElement>("exportFormat")
          .value as Settings["format"],
      };
    await downloadFiles(await exportCapture(record, settings), settings);
    this.notify("내보내기 완료");
  }
  private copyImage(): void {
    const permission = chrome.permissions.request({
      permissions: ["clipboardWrite"],
    });
    const blob = (async () => {
      if (!(await permission))
        throw new Error("Clipboard permission is required");
      const record = exportRecord(await this.snapshot(), this.settings);
      const output = getOutputRect(record);
      const scale = clipboardScale(
        output,
        record.scale,
        this.settings.clipboardFit,
        record.edit.annotations.filter((a) => a.type === "redact").length,
      );
      const canvas = await renderRegion(record, output, scale);
      try {
        return await canvasBlob(canvas);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    })();
    try {
      void navigator.clipboard
        .write([new ClipboardItem({ "image/png": blob })])
        .then(() => this.notify("복사 완료"))
        .catch((error) => this.notify(message(error), true));
    } catch (error) {
      void blob.catch(() => {});
      this.notify(message(error), true);
    }
  }
  private async print(): Promise<void> {
    const record = exportRecord(await this.snapshot(), this.settings);
    const output = getOutputRect(record),
      frame = document.createElement("iframe"),
      urls: string[] = [];
    frame.style.position = "fixed";
    frame.style.width = "1px";
    frame.style.height = "1px";
    frame.style.opacity = "0";
    document.body.append(frame);
    const cleanup = () => {
      for (const url of urls) URL.revokeObjectURL(url);
      frame.remove();
    };
    try {
      const doc = frame.contentDocument,
        win = frame.contentWindow;
      if (!doc || !win) throw new Error("Print frame unavailable");
      doc.title = record.title;
      const style = doc.createElement("style");
      style.textContent =
        "body{margin:0} img{display:block;width:100%;height:auto;break-inside:avoid}";
      doc.head.append(style);
      const scale = Math.min(record.scale, 2048 / output.width),
        height = 2048 / scale;
      for (let y = 0; y < output.height; y += height) {
        const canvas = await renderRegion(
          record,
          {
            x: 0,
            y,
            width: output.width,
            height: Math.min(height, output.height - y),
          },
          scale,
        );
        let blob: Blob;
        try {
          blob = await canvasBlob(canvas);
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const img = doc.createElement("img");
        img.src = url;
        img.alt = "";
        const loaded = new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("Print image load failed"));
        });
        doc.body.append(img);
        await loaded;
      }
      win.addEventListener("afterprint", cleanup, { once: true });
      win.focus();
      win.print();
      setTimeout(cleanup, 60_000);
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}
