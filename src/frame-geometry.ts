export type FrameLink = { index: number; width: number; height: number };
export type FrameStep = { matrix: number[]; width: number; height: number };

export function assertFrameChain(
  child: {
    documentId?: string;
    parentFrameId: number;
    parentDocumentId?: string;
  } | null,
  parent: { documentId?: string } | null,
  childDocument: string,
  parentFrame: number,
  parentDocument: string,
) {
  if (
    child?.documentId !== childDocument ||
    child.parentFrameId !== parentFrame ||
    parent?.documentId !== parentDocument ||
    (child.parentDocumentId && child.parentDocumentId !== parentDocument)
  )
    throw new Error("Frame chain changed");
}

export function frameIndex(parent: Window, current: Window): number {
  const count = parent.length;
  if (count > 10000) throw new Error("Too many frames");
  for (let index = 0; index < count; index++)
    if (parent.frames[index] === current) return index;
  throw new Error("Cannot identify frame in parent");
}

export function frameGeometry(
  index: number,
  width: number,
  height: number,
): FrameStep {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    index >= window.length
  )
    throw new Error("Invalid frame geometry request");
  const child = window.frames[index];
  const frame = Array.from(document.querySelectorAll("iframe,frame")).find(
    (element) => (element as HTMLIFrameElement).contentWindow === child,
  ) as HTMLIFrameElement | undefined;
  if (!frame) throw new Error("Cannot identify frame element");
  const rect = frame.getBoundingClientRect();
  if (
    rect.left < 0 ||
    rect.top < 0 ||
    rect.right > innerWidth ||
    rect.bottom > innerHeight
  )
    throw new Error("Frame is clipped by the viewport");
  for (
    let element: Element | null = frame;
    element;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    if (
      element === frame &&
      [
        style.paddingTop,
        style.paddingRight,
        style.paddingBottom,
        style.paddingLeft,
      ].some((padding) => Number.parseFloat(padding) !== 0)
    )
      throw new Error("Unsupported frame padding");
    if (
      style.transform !== "none" ||
      (style.translate && style.translate !== "none") ||
      (style.rotate && style.rotate !== "none") ||
      (style.scale && style.scale !== "none") ||
      (style.perspective && style.perspective !== "none") ||
      (style.zoom && style.zoom !== "1" && style.zoom !== "normal")
    )
      throw new Error("Unsupported transformed or zoomed frame ancestor");
    if (
      element !== frame &&
      /(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)
    ) {
      const clip = element.getBoundingClientRect();
      if (
        rect.left < clip.left ||
        rect.top < clip.top ||
        rect.right > clip.right ||
        rect.bottom > clip.bottom
      )
        throw new Error("Frame is clipped by an ancestor");
    }
  }
  if (
    !frame.offsetWidth ||
    !frame.offsetHeight ||
    !frame.clientWidth ||
    !frame.clientHeight ||
    Math.abs(rect.width - frame.offsetWidth) > 1 ||
    Math.abs(rect.height - frame.offsetHeight) > 1
  )
    throw new Error("Unsupported frame dimensions");
  return {
    matrix: [
      frame.clientWidth / width,
      0,
      0,
      frame.clientHeight / height,
      rect.left + frame.clientLeft,
      rect.top + frame.clientTop,
    ],
    width: innerWidth,
    height: innerHeight,
  };
}

export function multiplyFrames(parent: number[], child: number[]): number[] {
  const [a, b, c, d, e, f] = parent;
  const [g, h, i, j, k, l] = child;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}
