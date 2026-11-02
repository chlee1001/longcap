import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function bundle(file: string, mocks: Record<string, string>) {
  const result = await build({
    entryPoints: [resolve(file)],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "mocks",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            mocks[args.path]
              ? { path: args.path, namespace: "mock" }
              : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
            contents: mocks[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}#${Math.random()}`
  );
}

const geometry = {
  width: 1,
  height: 1,
  viewport: { x: 0, y: 0, width: 1, height: 1 },
  windowWidth: 1,
  windowHeight: 1,
  links: [],
  text: [],
  warnings: [],
  title: "test",
  url: "https://example.com",
  scrollX: 0,
  scrollY: 0,
  scaleX: 1,
  scaleY: 1,
  frameMatrix: [1, 0, 0, 1, 0, 0],
};
const png = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1,
]);

async function harness(realPdf = false) {
  const calls: string[] = [];
  const blobs = new Map<string, Blob>([
    ["shot", new Blob([png])],
    ["pdf", new Blob(["pdf"])],
  ]);
  const records: any[] = [];
  const jobs = new Map<string, any>();
  let listener: any;
  const state: any = {
    calls,
    blobs,
    records,
    jobs,
    settings: {
      imageWaitMs: 0,
      maxTiles: 10,
      maxDurationMs: 100000,
      pdfLinks: false,
      pdfText: false,
    },
    command: async (name: string) => {
      calls.push(name);
      return geometry;
    },
    importPdf: async () => ({ id: "pdf" }),
    failCompleted: false,
  };
  (globalThis as any).__runtimeTest = state;
  (globalThis as any).chrome = {
    runtime: {
      id: "extension",
      getURL: (s: string) =>
        `chrome-extension://extension/${s.replace(/^\//, "")}`,
      onMessage: {
        addListener: (fn: any) => {
          listener = fn;
        },
      },
      sendMessage: async (request: any) => {
        if (request.type === "content")
          return {
            ok: true,
            value: await state.command(request.payload.command),
          };
        if (request.type === "shot") {
          blobs.set("shot", new Blob([png]));
          return { ok: true, value: { blobKey: "shot" } };
        }
        throw new Error("Unexpected broker request");
      },
    },
  };
  (globalThis as any).createImageBitmap = async () => ({
    width: 1,
    height: 1,
    close() {},
  });
  (globalThis as any).DOMMatrix = class {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    scale() {
      return this;
    }
    translate() {
      return this;
    }
    multiply() {
      return this;
    }
    inverse() {
      return this;
    }
  };
  (globalThis as any).DOMPoint = class {
    constructor(
      public x: number,
      public y: number,
    ) {}
    matrixTransform() {
      return this;
    }
  };
  (globalThis as any).OffscreenCanvas = class {
    width = 1;
    height = 1;
    getContext() {
      return { setTransform() {}, drawImage() {} };
    }
    async convertToBlob() {
      return new Blob(["tile"]);
    }
  };
  await bundle("src/offscreen.ts", {
    "./shared/contracts.js": `export const emptyEdit=()=>({}); export const isRuntimeRequest=()=>true; export const callBroker=async(type,payload,jobId)=>{const r=await chrome.runtime.sendMessage({target:"broker",type,payload,jobId}); if(!r?.ok) throw Error(r?.error); return r.value;};`,
    "./storage.js": `const s=globalThis.__runtimeTest; export const getSettings=async()=>s.settings; export const getJob=async id=>s.jobs.get(id); export const saveJob=async job=>{ if(job.state==='completed' && s.failCompleted) throw Error('write failed'); s.jobs.set(job.id,structuredClone(job)); }; export const getBlob=async key=>s.blobs.get(key); export const putBlob=async(key,blob)=>s.blobs.set(key,blob); export const deleteBlobs=async keys=>keys.forEach(key=>s.blobs.delete(key)); export const putCapture=async record=>s.records.push(record);`,
    "./geometry.js": `export const safeUrl=x=>x; export const sanitizeSourceUrl=x=>x; export const planTiles=()=>({complete:true,tiles:[{x:0,y:0,width:1,height:1,scrollX:0,scrollY:0}]});`,
    ...(realPdf
      ? {
          "pdfjs-dist": `export const GlobalWorkerOptions={}; export const Util={}; export class PDFWorker { destroy() { globalThis.__runtimeTest.workerDestroyed = (globalThis.__runtimeTest.workerDestroyed ?? 0) + 1; } } export const getDocument=()=>globalThis.__runtimeTest.pdfTask();`,
        }
      : {
          "./pdf-input.js": `export const importPdf=(...args)=>globalThis.__runtimeTest.importPdf(...args);`,
        }),
  });
  const send = (type: string, payload: any) =>
    new Promise<any>((resolve) =>
      listener(
        { target: "host", type, payload },
        { id: "extension", url: "chrome-extension://extension/background.js" },
        resolve,
      ),
    );
  const job = (id: string) => ({
    id,
    state: "preparing",
    mode: "element",
    token: "selected",
    completed: 0,
    total: 0,
    warnings: [],
  });
  return { state, send, job };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for operation");
}

