'use strict';
// Связи модов по самим файлам: какие моды объявляет JAR (с вложенными JAR) и какие обязательно требует.
// Каталог (Modrinth/CurseForge) указывает зависимости не всегда: мод может требовать библиотеку, о которой
// площадка не знает, — и игра вылетает с «Mod X requires Y». Эта проверка находит такое до запуска.
const fs = require('fs');
const AdmZip = require('adm-zip');

// Что даёт сама игра и загрузчик — не моды из папки mods
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt_base', 'forge', 'neoforge', 'javafml', 'lowcodefml', 'mixinextras']);

/** Простой разбор mods.toml: [[mods]] modId и [[dependencies.X]] modId/mandatory/type/side. */
function parseModsToml(text) {
  const ids = [];
  const deps = [];
  let table = null;
  let cur = null;
  const val = (raw) => {
    const s = raw.trim().replace(/\s+#.*$/, '');
    const q = s.match(/^"([^"]*)"|^'([^']*)'/);
    if (q) return q[1] ?? q[2];
    if (s === 'true' || s === 'false') return s === 'true';
    return s;
  };
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const h = t.match(/^\[\[\s*([\w.-]+)\s*\]\]/);
    if (h) {
      table = h[1] === 'mods' ? 'mods' : h[1].startsWith('dependencies.') ? 'dep' : 'other';
      cur = {};
      if (table === 'dep') deps.push(cur);
      continue;
    }
    if (/^\[/.test(t)) {
      table = 'other';
      continue;
    }
    const kv = t.match(/^([\w-]+)\s*=\s*(.+)$/);
    if (!kv || !table) continue;
    if (table === 'mods' && kv[1] === 'modId') ids.push(val(kv[2]));
    else if (table === 'dep') cur[kv[1]] = val(kv[2]);
  }
  const requires = [];
  const breaks = [];
  for (const d of deps) {
    if (!d.modId) continue;
    // Forge: mandatory=true; NeoForge: type="required"/"incompatible"; сторона SERVER клиенту не нужна
    const type = d.type ? String(d.type).toLowerCase() : d.mandatory === true ? 'required' : 'optional';
    if (String(d.side || 'BOTH').toUpperCase() === 'SERVER') continue;
    if (type === 'required') requires.push(d.modId);
    else if (type === 'incompatible') breaks.push(d.modId);
  }
  return { ids, requires, breaks };
}

// ---- версии в духе Fabric (SemanticVersion): 1.8.8+mc1.21.1, 0.6.x, >=1.2.1, <1.8.13, ~1.2, ^2.0 ----

/** «1.8.8-beta.2+mc1.21.1» → {core:[1,8,8], pre:['beta','2']} или null, если версия не числовая. */
function parseVersion(s) {
  const m = String(s || '').trim().match(/^v?(\d+(?:\.(?:\d+|[xX*]))*)(?:-([0-9A-Za-z.-]*))?(?:\+.*)?$/);
  if (!m) return null;
  return { core: m[1].split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : 'x')), pre: m[2] === undefined ? null : m[2].split('.').filter(Boolean) };
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
    const x = a.core[i] === 'x' ? 0 : a.core[i] || 0;
    const y = b.core[i] === 'x' ? 0 : b.core[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // без суффикса — старше, чем с суффиксом (1.0 > 1.0-beta); «1.0-» — самая младшая из 1.0
  if (!a.pre || !b.pre) return !a.pre && !b.pre ? 0 : a.pre ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Одно условие: «*», «0.6.x», «>=1.2.1», «<1.8.13», «~1.2», «^2.0», «1.0» (равно). Непонятное — не мешает. */
function predicate(p, v) {
  const m = String(p).trim().match(/^(>=|<=|>|<|=|~|\^)?\s*(.*)$/);
  const op = m[1] || '=';
  if (m[2] === '*' || m[2] === '') return true;
  const want = parseVersion(m[2]);
  if (!want) return true;
  const wild = want.core.indexOf('x');
  if (op === '=' && wild >= 0) return want.core.slice(0, wild).every((n, i) => (v.core[i] || 0) === n);
  const c = compareVersions(v, want);
  if (op === '>=') return c >= 0;
  if (op === '<=') return c <= 0;
  if (op === '>') return c > 0;
  if (op === '<') return c < 0;
  if (op === '=') return c === 0;
  // ~1.2.3: >=1.2.3 и та же минорная; ^1.2.3: >=1.2.3 и та же старшая
  const same = op === '~' ? 2 : 1;
  return c >= 0 && want.core.slice(0, Math.min(same, want.core.length)).every((n, i) => (v.core[i] || 0) === n);
}

/** Подходит ли версия под диапазон Fabric/Quilt (строка с условиями через пробел или список «или»). */
function satisfies(range, version) {
  if (range == null || range === '*') return true;
  const v = parseVersion(version);
  if (!v) return true; // «${version}», даты и прочее — сравнить честно нельзя
  const any = Array.isArray(range) ? range : [range];
  if (!any.length) return true;
  return any.some((r) => {
    if (typeof r !== 'string') return true;
    // Fabric пишет и «[0.6-,0.7-)» — интервалы в квадратных скобках
    const iv = r.trim().match(/^([[(])\s*([^,]*),\s*([^\])]*)([\])])$/);
    if (iv) return (!iv[2] || predicate((iv[1] === '[' ? '>=' : '>') + iv[2], v)) && (!iv[3] || predicate((iv[4] === ']' ? '<=' : '<') + iv[3], v));
    return r.trim().split(/\s+/).every((p) => predicate(p, v));
  });
}

