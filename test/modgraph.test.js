'use strict';
// Схема зависимостей мода: уровни, общие библиотеки, кому нужен, проблемы состава, названия из каталога
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { modGraph, chainOf, MAX_NODES } = require('../core/modgraph');
const { Services } = require('../core/services');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-'));
const mod = (id, name, deps = [], extra = {}) => ({ key: `modrinth:${id}`, source: 'modrinth', projectId: id, name, version: '1.0', dependencies: deps.map(([k, kind]) => ({ key: `modrinth:${k}`, kind })), ...extra });

// Зомби → (Lib, Geo); Lib → Core; Geo → Core (общая); Пушка → Зомби; Карта → Зомби (необязательно)
const lock = () => ({
  minecraft: '1.20.1',
  loader: 'forge',
  mods: [
    mod('zombie', 'Зомби', [['lib', 'required'], ['geo', 'required'], ['jei', 'optional'], ['bad', 'incompatible'], ['emb', 'embedded']]),
    mod('lib', 'Lib', [['core', 'required']], { addedBy: 'dependency' }),
    mod('geo', 'Geo', [['core', 'required'], ['far', 'optional']], { addedBy: 'dependency' }),
    mod('core', 'Core', [], { addedBy: 'dependency' }),
    mod('gun', 'Пушка', [['zombie', 'required']]),
    mod('map', 'Карта', [['zombie', 'optional']]),
    mod('alone', 'Одиночка'),
  ],
});

test('схема мода: уровни по кратчайшему пути, общая библиотека — один блок, кому нужен — слева', () => {
  const g = modGraph(lock(), 'modrinth:zombie');
  const by = Object.fromEntries(g.nodes.map((n) => [n.key.split(':')[1], n]));
  assert.equal(by.zombie.level, 0);
  assert.equal(by.lib.level, 1);
  assert.equal(by.geo.level, 1);
  assert.equal(by.core.level, 2, 'Core — через Lib и Geo, второй уровень');
  assert.equal(g.nodes.filter((n) => n.key === 'modrinth:core').length, 1, 'общая библиотека не дублируется');
  assert.equal(g.edges.filter((e) => e.to === 'modrinth:core').length, 2, 'к ней сходятся две линии');
  assert.equal(by.gun.level, -1);
  assert.equal(by.map.level, -1);
  assert.ok(!by.alone, 'несвязанные моды сборки в схему не попадают');
  // неустановленные — листья: необязательная, несовместимая, встроенная
  assert.equal(by.jei.installed, false);
  assert.equal(by.bad.installed, false);
  assert.equal(by.emb.installed, false);
  assert.equal(by.far.level, 2, 'необязательная зависимость зависимости тоже видна');
  assert.deepStrictEqual(g.counts, { required: 2, optional: 1, embedded: 1, incompatible: 1, dependents: 2, chain: 3 });
  assert.deepStrictEqual(g.problems, [], 'в целой сборке проблем нет');
  assert.equal(g.edges.find((e) => e.from === 'modrinth:map').kind, 'optional');
});

test('схема мода: не хватает, выключена, несовместимый включён; у выключенного мода проблем нет', () => {
  const l = lock();
  l.mods = l.mods.filter((m) => m.key !== 'modrinth:core'); // библиотеку удалили
  l.mods.find((m) => m.key === 'modrinth:geo').enabled = false; // Geo выключили
  l.mods.push(mod('bad', 'Плохой')); // поставили несовместимый
  const g = modGraph(l, 'modrinth:zombie');
  const pr = g.problems.map((p) => `${p.kind}:${p.from.split(':')[1]}>${p.to.split(':')[1]}`).sort();
  // Geo выключен — его отсутствующая Core не считается; Lib включён — Core нужна ему
  assert.deepStrictEqual(pr, ['conflict:zombie>bad', 'disabled:zombie>geo', 'missing:lib>core']);
  // по несовместимому установленному моду схема дальше не идёт
  assert.equal(g.nodes.find((n) => n.key === 'modrinth:bad').installed, true);
  assert.equal(g.edges.filter((e) => e.from === 'modrinth:bad').length, 0);
  // выключенный выбранный мод — проблем у него нет
  l.mods.find((m) => m.key === 'modrinth:zombie').enabled = false;
  assert.deepStrictEqual(modGraph(l, 'modrinth:zombie').problems.filter((p) => p.from === 'modrinth:zombie'), []);
});