test("pause serializes restoration after pending prepare and scroll, including immediate resume", async () => {
  for (const blocked of ["prepare", "scroll"]) {
    const { state, send, job } = await harness();
    const wait = deferred<any>();
    let held = false;
    state.command = async (name: string) => {
      state.calls.push(name);
      if (name === blocked && !held) {
        held = true;
        return wait.promise;
      }
      return geometry;
    };
    state.jobs.set("job", job("job"));
    assert.equal((await send("start", { jobId: "job" })).ok, true);
    await until(() => held);
    let paused = false;
    const pause = send("pause", { jobId: "job" }).then((reply) => {
      paused = true;
      return reply;
    });
    const resume = send("resume", { jobId: "job" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(paused, false);
    assert.equal(state.calls.includes("restore"), false);
    wait.resolve({ ...geometry, width: -1 });
    assert.equal((await pause).ok, true);
    assert.equal((await resume).ok, true);
    await until(() => state.jobs.get("job")?.state === "completed");
    assert.deepEqual(
      state.calls.filter(
        (name: string) => name === "prepare" || name === "restore",
      ),
      ["prepare", "restore", "prepare", "restore"],
    );
  }
});

test("capture metadata failure after commit retains tile blobs", async () => {
  const { state, send, job } = await harness();
  state.failCompleted = true;
  state.jobs.set("job", job("job"));
  assert.equal((await send("start", { jobId: "job" })).ok, true);
  await until(() => state.jobs.get("job")?.state === "failed");
  assert.equal(state.records.length, 1);
  assert.ok(state.blobs.has(state.records[0].tiles[0].blobKey));
});

test("cancel during pending scroll discards its invalid response and restores", async () => {
  const { state, send, job } = await harness();
  const wait = deferred<any>();
  let held = false;
  state.command = async (name: string) => {
    state.calls.push(name);
    if (name === "scroll") {
      held = true;
      return wait.promise;
    }
    return geometry;
  };
  state.jobs.set("job", job("job"));
  assert.equal((await send("start", { jobId: "job" })).ok, true);
  await until(() => held);
  assert.equal((await send("cancel", { jobId: "job" })).ok, true);
  wait.resolve({ ...geometry, width: -1 });
  await until(() => state.calls.includes("restore"));
  assert.equal(state.records.length, 0);
  assert.equal(state.jobs.get("job").state, "cancelled");
});

test("PDF slot is acquired before awaiting and released on success and failure", async () => {
  const { state, send, job } = await harness();
  const wait = deferred<any>();
  let imports = 0;
  state.importPdf = () => {
    imports++;
    return wait.promise;
  };
  state.jobs.set("job", job("job"));
  const first = send("import-pdf", { blobKey: "pdf", title: "x", url: "" });
  assert.equal(
    (await send("import-pdf", { blobKey: "pdf", title: "x", url: "" })).ok,
    false,
  );
  assert.equal((await send("start", { jobId: "job" })).ok, false);
  await until(() => imports === 1);
  wait.resolve({ id: "pdf" });
  assert.equal((await first).ok, true);
  state.importPdf = async () => {
    throw new Error("bad pdf");
  };
  assert.equal(
    (await send("import-pdf", { blobKey: "pdf", title: "x", url: "" })).ok,
    false,
  );
  state.importPdf = async () => ({ id: "retry" });
  assert.equal(
    (await send("import-pdf", { blobKey: "pdf", title: "x", url: "" })).ok,
    true,
  );
  const blocked = deferred<any>();
  state.command = async () => blocked.promise;
  assert.equal((await send("start", { jobId: "job" })).ok, true);
  assert.equal(
    (await send("import-pdf", { blobKey: "pdf", title: "x", url: "" })).ok,
    false,
  );
  const cancel = send("cancel", { jobId: "job" });
  blocked.resolve(geometry);
  await cancel;
  await until(() => state.jobs.get("job")?.state === "cancelled");
});

test("PDF rendering uses print intent without animation frames", async () => {
  const { state, send } = await harness(true);
  let rafCalls = 0,
    destroyed = 0;
  (globalThis as any).window = {
    requestAnimationFrame: () => {
      rafCalls++;
    },
  };
  (globalThis as any).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({}),
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["png"])),
    }),
  };
  state.pdfTask = () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: () => ({
          width: 1,
          height: 1,
          transform: [1, 0, 0, 1, 0, 0],
        }),
        render: (options: any) => ({
          promise:
            options.intent === "print"
              ? Promise.resolve()
              : new Promise(() => window.requestAnimationFrame(() => {})),
          cancel() {},
        }),
        cleanup() {},
      }),
    }),
    destroy: async () => {
      destroyed++;
    },
  });
  state.settings.maxDurationMs = 100;
  const reply = await send("import-pdf", {
    blobKey: "pdf",
    title: "x",
    url: "",
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.value.tiles.length, 1);
  assert.equal(destroyed, 1);
  assert.equal(state.workerDestroyed, 1);
  assert.equal(rafCalls, 0);
});