/** Понятная запись диапазона для игрока: «0.6.x», «1.2.1 или новее», «до 1.8.13». */
function rangeText(range) {
  const one = (r) =>
    String(r)
      .trim()
      .replace(/^>=\s*(.+)$/, '$1 или новее')
      .replace(/^<\s*(.+)$/, 'до $1')
      .replace(/^[~^]\s*(.+)$/, 'совместимая с $1');
  return (Array.isArray(range) ? range : [range]).map(one).join(' или ');
}

/** fabric.mod.json / quilt.mod.json → id, provides, версия, обязательные зависимости (с диапазоном версий), несовместимые. */
function parseFabricLike(json, quilt) {
  const ids = [];
  const requires = [];
  const breaks = [];
  const nested = [];
  const ranges = {}; // id зависимости → диапазон версий
  const breakRanges = {}; // id → диапазон версий, которые этот мод не терпит
  let version = null;
  if (quilt) {
    const q = json.quilt_loader || {};
    version = q.version || null;
    if (q.id) ids.push(q.id);
    for (const p of q.provides || []) ids.push(typeof p === 'string' ? p : p.id);
    for (const d of q.depends || []) {
      const id = typeof d === 'string' ? d : d.id;
      if (!id || (typeof d === 'object' && d.optional)) continue;
      requires.push(id);
      if (typeof d === 'object' && (typeof d.versions === 'string' || Array.isArray(d.versions))) ranges[id] = d.versions;
    }
    for (const j of q.jars || []) nested.push(typeof j === 'string' ? j : j.file);
  } else {
    version = json.version || null;
    if (json.id) ids.push(json.id);
    for (const p of json.provides || []) ids.push(p);
    for (const [id, range] of Object.entries(json.depends || {})) {
      requires.push(id);
      ranges[id] = range;
    }
    for (const [id, range] of Object.entries(json.breaks || {})) {
      if (range === '*' || (Array.isArray(range) && range.includes('*'))) breaks.push(id);
      else breakRanges[id] = range;
    }
    for (const j of json.jars || []) if (j?.file) nested.push(j.file);
  }
  return { ids, requires, breaks, nested, version, ranges, breakRanges };
}

// Какое описание мода читает загрузчик сборки (по порядку). Один JAR бывает сразу для нескольких
// загрузчиков: в Forge-сборке требования из fabric.mod.json не действуют — иначе «не хватает fabric-api»
const READS = { fabric: ['fabric'], quilt: ['quilt', 'fabric'], forge: ['forge'], neoforge: ['neoforge', 'forge'] };

