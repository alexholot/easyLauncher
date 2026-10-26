'use strict';
// Загрузка файлов: повторы, проверка хешей, атомарная запись, параллельная очередь.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

let fetchImpl = (...a) => globalThis.fetch(...a);
const UA = 'easyLauncher/1.0 (+https://github.com/easylauncher)';

/** Electron передаёт сюда net.fetch, чтобы учитывались системные прокси. */
function setFetch(fn) {
  fetchImpl = fn;
}

const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/**
 * Windows не даёт заменить файл, пока его держит другой процесс: антивирус проверяет только что
 * скачанный файл, или его использует запущенная игра. Обычно это длится доли секунды — повторяем.
 */
async function retryFs(fn, what = '') {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!LOCKED.has(e.code)) throw e;
      if (i >= 12) {
        const err = new Error(
          `Файл занят другой программой${what ? ' (' + what + ')' : ''}. Закрой Minecraft, если он открыт, ` +
            'и подожди проверку антивируса, затем нажми «Повторить».',
        );
        err.code = e.code;
        throw err;
      }
      await new Promise((r) => setTimeout(r, Math.min(2000, 150 * (i + 1))));
    }
  }
}

function cancelled(signal) {
  if (signal?.aborted) {
    const e = new Error('Подготовка отменена');
    e.code = 'CANCELLED';
    throw e;
  }
}

