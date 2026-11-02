import { redactionSamplingBounds } from "./render.js";
import type { Rect } from "./shared/contracts.js";

export function guardUnsavedChanges(
  target: EventTarget,
  pending: () => boolean,
  signal: AbortSignal,
): void {
  target.addEventListener(
    "beforeunload",
    (event) => {
      if (pending()) {
        event.preventDefault();
        (event as BeforeUnloadEvent).returnValue = "";
      }
    },
    { signal },
  );
}

export function clipboardScale(
  output: Rect,
  nativeScale: number,
  fit: boolean,
  redactions: number,
): number {
  if (
    ![output.x, output.y, output.width, output.height, nativeScale].every(
      Number.isFinite,
    ) ||
    output.width <= 0 ||
    output.height <= 0 ||
    nativeScale <= 0
  )
    throw new Error("Invalid clipboard dimensions or scale");
  const fits = (scale: number) => {
    const width = Math.ceil(output.width * scale),
      height = Math.ceil(output.height * scale);
    const sampling = redactionSamplingBounds(output, output, scale, redactions);
    const sampleWidth = Math.round(sampling.width * scale),
      sampleHeight = Math.round(sampling.height * scale);
    return (
      [width, height, sampleWidth, sampleHeight].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= 32767,
      ) &&
      width * height <= 16_000_000 &&
      sampleWidth * sampleHeight <= 16_000_000
    );
  };
  if (fits(nativeScale)) return nativeScale;
  if (!fit) throw new Error("Image exceeds clipboard size limit");
  let low = 0,
    high = nativeScale;
  while (true) {
    const mid = low + (high - low) / 2;
    if (mid === low || mid === high) break;
    if (fits(mid)) low = mid;
    else high = mid;
  }
  if (!low) throw new Error("Image exceeds clipboard size limit");
  return low;
}