/** Описание одного JAR (файл или содержимое вложенного), вместе с вложенными JAR. */
function readJar(src, depth = 0) {
  const out = { ids: [], requires: [], breaks: [], by: {}, versions: {}, mixins: [] };
  let zip;
  try {
    zip = new AdmZip(src);
  } catch {
    return out;
  }
  const text = (n) => {
    const e = zip.getEntry(n);
    return e ? e.getData().toString('utf8').replace(/^﻿/, '') : null;
  };
  const nested = [];
  for (const [kind, name] of [['quilt', 'quilt.mod.json'], ['fabric', 'fabric.mod.json']]) {
    const raw = text(name);
    if (!raw) continue;
    try {
      const r = parseFabricLike(JSON.parse(raw), kind === 'quilt');
      out.by[kind] = r;
      out.ids.push(...r.ids);
      if (r.version) for (const id of r.ids) out.versions[id] = out.versions[id] || String(r.version);
      nested.push(...r.nested);
    } catch {}
  }
  for (const [kind, name] of [['neoforge', 'META-INF/neoforge.mods.toml'], ['forge', 'META-INF/mods.toml']]) {
    const raw = text(name);
    if (!raw) continue;
    const r = parseModsToml(raw);
    out.by[kind] = r;
    out.ids.push(...r.ids);
  }
  // Некоторые авторы публикуют мод под старую версию Minecraft, но собирают его Mixin для более
  // новой Java. Каталог этого не видит: причина вылета находится только внутри JAR.
  for (const e of zip.getEntries()) {
    if (!/(?:^|\/)[^/]*mixins?[^/]*\.json$/i.test(e.entryName)) continue;
    try {
      const json = JSON.parse(e.getData().toString('utf8').replace(/^﻿/, ''));
      const m = String(json.compatibilityLevel || '').match(/^JAVA_(\d+)$/i);
      if (m) out.mixins.push({ config: e.entryName, level: 'JAVA_' + m[1], java: Number(m[1]) });
    } catch {}
  }
  out.own = [...out.ids]; // id самого мода, без вложенных JAR
  // без указания загрузчика — первое найденное описание (как раньше)
  const first = out.by.quilt || out.by.fabric || out.by.neoforge || out.by.forge;
  if (first) {
    out.requires = [...first.requires];
    out.breaks = [...first.breaks];
  }
  // Forge/NeoForge кладут встроенные библиотеки в META-INF/jarjar
  for (const e of zip.getEntries()) if (/^META-INF\/jarjar\/[^/]+\.jar$/i.test(e.entryName)) nested.push(e.entryName);
  if (depth < 3) {
    for (const n of new Set(nested)) {
      const e = zip.getEntry(n);
      if (!e) continue;
      // вложенные JAR дают свои id (их требования удовлетворяет сам внешний мод)
      try {
        const inner = readJar(e.getData(), depth + 1);
        out.ids.push(...inner.ids);
        for (const [id, v] of Object.entries(inner.versions)) out.versions[id] = out.versions[id] || v;
        out.mixins.push(...inner.mixins.map((m) => ({ ...m, config: `${n}!${m.config}` })));
      } catch {}
    }
  }
  return out;
}

