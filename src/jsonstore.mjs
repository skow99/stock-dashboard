// src/jsonstore.mjs - atomowy zapis plikow JSON (cache rynkowy zostaje poza SQLite).
import fs from 'node:fs';
import path from 'node:path';

export function readJsonFile(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return structuredClone(fallback);
    return JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

/** Zapis tmp + rename: proces nie zostawi uszkodzonego pliku po ubiciu w trakcie zapisu. */
export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 0)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Cache w pamieci z zapisem na dysk, debounce'owanym zeby nie bic w I/O przy kazdym quote. */
export function createDiskCache(filePath, { flushMs = 2000 } = {}) {
  let data = readJsonFile(filePath, {});
  let timer = null;
  let dirty = false;

  const flush = () => {
    if (!dirty) return;
    writeJsonFile(filePath, data);
    dirty = false;
  };

  return {
    get: (key) => data[key],
    set(key, value) {
      data[key] = value;
      dirty = true;
      if (!timer) {
        timer = setTimeout(() => { timer = null; flush(); }, flushMs);
        timer.unref?.();
      }
    },
    keys: () => Object.keys(data),
    all: () => data,
    flushNow: flush,
    prune(predicate) {
      for (const key of Object.keys(data)) {
        if (predicate(data[key], key)) { delete data[key]; dirty = true; }
      }
    },
  };
}