test("PDF loading and rendering timeouts destroy the task, cancel rendering, and release the slot", async () => {
  for (const phase of ["loading", "rendering"]) {
    const { state, send } = await harness(true);
    let destroyed = 0,
      cancelled = 0,
      started = false;
    (globalThis as any).document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
    };
    state.settings.maxDurationMs = 20;
    state.pdfTask = () => {
      started = true;
      const page = {
        getViewport: () => ({ width: 1, height: 1 }),
        render: () => ({
          promise: new Promise(() => {}),
          cancel: () => {
            cancelled++;
          },
        }),
      };
      return {
        promise:
          phase === "loading"
            ? new Promise(() => {})
            : Promise.resolve({ numPages: 1, getPage: async () => page }),
        destroy: () => {
          destroyed++;
          return new Promise(() => {});
        },
      };
    };
    const first = send("import-pdf", { blobKey: "pdf", title: "x", url: "" });
    await until(() => started);
    assert.equal(
      (await send("import-pdf", { blobKey: "pdf", title: "x", url: "" })).ok,
      false,
    );
    const reply = await first;
    assert.equal(reply.ok, false);
    assert.match(reply.error, /maximum duration/);
    assert.equal(destroyed, 1);
    assert.equal(state.workerDestroyed, 1);
    assert.equal(cancelled, phase === "rendering" ? 1 : 0);
    state.pdfTask = () => ({
      promise: Promise.reject(new Error("retry reached PDF parser")),
      destroy: async () => {},
    });
    const retry = await send("import-pdf", {
      blobKey: "pdf",
      title: "x",
      url: "",
    });
    assert.match(retry.error, /retry reached PDF parser/);
    assert.equal(state.records.length, 0);
  }
});

test("oversized or empty PDF blobs are rejected before reading or creating a document", async () => {
  let reads = 0,
    documents = 0;
  (globalThis as any).__pdfTest = {
    document: () => {
      documents++;
    },
  };
  (globalThis as any).chrome = { runtime: { getURL: (s: string) => s } };
  const module = await bundle("src/pdf-input.ts", {
    "pdfjs-dist": `export const GlobalWorkerOptions={}; export const Util={}; export class PDFWorker {} export const getDocument=()=>globalThis.__pdfTest.document();`,
    "./shared/contracts.js": `export const emptyEdit=()=>({});`,
    "./storage.js": `export const deleteBlobs=()=>{}; export const putBlob=()=>{}; export const putCapture=()=>{};`,
    "./geometry.js": `export const safeUrl=x=>x; export const sanitizeSourceUrl=x=>x;`,
  });
  for (const size of [0, 128 * 1024 * 1024 + 1, Infinity]) {
    await assert.rejects(
      module.importPdf(
        {
          size,
          arrayBuffer: () => {
            reads++;
            throw Error("read");
          },
        },
        "",
        "",
        {},
      ),
      /size limit|empty/,
    );
  }
  assert.equal(reads, 0);
  assert.equal(documents, 0);
});
