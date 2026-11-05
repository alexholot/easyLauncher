'use strict';
// Схема зависимостей мода по составу сборки (lock): кто ему нужен, кому нужен он сам, чего не хватает.
//
// Уровни (колонки схемы): -1 — моды, которым нужен выбранный; 0 — сам мод; 1, 2, … — его зависимости
// по цепочке. Каждый мод стоит на самом коротком пути от выбранного, повторно не рисуется: общая
// библиотека — один блок, к которому сходятся линии. Дальше идём только по установленным модам
// (у неустановленного состав неизвестен) и не идём по «несовместим» — это не зависимость.
const KINDS = ['required', 'optional', 'embedded', 'incompatible'];
const MAX_NODES = 80;

/**
 * lock — состав сборки, key — выбранный мод.
 * Возвращает { root, nodes, edges, problems, counts, truncated }.
 *   node: { key, name, version, source, projectId, level, installed, enabled, addedBy }
 *   edge: { from, to, kind } — «from зависит от to» (или несовместим с ним)
 *   problem: { kind: 'missing'|'disabled'|'conflict', from, to } — обязательной нет / выключена / несовместимый установлен
 */
function modGraph(lock, key) {
  const mods = new Map((lock?.mods || []).map((m) => [m.key, m]));
  const root = mods.get(key);
  if (!root) throw Object.assign(new Error('Такого мода нет в сборке.'), { code: 'NOT_FOUND' });
  const nodes = new Map();
  const edges = [];
  const seenEdge = new Set();
  let truncated = false;
  const add = (k, level) => {
    if (nodes.has(k)) return nodes.get(k);
    if (nodes.size >= MAX_NODES) {
      truncated = true;
      return null;
    }
    const m = mods.get(k);
    const [source, projectId] = k.split(':');
    const n = m
      ? { key: k, name: m.name, version: m.version || '', source: m.source, projectId: m.projectId, level, installed: true, enabled: m.enabled !== false, addedBy: m.addedBy || 'user' }
      : { key: k, name: null, version: '', source, projectId: projectId || null, level, installed: false, enabled: false, addedBy: null };
    nodes.set(k, n);
    return n;
  };
  const link = (from, to, kind) => {
    const id = `${from}>${to}`;
    if (seenEdge.has(id)) return;
    seenEdge.add(id);
    edges.push({ from, to, kind });
  };
  const depsOf = (m) => (m?.dependencies || []).filter((d) => d && typeof d.key === 'string' && d.key && d.key !== m.key && KINDS.includes(d.kind));

  add(key, 0);
  // вниз: зависимости по цепочке (обход в ширину — самый короткий путь)
  let frontier = [key];
  for (let level = 1; frontier.length; level++) {
    const next = [];
    for (const k of frontier) {
      for (const d of depsOf(mods.get(k))) {
        const existed = nodes.has(d.key);
        const n = add(d.key, level);
        if (!n) continue;
        link(k, d.key, d.kind);
        if (!existed && n.installed && d.kind !== 'incompatible') next.push(d.key);
      }
    }
    frontier = next;
  }
  // вверх: кому нужен выбранный мод (только прямые — иначе схема разрастается на всю сборку)
  for (const m of mods.values()) {
    if (m.key === key) continue;
    const d = depsOf(m).find((x) => x.key === key && x.kind !== 'incompatible');
    if (!d) continue;
    const n = add(m.key, nodes.has(m.key) ? nodes.get(m.key).level : -1);
    if (n) link(m.key, key, d.kind);
  }

  const problems = [];
  for (const e of edges) {
    const to = nodes.get(e.to);
    const from = nodes.get(e.from);
    // проблемы считаем только у включённых модов: выключенному его зависимости не нужны
    if (!from?.enabled) continue;
    if (e.kind === 'required' && !to.installed) problems.push({ kind: 'missing', from: e.from, to: e.to });
    else if (e.kind === 'required' && !to.enabled) problems.push({ kind: 'disabled', from: e.from, to: e.to });
    else if (e.kind === 'incompatible' && to.installed && to.enabled) problems.push({ kind: 'conflict', from: e.from, to: e.to });
  }
  const direct = edges.filter((e) => e.from === key);
  const counts = {
    required: direct.filter((e) => e.kind === 'required').length,
    optional: direct.filter((e) => e.kind === 'optional').length,
    embedded: direct.filter((e) => e.kind === 'embedded').length,
    incompatible: direct.filter((e) => e.kind === 'incompatible').length,
    dependents: edges.filter((e) => e.to === key).length,
    // все установленные моды, без которых выбранный не запустится (цепочка обязательных)
    chain: chainOf(mods, key).length,
  };
  return { root: key, nodes: [...nodes.values()], edges, problems, counts, truncated };
}

/** Все установленные моды, обязательные для key по цепочке (без него самого). */
function chainOf(mods, key) {
  const out = new Set();
  const stack = [key];
  while (stack.length) {
    const m = mods.get(stack.pop());
    for (const d of m?.dependencies || []) {
      if (d?.kind !== 'required' || d.key === key || out.has(d.key) || !mods.has(d.key)) continue;
      out.add(d.key);
      stack.push(d.key);
    }
  }
  return [...out];
}

module.exports = { modGraph, chainOf, MAX_NODES };
