'use strict';
// Локальная модель: llama.cpp (llama-server) + GGUF. Не входит в базовый установщик —
// скачивается при первоначальной настройке помощника, с показом размера и проверкой SHA-256.
// Загружается только при обращении к помощнику и выгружается перед запуском Minecraft/сервера.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const AdmZip = require('adm-zip');
const http = require('../http');
const { portFree } = require('../server');

// Все выпуски llama.cpp публикуются как prerelease, поэтому /releases/latest отдаёт устаревший выпуск
// со старыми именами файлов. Берём список последних выпусков и первый, где есть нужная сборка.
const GITHUB_RELEASES = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15';
const HF_API = 'https://huggingface.co/api/models';

/**
 * Кандидаты моделей. Точные файлы и SHA-256 берутся из API Hugging Face в момент установки.
 * Выбор по умолчанию предварительный: сравнение на наших сценариях (tools/ai-bench.js) ещё не проводилось.
 */
const GEMMA_TERMS = 'https://ai.google.dev/gemma/terms';
// repos — по порядку: если в первом репозитории нет подходящего файла, берётся следующий
// ramGb — сколько всего ОЗУ в компьютере нужно, чтобы модель работала рядом с лаунчером без подтормаживаний
const MODELS = [
  { id: 'qwen2.5-1.5b', label: 'Qwen2.5 1.5B Instruct (Q4_K_M)', repos: ['Qwen/Qwen2.5-1.5B-Instruct-GGUF'], pattern: /q4_k_m\.gguf$/i, license: 'Apache-2.0', ramGb: 4, default: true },
  { id: 'qwen3-4b', label: 'Qwen3 4B (Q4_K_M)', repos: ['Qwen/Qwen3-4B-GGUF', 'unsloth/Qwen3-4B-GGUF', 'bartowski/Qwen_Qwen3-4B-GGUF'], pattern: /Qwen3-4B-Q4_K_M\.gguf$/i, license: 'Apache-2.0', ramGb: 8, note: 'лучше всех понимает русский и просьбы о модах' },
  { id: 'gemma3-4b', label: 'Gemma 3 4B (Q4_K_M)', repos: ['ggml-org/gemma-3-4b-it-GGUF', 'unsloth/gemma-3-4b-it-GGUF', 'bartowski/google_gemma-3-4b-it-GGUF'], pattern: /gemma-3-4b-it-Q4_K_M\.gguf$/i, license: 'Gemma', terms: GEMMA_TERMS, ramGb: 8, note: 'Google, хорошо говорит по-русски' },
  { id: 'gemma3n-e2b', label: 'Gemma 3n E2B (Q4_K_M)', repos: ['unsloth/gemma-3n-E2B-it-GGUF', 'ggml-org/gemma-3n-E2B-it-GGUF', 'bartowski/google_gemma-3n-E2B-it-GGUF'], pattern: /gemma-3n-E2B-it-Q4_K_M\.gguf$/i, license: 'Gemma', terms: GEMMA_TERMS, ramGb: 6, note: 'Google, для слабых ПК' },
  { id: 'qwen3-1.7b', label: 'Qwen3 1.7B (Q4_K_M)', repos: ['ggml-org/Qwen3-1.7B-GGUF'], pattern: /Q4_K_M\.gguf$/i, license: 'Apache-2.0', ramGb: 4 },
  { id: 'qwen3.5-0.8b', label: 'Qwen3.5 0.8B (Q4_0)', repos: ['ggml-org/Qwen3.5-0.8B-GGUF'], pattern: /Q4_0\.gguf$/i, license: 'Apache-2.0', ramGb: 3 },
  { id: 'qwen2.5-0.5b', label: 'Qwen2.5 0.5B Instruct (Q4_K_M)', repos: ['Qwen/Qwen2.5-0.5B-Instruct-GGUF'], pattern: /q4_k_m\.gguf$/i, license: 'Apache-2.0', ramGb: 3 },
];

/** Базовая CPU-сборка llama.cpp для платформы; GPU-ускорители не скачиваются. */
// Windows — .zip; macOS и Linux — .tar.gz (раньше были .zip, поддерживаются оба)
function runtimeAssetPattern(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? /-bin-win-cpu-arm64\.zip$/ : /-bin-win-cpu-x64\.zip$/;
  if (platform === 'darwin') return arch === 'arm64' ? /-bin-macos-arm64\.(zip|tar\.gz)$/ : /-bin-macos-x64\.(zip|tar\.gz)$/;
  if (platform === 'linux') return arch === 'arm64' ? /-bin-ubuntu-arm64\.(zip|tar\.gz)$/ : arch === 'x64' ? /-bin-ubuntu-x64\.(zip|tar\.gz)$/ : null;
  return null;
}

