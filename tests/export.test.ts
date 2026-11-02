import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import {
  exportCapture,
  exportRecord,
  ownedTextBounds,
  pagePlan,
  pngWithMetadata,
  provenancePayload,
  rasterSide,
  rgbHasher,
} from "../src/export.js";
import { redactionSamplingBounds } from "../src/render.js";
import {
  DEFAULT_SETTINGS,
  emptyEdit,
  type CaptureRecord,
} from "../src/shared/contracts.js";

test("PDF page plans respect page dimensions, margins, orientation and limits", () => {
  const pages = pagePlan(800, 4000, DEFAULT_SETTINGS);
  assert.ok(pages.length > 1);
  assert.equal(pages[0].margin, 20);
  assert.equal(pages.at(-1)!.region.y + pages.at(-1)!.region.height, 4000);
  const landscape = pagePlan(800, 100, {
    ...DEFAULT_SETTINGS,
    landscape: true,
  })[0];
  assert.ok(landscape.width > landscape.height);
  const long = pagePlan(50000, 50000, { ...DEFAULT_SETTINGS, pdfPaper: "one" });
  assert.ok(long.every((p) => p.width <= 14400 && p.height <= 14400));
  assert.throws(() => pagePlan(0, 1, DEFAULT_SETTINGS));
  assert.throws(() => pagePlan(1, 1, { ...DEFAULT_SETTINGS, quality: NaN }));
});