async function request(url, { signal, retries = 3, headers = {} } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    cancelled(signal);
    try {
      const r = await fetchImpl(url, { signal, headers: { 'User-Agent': UA, ...headers } });
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status} — ${url}`);
        // 4xx кроме 429 повторять бессмысленно
        if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          e.fatal = true;
        }
        throw e;
      }
      return r;
    } catch (e) {
      if (signal?.aborted) cancelled(signal);
      last = e;
      if (e.fatal) break;
      await new Promise((res) => setTimeout(res, 600 * 2 ** i));
    }
  }
  throw new Error(`Не удалось скачать ${url}: ${last?.message || last}`);
}

async function json(url, opts) {
  const r = await request(url, opts);
  return r.json();
}

async function hashFile(file, algo) {
  const h = crypto.createHash(algo);
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/**
 * Проверка уже скачанного файла. Если хеша нет, сверяем только размер.
 * quick=true — при совпадающем размере не пересчитываем хеш (для тысяч ассетов).
 */
async function isValid(file, { sha1, sha512, size, quick = false } = {}) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (size != null && st.size !== size) return false;
  if (quick && size != null) return true;
  if (sha512) return (await hashFile(file, 'sha512')) === sha512.toLowerCase();
  if (sha1) return (await hashFile(file, 'sha1')) === sha1.toLowerCase();
  return st.size > 0;
}

/**
 * Скачать url → dest с проверкой хеша и размера, атомарной записью и докачкой.
 * Незавершённая загрузка остаётся в dest.part; при повторе запрашивается Range,
 * если сервер его поддерживает (ответ 206). onBytes(n) вызывается на каждый полученный кусок.
 * Возвращает число байт, полученных по сети.
 */
async function download(url, dest, { sha1, sha512, size, signal, quick, onBytes } = {}) {
  if (await isValid(dest, { sha1, sha512, size, quick })) return 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const algo = sha512 ? 'sha512' : sha1 ? 'sha1' : null;
  const want = (sha512 || sha1 || '').toLowerCase();
  let received = 0;
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    cancelled(signal);
    let have = 0;
    try {
      have = (await fsp.stat(part)).size;
    } catch {}
    if (size != null && have > size) {
      await fsp.rm(part, { force: true });
      have = 0;
    }
    try {
      const r = await request(url, { signal, headers: have ? { Range: `bytes=${have}-` } : {} });
      const append = have > 0 && r.status === 206;
      if (!append) have = 0;
      // Хеш считаем по всему файлу: при докачке сначала по уже полученной части
      const hasher = algo && crypto.createHash(algo);
      if (append && hasher) for await (const chunk of fs.createReadStream(part)) hasher.update(chunk);
      let bytes = have;
      const body = Readable.fromWeb(r.body);
      body.on('data', (c) => {
        bytes += c.length;
        received += c.length;
        hasher?.update(c);
        onBytes?.(c.length);
      });
      await pipeline(body, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
      if (size != null && bytes !== size) throw Object.assign(new Error(`размер не совпадает (${path.basename(dest)})`), { corrupt: bytes > size });
      if (hasher && hasher.digest('hex') !== want)
        throw Object.assign(new Error(`файл повреждён: хеш не совпадает (${path.basename(dest)})`), { corrupt: true });
      await retryFs(() => fsp.rename(part, dest), path.basename(dest));
      return received;
    } catch (e) {
      if (e.code === 'CANCELLED' || signal?.aborted) cancelled(signal);
      if (LOCKED.has(e.code)) throw e;
      // Повреждённую часть удаляем; оборванную оставляем для докачки
      if (e.corrupt || e.fatal) await retryFs(() => fsp.rm(part, { force: true })).catch(() => {});
      last = e;
      if (e.fatal) break;
    }
  }
  throw Object.assign(new Error(`Файл ${path.basename(dest)} не скачан: ${last.message}`), { cause: last });
}

/**
 * Параллельная загрузка {url, dest, sha1?, sha512?, size?}.
 * onProgress(done, total, unit): если размеры всех файлов известны — в байтах (unit='bytes'),
 * иначе — в файлах (unit='files'). Прогресс отражает реально полученные данные.
 */
async function downloadAll(tasks, { concurrency = 12, signal, onProgress, quick } = {}) {
  const unique = [...new Map(tasks.map((t) => [t.dest, t])).values()];
  const bySize = unique.every((t) => Number.isFinite(t.size));
  const total = bySize ? unique.reduce((a, t) => a + t.size, 0) : unique.length;
  let done = 0;
  const queue = [...unique];
  onProgress?.(0, total, bySize ? 'bytes' : 'files');
  async function worker() {
    while (queue.length) {
      cancelled(signal);
      const t = queue.shift();
      let got = 0;
      await download(t.url, t.dest, {
        ...t,
        signal,
        quick: t.quick ?? quick,
        onBytes: bySize
          ? (n) => {
              got += n;
              done += n;
              onProgress?.(done, total, 'bytes');
            }
          : null,
      });
      if (bySize) {
        // Файл уже был на диске (или докачан частично) — засчитываем оставшийся объём
        done += t.size - got;
      } else done++;
      onProgress?.(Math.min(done, total), total, bySize ? 'bytes' : 'files');
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length || 1) }, worker));
}

/** Прочитать JSON с диска; если нет — скачать и сохранить. При ошибке сети вернуть кеш. */
async function cachedJson(url, file, { sha1, signal, refresh = false } = {}) {
  if (!refresh) {
    try {
      if (!sha1 || (await isValid(file, { sha1 }))) return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {}
  }
  try {
    if (sha1) {
      await download(url, file, { sha1, signal });
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    }
    const data = await json(url, { signal });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await retryFs(() => fsp.writeFile(file, JSON.stringify(data)), path.basename(file));
    return data;
  } catch (e) {
    if (e.code === 'CANCELLED') throw e;
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      throw e;
    }
  }
}

/**
 * Запрос к API с JSON-ответом (без повторов): method, headers, body.
 * Ошибка содержит status и разобранное тело ответа.
 */
async function api(url, { method = 'GET', headers = {}, body, form, json: payload, signal } = {}) {
  const h = { 'User-Agent': UA, Accept: 'application/json', ...headers };
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (payload !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const r = await fetchImpl(url, { method, headers: h, body, signal });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status} — ${new URL(url).host}`);
    e.status = r.status;
    e.data = data;
    throw e;
  }
  return data;
}

module.exports = { retryFs, setFetch, api, request, json, download, downloadAll, cachedJson, isValid, hashFile, cancelled };