/** Первый (самый новый) выпуск, где есть сборка для платформы с SHA-256 от GitHub. */
function pickRuntime(releases, pattern) {
  for (const rel of releases || []) {
    if (rel.draft) continue;
    const asset = (rel.assets || []).find((a) => pattern.test(a.name) && /^sha256:[0-9a-f]{64}$/.test(a.digest || ''));
    if (asset) return { rel, asset };
  }
  return null;
}

/** Распаковка архива движка: .zip — встроенно, .tar.gz — системным tar (есть в Windows 10+, macOS, Linux). */
async function extractArchive(file, dir) {
  await fsp.mkdir(dir, { recursive: true });
  if (/\.zip$/i.test(file)) return new AdmZip(file).extractAllTo(dir, true);
  await new Promise((resolve, reject) =>
    execFile('tar', ['-xzf', file, '-C', dir], (err, _o, stderr) => (err ? reject(new Error('Не удалось распаковать llama.cpp: ' + (stderr || err.message))) : resolve())),
  );
}

/** Память процесса (RSS, МБ) — для отчёта «до/во время/после выгрузки». */
function processRssMb(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(0);
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], (err, out) => {
        const m = !err && out.match(/"([\d\s., ]+)\s*K"/);
        resolve(m ? Math.round(Number(m[1].replace(/[^\d]/g, '')) / 1024) : 0);
      });
    } else {
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], (err, out) => resolve(err ? 0 : Math.round(Number(out.trim() || 0) / 1024)));
    }
  });
}

class AiManager {
  /** opts.serverBinary/modelPath — подмена для тестов и ручной настройки. */
  constructor(root, opts = {}) {
    this.dir = path.join(root, 'ai');
    this.stateFile = path.join(this.dir, 'state.json');
    this.opts = opts;
    this.proc = null;
    this.port = null;
    this.idleTimer = null;
    this.idleMs = opts.idleMs ?? 5 * 60 * 1000;
    this.loading = null;
  }

