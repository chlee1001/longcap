import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getOutputRect,
  getTemplateInsets,
  redactionGridOrigin,
  redactionSamplingBounds,
  sanitizedMetadata,
} from "../src/render.js";
import { emptyEdit, type CaptureRecord } from "../src/shared/contracts.js";

function record(): CaptureRecord {
  return {
    id: "1",
    title: "",
    url: "https://example.com/",
    createdAt: 0,
    width: 200,
    height: 100,
    scale: 1,
    tiles: [],
    revision: 0,
    complete: true,
    warnings: [],
    source: "page",
    edit: emptyEdit(),
    links: [],
    text: [],
  };
}
test("redaction halo is bounded and grows for chained effects", () => {
  const output = { x: 0, y: 0, width: 1000, height: 1000 };
  const region = { x: 100, y: 100, width: 50, height: 50 };
  assert.deepEqual(redactionSamplingBounds(region, output, 1, 1), {
    x: 54,
    y: 54,
    width: 142,
    height: 142,
  });
  assert.deepEqual(redactionSamplingBounds(region, output, 1, 2), {
    x: 8,
    y: 8,
    width: 234,
    height: 234,
  });
  assert.deepEqual(
    redactionSamplingBounds(
      { x: 0, y: 0, width: 10, height: 10 },
      output,
      1,
      1,
    ),
    { x: 0, y: 0, width: 56, height: 56 },
  );
});
test("pixel grid stays anchored to original image across regions and scales", () => {
  for (const scale of [1, 2]) {
    for (const [start, expected] of [
      [89, 89],
      [100, 89],
      [101, 101],
      [148, 137],
      [149, 149],
      [150, 149],
    ] as const) {
      const offset = redactionGridOrigin(start, -7, scale);
      const global = start * scale + offset;
      assert.equal(global, expected * scale);
      assert.equal((global / scale + 7) % 12, 0);
      assert.ok(offset <= 0 && offset > -12 * scale);
    }
  }
});
test("template insets match each output layout", () => {
  const r = record();
  for (const [template, top, bottom] of [
    ["none", 0, 0],
    ["bar", 48, 0],
    ["barBottom", 0, 48],
    ["mac", 48, 0],
    ["windows", 48, 0],
  ] as const) {
    r.edit.template = template;
    assert.deepEqual(getTemplateInsets(r), { top, bottom });
    assert.equal(getOutputRect(r).height, r.height + top + bottom);
  }
});
test("output and metadata share crop and template coordinates", () => {
  const r = record();
  r.edit.crop = { x: 20, y: 10, width: 100, height: 60 };
  r.edit.template = "mac";
  r.links = [
    {
      href: "https://example.org",
      rect: { x: 10, y: 12, width: 20, height: 5 },
    },
    {
      href: "javascript:alert(1)",
      rect: { x: 30, y: 12, width: 10, height: 5 },
    },
  ];
  r.text = [
    { text: "visible", rect: { x: 30, y: 20, width: 10, height: 5 } },
    { text: "clipped", rect: { x: 15, y: 20, width: 10, height: 5 } },
  ];
  assert.deepEqual(getOutputRect(r), { x: 0, y: 0, width: 100, height: 108 });
  const metadata = sanitizedMetadata(r);
  assert.deepEqual(metadata.links[0].rect, {
    x: 0,
    y: 50,
    width: 10,
    height: 5,
  });
  assert.equal(metadata.links.length, 2);
  assert.deepEqual(metadata.text, [
    { text: "visible", rect: { x: 10, y: 58, width: 10, height: 5 } },
  ]);
  r.edit.template = "barBottom";
  assert.equal(sanitizedMetadata(r).links[1].rect.y, 60);
});
test("any overlap with a redaction removes the whole text run and link", () => {
  const r = record();
  r.url = "";
  r.edit.annotations = [
    {
      id: "mask",
      type: "redact",
      rect: { x: 19, y: 10, width: 2, height: 10 },
      color: "#000",
      fill: "#000",
      lineWidth: 1,
    },
  ];
  r.text = [
    { text: "secret", rect: { x: 10, y: 10, width: 10, height: 10 } },
    { text: "safe", rect: { x: 25, y: 10, width: 10, height: 10 } },
  ];
  r.links = [
    {
      href: "https://example.org",
      rect: { x: 10, y: 10, width: 10, height: 10 },
    },
    {
      href: "data:text/plain,unsafe",
      rect: { x: 30, y: 10, width: 10, height: 10 },
    },
  ];
  assert.deepEqual(sanitizedMetadata(r), { links: [], text: [r.text[1]] });
});