test('схема мода: кольцо зависимостей, мусор в записи, неизвестный мод, предел размера', () => {
  const l = { mods: [mod('a', 'A', [['b', 'required']]), mod('b', 'B', [['a', 'required']]), { ...mod('c', 'C'), dependencies: [{ key: 'modrinth:c', kind: 'required' }, { kind: 'required' }, { key: 'modrinth:a', kind: 'странная' }, null] }] };
  const g = modGraph(l, 'modrinth:a');
  assert.deepStrictEqual(g.nodes.map((n) => n.key).sort(), ['modrinth:a', 'modrinth:b'], 'кольцо не зацикливает');
  assert.equal(g.edges.length, 2, 'A→B и B→A');
  assert.equal(g.counts.dependents, 1);
  const c = modGraph(l, 'modrinth:c');
  assert.equal(c.nodes.length, 1, 'сам на себя, без ключа, неизвестный вид — пропускаются');
  assert.throws(() => modGraph(l, 'modrinth:nope'), /нет в сборке/);
  // огромная сборка: схема обрезается, но не падает
  const many = Array.from({ length: 150 }, (_, i) => mod(`m${i}`, `M${i}`));
  many.push(mod('hub', 'Hub', many.map((m) => [m.projectId, 'required'])));
  const big = modGraph({ mods: many }, 'modrinth:hub');
  assert.equal(big.nodes.length, MAX_NODES);
  assert.equal(big.truncated, true);
  assert.equal(big.counts.chain, 150, 'цепочка обязательных считается по всей сборке');
  assert.deepStrictEqual(chainOf(new Map(lock().mods.map((m) => [m.key, m])), 'modrinth:gun').sort(), ['modrinth:core', 'modrinth:geo', 'modrinth:lib', 'modrinth:zombie']);
});

test('схема мода в сервисе: названия неустановленных одним запросом, только CDN, кэш без сети, проверка ключа', async (t) => {
  const http = require('../core/http');
  const svc = new Services(tmp(), { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'М', minecraft: '1.20.1', loader: 'forge' });
  const l = await svc.store.getLock(p.id);
  l.mods = lock().mods;
  await svc.store.saveLock(p.id, l);
  const asked = [];
  http.setFetch(async (url) => {
    const ids = JSON.parse(new URL(url).searchParams.get('ids'));
    asked.push(ids);
    const all = [
      { id: 'jei', slug: 'jei', title: 'Just Enough Items', icon_url: 'https://cdn.modrinth.com/data/jei/icon.png' },
      { id: 'bad', slug: 'bad', title: 'Плохой мод', icon_url: 'https://evil.example/x.png' },
      { id: 'zombie', slug: 'zombie', title: 'Зомби', icon_url: 'https://cdn.modrinth.com/data/zombie/icon.png' },
    ];
    return new Response(JSON.stringify(all.filter((x) => ids.includes(x.id))), { status: 200 });
  });
  t.after(() => http.setFetch((...a) => globalThis.fetch(...a)));
  const g = await svc.modGraph(p.id, 'modrinth:zombie');
  const by = Object.fromEntries(g.nodes.map((n) => [n.key.split(':')[1], n]));
  assert.equal(by.jei.name, 'Just Enough Items');
  assert.equal(by.jei.iconUrl, 'https://cdn.modrinth.com/data/jei/icon.png');
  assert.equal(by.bad.name, 'Плохой мод');
  assert.equal(by.bad.iconUrl, null, 'картинка не с CDN каталога не отдаётся');
  assert.equal(by.emb.name, null, 'каталог не знает — без названия');
  assert.equal(by.zombie.iconUrl, 'https://cdn.modrinth.com/data/zombie/icon.png', 'у установленных — картинки сборки');
  assert.equal(g.loader, 'forge');
  const depAsk = asked.find((ids) => ids.includes('jei'));
  assert.deepStrictEqual(depAsk.sort(), ['bad', 'emb', 'far', 'jei'], 'все неустановленные — одним запросом');
  // без сети — из кэша
  http.setFetch(async () => {
    throw new Error('нет сети');
  });
  const again = await svc.modGraph(p.id, 'modrinth:zombie');
  assert.equal(again.nodes.find((n) => n.key === 'modrinth:jei').name, 'Just Enough Items');
  await assert.rejects(svc.modGraph(p.id, '../../etc'), /Некорректный мод/);
  await assert.rejects(svc.modGraph(p.id, 'modrinth:nope'), /нет в сборке/);
});
