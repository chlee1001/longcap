import {
  DEFAULT_SETTINGS,
  type CaptureJob,
  type CaptureRecord,
  type Settings,
} from "./shared/contracts.js";
import { validateSettings } from "./geometry.js";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("local-capture", 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("captures", { keyPath: "id" }).createIndex(
        "createdAt",
        "createdAt",
      );
      db.createObjectStore("blobs");
      db.createObjectStore("jobs", { keyPath: "id" });
      db.createObjectStore("settings");
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Database open failed"));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Database open blocked"));
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: (
    tx: IDBTransaction,
    set: (value: T) => void,
    fail: (error: Error) => void,
  ) => void,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let value: T;
    let failure: Error | undefined;
    let tx: IDBTransaction | undefined;
    try {
      tx = db.transaction(stores, mode);
      const transaction = tx;
      transaction.oncomplete = () => {
        db.close();
        resolve(value);
      };
      transaction.onabort = () => {
        db.close();
        reject(
          failure ?? transaction.error ?? new Error("Transaction aborted"),
        );
      };
      transaction.onerror = () => {
        failure ??= transaction.error ?? undefined;
      };
      run(
        transaction,
        (result) => {
          value = result;
        },
        (error) => {
          failure = error;
          transaction.abort();
        },
      );
    } catch (error) {
      if (tx) tx.abort();
      db.close();
      reject(error);
    }
  });
}

export function putCapture(record: CaptureRecord): Promise<void> {
  return transact(["captures"], "readwrite", (tx) => {
    tx.objectStore("captures").put(record);
  });
}

export function getCapture(id: string): Promise<CaptureRecord | undefined> {
  return transact(["captures"], "readonly", (tx, set) => {
    const request = tx.objectStore("captures").get(id);
    request.onsuccess = () => set(request.result as CaptureRecord | undefined);
  });
}

export function listCaptures(
  options: { query?: string; limit?: number; offset?: number } = {},
): Promise<CaptureRecord[]> {
  const { query = "", limit = 50, offset = 0 } = options;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    return Promise.reject(new RangeError("Invalid pagination"));
  const needle = query.toLocaleLowerCase();
  return transact(["captures"], "readonly", (tx, set) => {
    const records: CaptureRecord[] = [];
    let skipped = 0;
    set(records);
    if (limit === 0) return;
    const request = tx
      .objectStore("captures")
      .index("createdAt")
      .openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as CaptureRecord;
      if (
        !needle ||
        [record.title, record.url, ...record.text.map((run) => run.text)].some(
          (text) => text.toLocaleLowerCase().includes(needle),
        )
      ) {
        if (skipped < offset) skipped++;
        else records.push(record);
      }
      if (records.length < limit) cursor.continue();
    };
  });
}

export function updateCapture(
  id: string,
  expectedRevision: number,
  patch: Partial<Pick<CaptureRecord, "title" | "edit">>,
): Promise<CaptureRecord> {
  return transact(["captures"], "readwrite", (tx, set, fail) => {
    const store = tx.objectStore("captures");
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as CaptureRecord | undefined;
      if (!record) return fail(new Error("Capture not found"));
      if (record.revision !== expectedRevision)
        return fail(new Error("Capture revision conflict"));
      const updated = {
        ...record,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.edit !== undefined ? { edit: patch.edit } : {}),
        revision: record.revision + 1,
      };
      store.put(updated);
      set(updated);
    };
  });
}

export function deleteCaptures(ids: string[]): Promise<void> {
  const targets = new Set(ids);
  return transact(["captures", "blobs"], "readwrite", (tx) => {
    const captures = tx.objectStore("captures");
    const blobs = tx.objectStore("blobs");
    const removed = new Set<string>();
    const retained = new Set<string>();
    const request = captures.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        for (const key of removed) if (!retained.has(key)) blobs.delete(key);
        return;
      }
      const record = cursor.value as CaptureRecord;
      const keys = targets.has(record.id) ? removed : retained;
      for (const tile of record.tiles) keys.add(tile.blobKey);
      if (targets.has(record.id)) cursor.delete();
      cursor.continue();
    };
  });
}

export function putBlob(key: string, blob: Blob): Promise<void> {
  return transact(["blobs"], "readwrite", (tx) => {
    tx.objectStore("blobs").put(blob, key);
  });
}
export function getBlob(key: string): Promise<Blob | undefined> {
  return transact(["blobs"], "readonly", (tx, set) => {
    const request = tx.objectStore("blobs").get(key);
    request.onsuccess = () => set(request.result as Blob | undefined);
  });
}
export function deleteBlobs(keys: string[]): Promise<void> {
  return transact(["blobs"], "readwrite", (tx) => {
    for (const key of keys) tx.objectStore("blobs").delete(key);
  });
}
export function saveJob(job: CaptureJob): Promise<void> {
  return transact(["jobs"], "readwrite", (tx) => {
    tx.objectStore("jobs").put(job);
  });
}
export function getJob(id: string): Promise<CaptureJob | undefined> {
  return transact(["jobs"], "readonly", (tx, set) => {
    const request = tx.objectStore("jobs").get(id);
    request.onsuccess = () => set(request.result as CaptureJob | undefined);
  });
}
export function listJobs(): Promise<CaptureJob[]> {
  return transact(["jobs"], "readonly", (tx, set) => {
    const request = tx.objectStore("jobs").getAll();
    request.onsuccess = () => set(request.result as CaptureJob[]);
  });
}
export function getSettings(): Promise<Settings> {
  return transact(["settings"], "readonly", (tx, set, fail) => {
    const request = tx.objectStore("settings").get("settings");
    request.onsuccess = () => {
      try {
        set(validateSettings(request.result ?? DEFAULT_SETTINGS));
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Invalid settings"));
      }
    };
  });
}
export async function saveSettings(settings: Settings): Promise<void> {
  const validated = validateSettings(settings);
  return transact(["settings"], "readwrite", (tx) => {
    tx.objectStore("settings").put(validated, "settings");
  });
}