test("PNG metadata validates CRC and emits Unicode iTXt", () => {
  const makeChunk = (name: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(name, 4);
    data.copy(result, 8);
    let crc = 0xffffffff;
    for (const value of result.subarray(4, -4)) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk("IHDR", header),
    makeChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
  const encoded = pngWithMetadata(png, { title: "한국어" });
  assert.ok(Buffer.from(encoded).includes(Buffer.from("한국어")));
  assert.doesNotThrow(() => pngWithMetadata(encoded, {}));
  assert.throws(() => pngWithMetadata(new Uint8Array([1, 2]), {}));
  const bad = png.slice();
  bad[12] ^= 1;
  assert.throws(() => pngWithMetadata(bad, { title: "한국어" }));
});

test("provenance redacts URL unless explicitly enabled", () => {
  const record: CaptureRecord = {
    id: "x",
    title: "title",
    url: "https://user:pass@example.com/path?q=private#x",
    createdAt: 0,
    width: 1,
    height: 1,
    scale: 2,
    tiles: [],
    links: [],
    text: [],
    edit: emptyEdit(),
    revision: 3,
    complete: true,
    warnings: [],
    source: "page",
  };
  const rect = { x: 0, y: 0, width: 1, height: 1 };
  assert.equal(
    provenancePayload(record, DEFAULT_SETTINGS, "abc", rect).url,
    undefined,
  );
  assert.equal(
    provenancePayload(
      record,
      { ...DEFAULT_SETTINGS, includeUrl: true },
      "abc",
      rect,
    ).url,
    "https://example.com/path",
  );
  assert.equal(exportRecord(record, DEFAULT_SETTINGS).url, "");
  assert.equal(
    exportRecord(record, { ...DEFAULT_SETTINGS, includeUrl: true }).url,
    "https://example.com/path",
  );
  assert.equal(
    exportRecord(
      { ...record, url: "javascript:alert(1)" },
      { ...DEFAULT_SETTINGS, includeUrl: true },
    ).url,
    "",
  );
  assert.equal(record.url, "https://user:pass@example.com/path?q=private#x");
});

test("PDF export stitches outward-rounded raster tiles and hashes their actual pixels", async () => {
  const previousDocument = globalThis.document;
  const tiles: { width: number; height: number; rgb: Buffer }[] = [];
  const chunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(type, 4);
    data.copy(result, 8);
    let crc = 0xffffffff;
    for (const value of result.subarray(4, -4)) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  class Canvas {
    width = 0;
    height = 0;
    color() {
      return Buffer.from([
        this.width % 251,
        this.height % 251,
        (this.width + this.height) % 251,
      ]);
    }
    getContext() {
      return {
        scale() {},
        translate() {},
        fillRect() {},
        drawImage() {},
        save() {},
        beginPath() {},
        rect() {},
        clip() {},
        restore() {},
        getImageData: () => {
          const data = new Uint8ClampedArray(this.width * this.height * 4),
            color = this.color();
          for (let i = 0; i < data.length; i += 4) {
            data[i] = color[0];
            data[i + 1] = color[1];
            data[i + 2] = color[2];
            data[i + 3] = 255;
          }
          return { data };
        },
      };
    }
    toBlob(callback: (blob: Blob) => void) {
      const color = this.color(),
        header = Buffer.alloc(13);
      header.writeUInt32BE(this.width);
      header.writeUInt32BE(this.height, 4);
      header[8] = 8;
      header[9] = 2;
      const row = Buffer.alloc(1 + this.width * 3);
      for (let x = 0; x < this.width; x++) color.copy(row, 1 + x * 3);
      const raw = Buffer.alloc(row.length * this.height);
      for (let y = 0; y < this.height; y++) row.copy(raw, y * row.length);
      tiles.push({ width: this.width, height: this.height, rgb: color });
      callback(
        new Blob(
          [
            Buffer.concat([
              Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
              chunk("IHDR", header),
              chunk("IDAT", deflateSync(raw)),
              chunk("IEND", Buffer.alloc(0)),
            ]),
          ],
          { type: "image/png" },
        ),
      );
    }
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: { createElement: () => new Canvas() },
  });
  try {
    for (const example of [
      { width: 1000, height: 2000, scale: 1, crop: null },
      {
        width: 2400,
        height: 5000,
        scale: 1.3,
        crop: { x: 20.2, y: 10.1, width: 2250.3, height: 4300.7 },
      },
    ]) {
      tiles.length = 0;
      const record: CaptureRecord = {
        id: "x",
        title: "title",
        url: "",
        createdAt: 0,
        ...example,
        tiles: [],
        links: [],
        text: [],
        edit: { ...emptyEdit(), crop: example.crop },
        revision: 0,
        complete: true,
        warnings: [],
        source: "page",
      };
      const settings = {
        ...DEFAULT_SETTINGS,
        format: "pdf" as const,
        pdfPaper: "a4" as const,
        smartSplit: false,
        pdfText: false,
        provenance: true,
      };
      const [file] = await exportCapture(record, settings);
      const pdf = await PDFDocument.load(await file.blob.arrayBuffer());
      assert.ok(pdf.getPageCount() > 1);
      let index = 0;
      for (const page of pdf.getPages()) {
        const metadata = page.node.get(PDFName.of("LocalCaptureProvenance"));
        assert.ok(metadata instanceof PDFHexString);
        const payload = JSON.parse(metadata.decodeText()) as {
          pixelWidth: number;
          pixelHeight: number;
          sha256Rgb: string;
          region: { width: number; height: number };
        };
        assert.equal(
          payload.pixelWidth,
          Math.ceil(payload.region.width * example.scale),
        );
        assert.equal(
          payload.pixelHeight,
          Math.ceil(payload.region.height * example.scale),
        );
        const hash = createHash("sha256"),
          rows = Math.max(
            1,
            Math.min(2048, Math.floor(2_000_000 / payload.pixelWidth)),
          );
        for (let y = 0; y < payload.pixelHeight; y += rows) {
          const height = Math.min(rows, payload.pixelHeight - y),
            band = [] as typeof tiles;
          for (let x = 0; x < payload.pixelWidth; x += 2048) {
            const tile = tiles[index++];
            assert.equal(tile.width, Math.min(2048, payload.pixelWidth - x));
            assert.equal(tile.height, height);
            band.push(tile);
          }
          for (let row = 0; row < height; row++)
            for (const tile of band) {
              const pixels = Buffer.alloc(tile.width * 3);
              for (let x = 0; x < tile.width; x++) tile.rgb.copy(pixels, x * 3);
              hash.update(pixels);
            }
        }
        assert.equal(payload.sha256Rgb, hash.digest("hex"));
      }
      assert.equal(index, tiles.length);
      assert.ok(tiles.some((tile) => tile.width < 2048 || tile.height < 2048));
    }
    const previousFetch = globalThis.fetch;
    const previousChrome = Object.getOwnPropertyDescriptor(
      globalThis,
      "chrome",
    );
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { runtime: { getURL: (url: string) => url } },
    });
    globalThis.fetch = async (input) =>
      new Response(new Uint8Array(await readFile(String(input))));
    try {
      const original = "가나다\nLine\t2 😀";
      const record: CaptureRecord = {
        id: "text",
        title: "text",
        url: "",
        createdAt: 0,
        width: 200,
        height: 100,
        scale: 1,
        tiles: [],
        links: [],
        text: [
          { rect: { x: 1, y: 1, width: 180, height: 20 }, text: original },
          {
            rect: { x: 1, y: 30, width: 180, height: 20 },
            text: "A\rB\fC\vD\u2028E\u2029F",
          },
        ],
        edit: emptyEdit(),
        revision: 0,
        complete: true,
        warnings: [],
        source: "page",
      };
      const settings = {
        ...DEFAULT_SETTINGS,
        format: "pdf" as const,
        smartSplit: false,
        pdfText: true,
        provenance: false,
      };
      const [file] = await exportCapture(record, settings);
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const loading = pdfjs.getDocument({
        data: new Uint8Array(await file.blob.arrayBuffer()),
        disableFontFace: true,
      });
      try {
        const pdf = await loading.promise;
        const content = await (await pdf.getPage(1)).getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join("")
          .replace(/\s+/g, " ");
        assert.ok(text.includes("가나다 Line 2 😀"), text);
        assert.ok(text.includes("A B C D E F"), text);
      } finally {
        await loading.destroy();
      }
      assert.equal(record.text[0].text, original);
      assert.equal(record.text[1].text, "A\rB\fC\vD\u2028E\u2029F");
      const unsupported = {
        ...record,
        text: [{ ...record.text[0], text: "\u{10ffff}" }],
      };
      await assert.rejects(
        exportCapture(unsupported, settings),
        /Local PDF fonts do not support text/,
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousChrome)
        Object.defineProperty(globalThis, "chrome", previousChrome);
      else Reflect.deleteProperty(globalThis, "chrome");
    }
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: previousDocument,
    });
  }
});

