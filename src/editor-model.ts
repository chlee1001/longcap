import type {
  Annotation,
  EditDocument,
  Point,
  Rect,
} from "./shared/contracts.js";

export function normalizedRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function hitTest(
  annotations: Annotation[],
  point: Point,
): Annotation | undefined {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    const tolerance = Math.max(3, a.lineWidth / 2);
    const r = a.rect;
    if (
      point.x >= r.x - tolerance &&
      point.x <= r.x + r.width + tolerance &&
      point.y >= r.y - tolerance &&
      point.y <= r.y + r.height + tolerance
    )
      return a;
  }
  return undefined;
}

export function moveAnnotation(
  a: Annotation,
  dx: number,
  dy: number,
): Annotation {
  return {
    ...a,
    rect: { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy },
    points: a.points?.map((p) => ({ x: p.x + dx, y: p.y + dy })),
  };
}

export function resizeAnnotation(a: Annotation, newRect: Rect): Annotation {
  const sx = a.rect.width ? newRect.width / a.rect.width : 1;
  const sy = a.rect.height ? newRect.height / a.rect.height : 1;
  return {
    ...a,
    rect: { ...newRect },
    points: a.points?.map((p) => ({
      x: newRect.x + (p.x - a.rect.x) * sx,
      y: newRect.y + (p.y - a.rect.y) * sy,
    })),
    fontSize: a.fontSize === undefined ? undefined : a.fontSize * sy,
  };
}

export class EditorHistory {
  private snapshots: EditDocument[];
  private index = 0;
  constructor(initial: EditDocument) {
    this.snapshots = [structuredClone(initial)];
  }
  get value(): EditDocument {
    return structuredClone(this.snapshots[this.index]);
  }
  get canUndo(): boolean {
    return this.index > 0;
  }
  get canRedo(): boolean {
    return this.index < this.snapshots.length - 1;
  }
  commit(next: EditDocument): void {
    this.snapshots = this.snapshots.slice(0, this.index + 1);
    this.snapshots.push(structuredClone(next));
    if (this.snapshots.length > 100) this.snapshots.shift();
    this.index = this.snapshots.length - 1;
  }
  undo(): EditDocument {
    if (this.canUndo) this.index--;
    return this.value;
  }
  redo(): EditDocument {
    if (this.canRedo) this.index++;
    return this.value;
  }
}

export function nextBadge(annotations: Annotation[]): number {
  const used = new Set(
    annotations.filter((a) => a.type === "badge").map((a) => a.number),
  );
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
