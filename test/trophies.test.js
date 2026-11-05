'use strict';
// Трофеи: считаются по журналу, летописи, вызовам, роликам и скриншотам; полученный не пропадает
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Services } = require('../core/services');
const { Trophies, TROPHIES, check, norm } = require('../core/trophies');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-t-'));
const empty = () => ({ hours: 0, launches: 0, builds: 0, maxMods: 0, maxDay: 0, deaths: 0, advTitles: new Set(), advancements: 0, friendSessions: 0, challenges: 0, clips: 0, screenshots: 0 });

test('трофеи: условия, прогресс, достижения на русском и английском', () => {
  const s = { ...empty(), hours: 12.5, maxDay: 57, advTitles: new Set([norm('Алмазы!'), norm('We Need to Go Deeper')]) };
  const by = Object.fromEntries(TROPHIES.map((t) => [t.id, check(t, s)]));
  assert.equal(by.hour10.done, true);
  assert.deepStrictEqual([by.hour100.done, by.hour100.value, by.hour100.need], [false, 12.5, 100]);
  assert.equal(by.day50.done, true);
  assert.equal(by.day100.done, false);
  assert.equal(by.adv_diamond.done, true, 'русское название');
  assert.equal(by.adv_nether.done, true, 'английское название');
  assert.equal(by.adv_dragon.done, false);
  assert.equal(new Set(TROPHIES.map((t) => t.id)).size, TROPHIES.length, 'id не повторяются');
});

test('трофеи: дата получения сохраняется, полученный трофей не пропадает, «новые» — только один раз', async () => {
  const book = new Trophies(tmp());
  const a = await book.evaluate({ ...empty(), hours: 1.2 });
  assert.deepStrictEqual(a.fresh.map((t) => t.id), ['hour1']);
  assert.equal(a.earned, 1);
  const b = await book.evaluate({ ...empty(), hours: 1.3 });
  assert.equal(b.fresh.length, 0, 'второй раз не «новый»');
  const c = await book.evaluate(empty()); // мир удалили, журнал очистили
  assert.equal(c.list.find((t) => t.id === 'hour1').done, true, 'полученный не пропадает');
  assert.ok(c.list.find((t) => t.id === 'hour1').at);
});

test('трофеи в сервисе: часы и запуски, летопись (день, смерти, достижения), скриншоты, вызовы', async () => {
  const root = tmp();
  const svc = new Services(root, { memories: Object.assign(new EventEmitter(), { list: async () => [{}, {}], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'A', minecraft: '1.20.1', loader: 'fabric' });
  await svc.store.createProfile({ name: 'B', minecraft: '1.20.1', loader: 'vanilla' });
  await svc.playlog.add(p.id, { mode: 'play', seconds: 4000 });
  await svc.playlog.add(p.id, { mode: 'friends', seconds: 600 });
  await svc.chronicle.add(p.id, 'w1', { kind: 'advancement', title: 'Алмазы!', day: 12 });
  await svc.chronicle.add(p.id, 'w1', { kind: 'death', title: '', day: 13 });
  await svc.chronicle.add(p.id, 'w1', { kind: 'session', seconds: 100, day: 14 });
  const shots = path.join(svc.store.gameDir(p.id), 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(shots, `s${i}.png`), 'x');
  const s = await svc.trophyStats();
  assert.deepStrictEqual([Math.round(s.hours * 3600), s.launches, s.friendSessions, s.builds, s.maxDay, s.deaths, s.advancements, s.screenshots, s.clips], [4600, 1, 1, 2, 14, 1, 1, 3, 2]);
  const t = await svc.trophies();
  const got = t.list.filter((x) => x.done).map((x) => x.id).sort();
  assert.deepStrictEqual(got, ['adv_diamond', 'day10', 'friends', 'hour1']);
  assert.equal(t.hours, 1);
});