test("streaming pixel hash matches SHA-256 and preserves row and strip order", async () => {
  const pixels = Uint8Array.of(
    97,
    98,
    99,
    255,
    100,
    101,
    102,
    20,
    103,
    104,
    105,
    0,
    106,
    107,
    108,
    255,
  );
  const hash = rgbHasher();
  hash.update(pixels.subarray(0, 8));
  hash.update(pixels.subarray(8));
  const expected = Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("abcdefghijkl"),
    ),
  ).toString("hex");
  assert.equal(hash.digest(), expected);
  const known = rgbHasher();
  known.update(Uint8Array.of(97, 98, 99, 255));
  assert.equal(
    known.digest(),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const reversed = rgbHasher();
  reversed.update(pixels.subarray(8));
  reversed.update(pixels.subarray(0, 8));
  assert.notEqual(reversed.digest(), expected);
  assert.throws(() => rgbHasher().update(Uint8Array.of(1, 2, 3)));
});

test("redaction halo is included in the raster pixel budget", () => {
  const output = { x: 0, y: 0, width: 10000, height: 10000 };
  for (const scale of [0.5, 1, 2])
    for (const count of [0, 1, 8]) {
      const side = rasterSide(scale, count);
      const expanded = redactionSamplingBounds(
        { x: 1000, y: 1000, width: side / scale, height: side / scale },
        output,
        scale,
        count,
      );
      assert.ok(
        Math.round(expanded.width * scale) *
          Math.round(expanded.height * scale) <=
          16_000_000,
      );
      assert.ok(side <= 4096);
    }
  assert.throws(() => rasterSide(1, 100));
});

test("cross-page text has exactly one owner and stays within that page", () => {
  const first = { x: 0, y: 0, width: 100, height: 100 };
  const second = { x: 0, y: 100, width: 100, height: 100 };
  const crossing = { x: 10, y: 90, width: 50, height: 30 };
  assert.equal(ownedTextBounds(crossing, first), null);
  assert.deepEqual(ownedTextBounds(crossing, second), {
    x: 10,
    y: 100,
    width: 50,
    height: 20,
  });
  const edge = { x: 10, y: 90, width: 50, height: 20 };
  assert.equal(ownedTextBounds(edge, first), null);
  assert.deepEqual(ownedTextBounds(edge, second), {
    x: 10,
    y: 100,
    width: 50,
    height: 10,
  });
});
