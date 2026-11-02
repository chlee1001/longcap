import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanFileName,
  intersection,
  planTiles,
  safeUrl,
  sanitizeSourceUrl,
  transition,
  validateSettings,
} from "../src/geometry.js";
import { DEFAULT_SETTINGS, type CaptureJob } from "../src/shared/contracts.js";

test("tile grid covers fractional and viewport edges without overlap", () => {
  assert.deepEqual(planTiles(99, 100, 100, 100).tiles, [
    { x: 0, y: 0, width: 99, height: 100, scrollX: 0, scrollY: 0 },
  ]);
  const { tiles, complete } = planTiles(200.5, 100.5, 100, 100);
  assert.equal(complete, true);
  assert.equal(tiles.length, 6);
  assert.deepEqual(tiles[5], {
    x: 200,
    y: 100,
    width: 0.5,
    height: 0.5,
    scrollX: 100.5,
    scrollY: 0.5,
  });
  assert.equal(
    tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0),
    200.5 * 100.5,
  );
  assert.deepEqual(planTiles(300, 100, 100, 100, 2).complete, false);
  for (const n of [0, -1, NaN, Infinity])
    assert.throws(() => planTiles(n, 10, 10, 10));
  for (const n of [0, 1.5, 2001, Infinity])
    assert.throws(() => planTiles(10, 10, 10, 10, n));
});

test("intersections, URLs and filenames reject unsafe cases", () => {
  assert.deepEqual(
    intersection(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 6, width: 10, height: 10 },
    ),
    { x: 5, y: 6, width: 5, height: 4 },
  );
  assert.equal(
    intersection(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 10, y: 0, width: 1, height: 1 },
    ),
    null,
  );
  assert.equal(safeUrl("https://example.com/a"), "https://example.com/a");
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "/relative",
    "https://user:pass@example.com/",
  ])
    assert.equal(safeUrl(url), null);
  assert.equal(cleanFileName("../a\\b:?.png"), ".._a_b__.png");
  assert.equal(cleanFileName("CON.txt"), "capture");
  assert.equal(cleanFileName("..."), "capture");
});

test("source URLs omit query and fragment without changing selected URLs", () => {
  const selected =
    "https://[2001:db8::1]:8443/document.pdf?token=secret#private";
  assert.equal(safeUrl(selected), selected);
  assert.equal(
    sanitizeSourceUrl(selected),
    "https://[2001:db8::1]:8443/document.pdf",
  );
  assert.equal(
    sanitizeSourceUrl("http://example.com/path?x=1#y"),
    "http://example.com/path",
  );
  for (const url of [
    "",
    "/relative",
    "javascript:alert(1)",
    "ftp://example.com/file",
    "https://user@example.com/path?token=secret",
    "https://user:pass@example.com/path#private",
  ])
    assert.equal(sanitizeSourceUrl(url), "");
});

test("settings validation and state transitions enforce boundaries", () => {
  assert.deepEqual(validateSettings({}), DEFAULT_SETTINGS);
  for (const value of [
    null,
    [],
    { format: "gif" },
    { quality: NaN },
    { quality: 1.1 },
    { maxTiles: 0 },
    { imageWaitMs: -1 },
    { maxDurationMs: Infinity },
    { pdfText: 1 },
  ])
    assert.throws(() => validateSettings(value));
  const job: CaptureJob = {
    id: "j",
    requestId: "r",
    tabId: 1,
    windowId: 1,
    documentId: "d",
    mode: "page",
    frameId: 0,
    state: "preparing",
    completed: 0,
    total: 1,
    createdAt: 1,
    updatedAt: 1,
    warnings: [],
  };
  assert.equal(transition(job, "capturing", 2).updatedAt, 2);
  assert.throws(() => transition(job, "completed", 2));
  assert.throws(() =>
    transition({ ...job, state: "completed" }, "capturing", 2),
  );
  assert.throws(() => transition(job, "capturing", 0));
});