  async state() {
    try {
      return JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  async saveState(s) {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.stateFile, JSON.stringify(s, null, 2));
  }

  async status() {
    const s = await this.state();
    const bin = this.opts.serverBinary || s.runtime?.binary;
    const model = this.opts.modelPath || s.model?.path;
    return {
      supported: !!(this.opts.serverBinary || runtimeAssetPattern()),
      installed: !!(bin && fs.existsSync(bin) && model && fs.existsSync(model)),
      runtime: s.runtime || null,
      model: s.model || null,
      running: !!this.proc,
      pid: this.proc?.pid || null,
      rssMb: this.proc ? await processRssMb(this.proc.pid) : 0,
      models: MODELS.map(({ id, label, license, terms, ramGb, note, default: d }) => ({ id, label, license, terms: terms || null, ramGb, note: note || '', default: !!d })),
      totalRamGb: Math.round(os.totalmem() / 1024 ** 3),
    };
  }

  /** Что будет скачано и сколько это весит — показывается до загрузки. */
  async plan(modelId) {
    const m = MODELS.find((x) => x.id === modelId) || MODELS.find((x) => x.default);
    const pattern = runtimeAssetPattern();
    if (!pattern) throw new Error('Для этой платформы нет готовой сборки llama.cpp. Помощник работает по правилам.');
    const releases = await http.api(GITHUB_RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
    const found = pickRuntime(releases, pattern);
    if (!found) throw new Error('В последних выпусках llama.cpp нет CPU-сборки для этой платформы с контрольной суммой SHA-256.');
    const { rel, asset } = found;
    const runtimeSha = asset.digest.slice('sha256:'.length);
    let file = null;
    let repo = null;
    for (const r of m.repos) {
      const tree = await http.api(`${HF_API}/${r}/tree/main`).catch(() => null);
      file = Array.isArray(tree) ? tree.find((f) => m.pattern.test(f.path) && !/mmproj/i.test(f.path) && f.lfs?.oid) : null;
      if (file) {
        repo = r;
        break;
      }
    }
    if (!file) throw new Error('Не найден файл модели ' + m.label + ' с контрольной суммой. Попробуй позже или выбери другую модель.');
    return (this.lastPlan = {
      runtime: { tag: rel.tag_name, name: asset.name, url: asset.browser_download_url, size: asset.size, sha256: runtimeSha },
      model: { id: m.id, label: m.label, license: m.license, terms: m.terms || null, file: file.path, url: `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file.path)}`, size: file.lfs.size || file.size, sha256: file.lfs.oid },
      totalBytes: asset.size + (file.lfs.size || file.size),
    });
  }

  async install(plan, { signal, onProgress } = {}) {
    let done = 0;
    const total = plan.runtime.size + plan.model.size;
    const onBytes = (n) => {
      done += n;
      onProgress?.({ done, total });
    };
    await fsp.mkdir(this.dir, { recursive: true });
    const zip = path.join(this.dir, 'downloads', plan.runtime.name);
    await sha256Download(plan.runtime.url, zip, plan.runtime.sha256, plan.runtime.size, { signal, onBytes });
    const rtDir = path.join(this.dir, 'runtime', plan.runtime.tag);
    await fsp.rm(rtDir, { recursive: true, force: true });
    await extractArchive(zip, rtDir);
    const binary = findFile(rtDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    if (!binary) throw new Error('В архиве llama.cpp нет llama-server.');
    if (process.platform !== 'win32') await fsp.chmod(binary, 0o755);
    await fsp.rm(zip, { force: true });
    const modelPath = path.join(this.dir, 'models', path.basename(plan.model.file));
    await sha256Download(plan.model.url, modelPath, plan.model.sha256, plan.model.size, { signal, onBytes });
    await this.saveState({ runtime: { tag: plan.runtime.tag, binary, size: plan.runtime.size }, model: { id: plan.model.id, label: plan.model.label, path: modelPath, size: plan.model.size } });
    return this.status();
  }

  /** Удалить движок и модель (освобождает место на диске). */
  async uninstall() {
    await this.stop();
    await fsp.rm(this.dir, { recursive: true, force: true });
  }

  /** Загрузить модель (по запросу помощника). Контекст, потоки и длина ответа ограничены. */
  async start() {
    if (this.proc) return this.touch();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const s = await this.state();
      const bin = this.opts.serverBinary || s.runtime?.binary;
      const model = this.opts.modelPath || s.model?.path;
      if (!bin || !fs.existsSync(bin) || !model || !fs.existsSync(model)) throw new Error('Помощник ещё не установлен.');
      let port = 39000 + Math.floor(Math.random() * 2000);
      while (!(await portFree(port, '127.0.0.1'))) port++;
      const threads = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
      const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', '2048', '-t', String(threads), '-n', '384', '-np', '1', ...(this.opts.extraArgs || [])];
      const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      proc.stderr.on('data', () => {});
      this.proc = proc;
      this.port = port;
      proc.on('exit', () => {
        if (this.proc === proc) {
          this.proc = null;
          this.port = null;
        }
      });
      // готовность — по /health, а не по таймеру
      const until = Date.now() + 120000;
      while (Date.now() < until) {
        if (!this.proc) throw new Error('Процесс модели завершился при загрузке.');
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`);
          if (r.ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 300));
      }
      if (Date.now() >= until) {
        await this.stop();
        throw new Error('Модель не загрузилась за 2 минуты.');
      }
      this.touch();
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  touch() {
    clearTimeout(this.idleTimer);
    if (this.idleMs) this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
  }

  /** Выгрузить модель: процесс завершается, память освобождается. */
  async stop() {
    clearTimeout(this.idleTimer);
    const proc = this.proc;
    if (!proc) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => proc.kill('SIGKILL'), 5000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      proc.kill();
    });
  }

  available() {
    return true;
  }

  /** Запрос к модели с JSON-схемой (llama.cpp ограничивает вывод грамматикой). */
  async complete({ system, user, schema, maxTokens = 256 }) {
    await this.start();
    this.touch();
    const r = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } },
        // Qwen3 по умолчанию сначала «рассуждает» — для коротких ответов по схеме это лишнее время
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!r.ok) throw new Error('Модель вернула ошибку ' + r.status);
    const j = await r.json();
    return JSON.parse(j.choices?.[0]?.message?.content || 'null');
  }
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (e.name === name) return p;
  }
  return null;
}

/** Загрузка с проверкой SHA-256 (докачка через http.download, затем сверка хеша). */
async function sha256Download(url, dest, sha256, size, opts) {
  if (fs.existsSync(dest) && (await http.hashFile(dest, 'sha256')) === sha256) return;
  await http.download(url, dest + '.unverified', { size, ...opts });
  const got = await http.hashFile(dest + '.unverified', 'sha256');
  if (got !== sha256) {
    await fsp.rm(dest + '.unverified', { force: true });
    throw new Error('Контрольная сумма ' + path.basename(dest) + ' не совпала — файл удалён.');
  }
  await fsp.rename(dest + '.unverified', dest);
}

module.exports = { AiManager, MODELS, runtimeAssetPattern, pickRuntime, extractArchive, processRssMb };
