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

/** fabric.mod.json / quilt.mod.json → id, provides, обязательные зависимости, несовместимые (только «любая версия»). */
function parseFabricLike(json, quilt) {
  const ids = [];
  const requires = [];
  const breaks = [];
  const nested = [];
  if (quilt) {
    const q = json.quilt_loader || {};
    if (q.id) ids.push(q.id);
    for (const p of q.provides || []) ids.push(typeof p === 'string' ? p : p.id);
    for (const d of q.depends || []) {
      const id = typeof d === 'string' ? d : d.id;
      if (id && !(typeof d === 'object' && d.optional)) requires.push(id);
    }
    for (const j of q.jars || []) nested.push(typeof j === 'string' ? j : j.file);
  } else {
    if (json.id) ids.push(json.id);
    for (const p of json.provides || []) ids.push(p);
    for (const id of Object.keys(json.depends || {})) requires.push(id);
    for (const [id, range] of Object.entries(json.breaks || {})) if (range === '*' || (Array.isArray(range) && range.includes('*'))) breaks.push(id);
    for (const j of json.jars || []) if (j?.file) nested.push(j.file);
  }
  return { ids, requires, breaks, nested };
}

// Какое описание мода читает загрузчик сборки (по порядку). Один JAR бывает сразу для нескольких
// загрузчиков: в Forge-сборке требования из fabric.mod.json не действуют — иначе «не хватает fabric-api»
const READS = { fabric: ['fabric'], quilt: ['quilt', 'fabric'], forge: ['forge'], neoforge: ['neoforge', 'forge'] };

/** Описание одного JAR (файл или содержимое вложенного), вместе с вложенными JAR. */
function readJar(src, depth = 0) {
  const out = { ids: [], requires: [], breaks: [], by: {} };
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
        out.ids.push(...readJar(e.getData(), depth + 1).ids);
      } catch {}
    }
  }
  return out;
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
  if (!loader || !READS[loader]) return { requires: info.requires, breaks: info.breaks };
  return kind ? info.by[kind] : { requires: [], breaks: [] };
}

/**
 * Проверка набора модов. entries: [{name, file, key?, providerOnly?}] — providerOnly: файл игрока,
 * его требования не проверяем (исправить его мы не можем), но то, что он объявляет, учитываем.
 * loader — загрузчик сборки (чьё описание мода читать).
 * → { missing: [{id, by: [{name, key}]}], conflicts: [{a, b}] }
 */
function checkLinks(entries, loader = null) {
  const provided = new Set(BUILTIN);
  const infos = [];
  for (const e of entries) {
    let info;
    try {
      info = jarInfo(e.file);
    } catch {
      continue;
    }
    for (const id of info.ids) provided.add(id);
    infos.push({ e, info });
  }
  const missing = new Map();
  const conflicts = [];
  for (const { e, info: all } of infos) {
    if (e.providerOnly) continue;
    const info = needsFor(all, loader);
    for (const id of new Set(info.requires)) {
      if (provided.has(id)) continue;
      if (!missing.has(id)) missing.set(id, { id, by: [] });
      missing.get(id).by.push({ name: e.name, key: e.key || null });
    }
    for (const id of new Set(info.breaks)) {
      const other = infos.find((x) => x.e !== e && x.info.ids.includes(id));
      if (other && other.e.providerOnly) continue;
      if (other) conflicts.push({ a: e.name, b: other.e.name });
    }
  }
  return { missing: [...missing.values()], conflicts };
}

module.exports = { checkLinks, readJar, parseModsToml, parseFabricLike, BUILTIN };
