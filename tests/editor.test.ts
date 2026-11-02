import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EditorHistory,
  hitTest,
  moveAnnotation,
  nextBadge,
  normalizedRect,
  resizeAnnotation,
} from "../src/editor-model.js";
import { emptyEdit, type Annotation } from "../src/shared/contracts.js";

const shape: Annotation = {
  id: "a",
  type: "pen",
  rect: { x: 2, y: 4, width: 10, height: 20 },
  color: "#000",
  fill: "transparent",
  lineWidth: 2,
  fontSize: 10,
  points: [
    { x: 2, y: 4 },
    { x: 12, y: 24 },
  ],
};

test("normalization, movement, resizing and topmost hit", () => {
  assert.deepEqual(normalizedRect({ x: 8, y: 9 }, { x: 3, y: 2 }), {
    x: 3,
    y: 2,
    width: 5,
    height: 7,
  });
  const moved = moveAnnotation(shape, 3, -2);
  assert.deepEqual(moved.points?.[0], { x: 5, y: 2 });
  assert.deepEqual(shape.points?.[0], { x: 2, y: 4 });
  const resized = resizeAnnotation(shape, {
    x: 1,
    y: 2,
    width: 20,
    height: 10,
  });
  assert.deepEqual(resized.points?.[1], { x: 21, y: 12 });
  assert.equal(resized.fontSize, 5);
  assert.equal(
    hitTest([shape, { ...shape, id: "top" }], { x: 5, y: 5 })?.id,
    "top",
  );
  assert.equal(hitTest([shape], { x: 100, y: 100 }), undefined);
});

test("history snapshots are isolated, bounded and clear redo branches", () => {
  const initial = emptyEdit();
  initial.annotations.push(shape);
  const history = new EditorHistory(initial);
  initial.annotations[0].rect.x = 500;
  assert.equal(history.value.annotations[0].rect.x, 2);
  const next = history.value;
  next.annotations[0].rect.x = 8;
  history.commit(next);
  next.annotations[0].rect.x = 40;
  const exposed = history.value;
  exposed.annotations[0].rect.x = 90;
  assert.equal(history.value.annotations[0].rect.x, 8);
  assert.equal(history.undo().annotations[0].rect.x, 2);
  assert.equal(history.redo().annotations[0].rect.x, 8);
  history.undo();
  history.commit(emptyEdit());
  assert.equal(history.canRedo, false);
  for (let i = 0; i < 110; i++)
    history.commit({
      ...emptyEdit(),
      crop: { x: i, y: 0, width: 1, height: 1 },
    });
  let count = 0;
  while (history.canUndo) {
    history.undo();
    count++;
  }
  assert.equal(count, 99);
});

test("badges reuse the lowest available positive integer", () => {
  const badge = (number: number): Annotation => ({
    ...shape,
    type: "badge",
    number,
  });
  assert.equal(nextBadge([badge(1), badge(3), shape]), 2);
  assert.equal(nextBadge([]), 1);
});