/** Java, с которой штатно запускается выпуск Minecraft. Неизвестные снапшоты не угадываем. */
function javaForMinecraft(minecraft) {
  const m = String(minecraft || '').match(/^1\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const minor = Number(m[1]);
  const patch = Number(m[2] || 0);
  if (minor <= 16) return 8;
  if (minor === 17) return 16;
  if (minor < 20 || (minor === 20 && patch <= 4)) return 17;
  return 21;
}

const cache = new Map(); // путь → {mtime, size, info}
function jarInfo(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.info;
  const info = readJar(file);
  cache.set(file, { mtime: st.mtimeMs, size: st.size, info });
  return info;
}

/** Требования мода для загрузчика сборки: из того описания, которое этот загрузчик читает. */
function needsFor(info, loader) {
  const kind = (READS[loader] || []).find((k) => info.by?.[k]);
  if (!loader || !READS[loader]) {
    const first = info.by?.quilt || info.by?.fabric || {};
    return { requires: info.requires, breaks: info.breaks, ranges: first.ranges, breakRanges: first.breakRanges };
  }
  return kind ? info.by[kind] : { requires: [], breaks: [] };
}

/**
 * Проверка набора модов. entries: [{name, file, key?, providerOnly?, offGame?}] — providerOnly: файл игрока,
 * его требования не проверяем (исправить его мы не можем), но то, что он объявляет, учитываем;
 * offGame: мод есть в сборке, но в папку игры не попадает (только для выделенного сервера).
 * loader — загрузчик сборки (чьё описание мода читать).
 * → { missing: [{id, by: [{name, key}]}], conflicts: [{a, b, aKey, bKey}],
 *     wrong: [{id, need, have, by: [{name, key}], provider: {name, key}}] — мод есть, но не той версии }
 */
function checkLinks(entries, loader = null, minecraft = null) {
  const provided = new Map([...BUILTIN].map((id) => [id, null])); // id → {e, version}
  const infos = [];
  for (const e of entries) {
    let info;
    try {
      info = jarInfo(e.file);
    } catch {
      continue;
    }
    infos.push({ e, info });
    if (e.offGame) continue;
    // из нескольких копий (отдельный мод и вложенные в другие JAR) Fabric берёт самую новую
    for (const id of info.ids) {
      const cur = provided.get(id);
      const version = info.versions?.[id] || null;
      if (cur === null) continue;
      const newer = !cur || (version && (!cur.version || (parseVersion(version) && parseVersion(cur.version) && compareVersions(parseVersion(version), parseVersion(cur.version)) > 0)));
      if (newer) provided.set(id, { e, version, nested: !(info.own || []).includes(id) });
    }
  }
  const missing = new Map();
  const wrong = new Map();
  const conflicts = [];
  const java = [];
  const gameJava = javaForMinecraft(minecraft);
  for (const { e, info: all } of infos) {
    // свой JAR игрока не проверяем: убрать его лаунчер не может, а запуск блокировался бы без кнопки «Исправить»
    if (!e.offGame && !e.providerOnly && gameJava) {
      for (const mixin of all.mixins || []) {
        if (mixin.java > gameJava) java.push({ name: e.name, key: e.key || null, config: mixin.config, need: mixin.java, have: gameJava });
      }
    }
    if (e.providerOnly || e.offGame) continue;
    const info = needsFor(all, loader);
    for (const id of new Set(info.requires)) {
      if (!provided.has(id)) {
        if (!missing.has(id)) missing.set(id, { id, by: [] });
        missing.get(id).by.push({ name: e.name, key: e.key || null });
        continue;
      }
      const p = provided.get(id);
      const range = info.ranges?.[id];
      if (!p || !p.version || p.e.providerOnly || satisfies(range, p.version)) continue;
      // nested: подходящей копии нет, а эта — вложена в другой мод; чинится отдельным новым модом
      if (!wrong.has(id)) wrong.set(id, { id, need: range, needText: rangeText(range), have: p.version, by: [], nested: !!p.nested, provider: { name: p.nested ? id : p.e.name, key: p.nested ? null : p.e.key || null } });
      wrong.get(id).by.push({ name: e.name, key: e.key || null });
    }
    for (const id of new Set(info.breaks)) {
      const other = infos.find((x) => x.e !== e && !x.e.offGame && x.info.ids.includes(id));
      if (other && other.e.providerOnly) continue;
      if (other) conflicts.push({ a: e.name, b: other.e.name, aKey: e.key || null, bKey: other.e.key || null });
    }
    // «несовместим с версиями до 1.8.13» — конфликт, только если стоит именно такая версия
    for (const [id, range] of Object.entries(info.breakRanges || {})) {
      const p = provided.get(id);
      if (!p || !p.version || p.e === e || p.e.providerOnly) continue;
      const v = parseVersion(p.version);
      if (v && satisfies(range, p.version)) conflicts.push({ a: e.name, b: p.e.name, aKey: e.key || null, bKey: p.e.key || null, range: rangeText(range), have: p.version });
    }
  }
  const report = { missing: [...missing.values()], conflicts, wrong: [...wrong.values()] };
  if (minecraft) report.java = java;
  return report;
}

module.exports = { checkLinks, readJar, javaForMinecraft, parseModsToml, parseFabricLike, parseVersion, compareVersions, satisfies, rangeText, BUILTIN };
