'use strict';
// Главный экран: журнал сессий из событий игры и сервера, статистика сборки, скриншоты,
// проверка обновлений модов (с кэшем) и разбор новостей Mojang.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Services, parseNews } = require('../core/services');
const { Launcher } = require('../core/launcher');
const http = require('../core/http');
const { testLauncher } = require('./helpers');
const nbt = require('../core/nbt');

function services() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-home-'));
  return new Services(root, { launcher: testLauncher(Launcher, root, { totalMem: 16 * 1024 ** 3 }) });
}

test('журнал сессий: часы в игре, миры, друзья (без хозяина); короткий неудачный запуск не считается', async () => {
  const svc = services();
  const p = await svc.createProfile({ name: 'Выживание', minecraft: '1.21.1' });
  const dir = path.join(svc.worlds.savesDir(p.id), 'valley');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), nbt.write({ Data: { LevelName: 'Тихая долина', LastPlayed: BigInt(Date.now()), GameType: 0, hardcore: false } }));
  const emit = (ev) => svc.launcher.emit('event', ev);

  emit({ type: 'client', state: 'running', profileId: p.id, mode: 'play' });
  emit({ type: 'client-world', profileId: p.id, level: 'Тихая долина' });
  emit({ type: 'client', state: 'stopped', profileId: p.id, mode: 'play', code: 0, seconds: 2 * 3600 + 15 * 60 });
  emit({ type: 'client', state: 'running', profileId: p.id, mode: 'play' });
  emit({ type: 'client', state: 'stopped', profileId: p.id, mode: 'play', code: 1, seconds: 2 }); // упал на старте
  // сессия с друзьями: хозяин в списке игроков не считается другом
  svc.coopHostName = 'HostPlayer';
  emit({ type: 'server', state: 'starting', profileId: p.id, folder: 'valley', players: [] });
  emit({ type: 'server', state: 'running', profileId: p.id, folder: 'valley', players: ['HostPlayer', 'Friend1'] });
  emit({ type: 'server', state: 'running', profileId: p.id, folder: 'valley', players: ['HostPlayer'] });
  emit({ type: 'server', state: 'stopped', profileId: p.id, folder: 'valley', players: [] });
  await new Promise((r) => setTimeout(r, 50));
  await svc.playlog.queue;

  const shots = path.join(svc.store.gameDir(p.id), 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(shots, `2026-10-2${i % 10}_12.00.0${i}.png`), Buffer.alloc(100));

  const info = await svc.homeInfo(p.id);
  assert.equal(info.stats.launches, 1, 'неудачный запуск на 2 секунды не считается');
  assert.ok(info.stats.seconds >= 2 * 3600 + 15 * 60);
  assert.equal(info.stats.worlds, 1);
  assert.equal(info.stats.screenshots, 10);
  assert.equal(info.shots.length, 8, 'на главной — последние 8');
  assert.ok(info.stats.sizeBytes >= 1000);
  assert.equal(info.sessions.length, 2);
  assert.equal(info.sessions[0].mode, 'friends', 'новые сверху');
  assert.deepEqual(info.sessions[0].worlds, ['Тихая долина']);
  assert.deepEqual(info.sessions[0].players, ['Friend1']);
  assert.deepEqual(info.sessions[1].worlds, ['Тихая долина']);
  assert.equal(info.sessions[1].seconds, 2 * 3600 + 15 * 60);
});

test('обновления модов: подсчёт без сохранения плана, кэш, повторная проверка после изменения состава', async () => {
  const svc = services();
  const p = await svc.createProfile({ name: 'Моды', minecraft: '1.21.1', loader: 'fabric' });
  assert.deepEqual(await svc.modUpdates(p.id), { count: 0, names: [] }, 'без модов в каталог не ходим');
  const lock = await svc.store.getLock(p.id);
  lock.mods.push({ key: 'modrinth:AAA', source: 'modrinth', projectId: 'AAA', versionId: 'v1', name: 'Sodium', version: '0.5', file: { filename: 'a.jar', size: 1 } });
  await svc.store.saveLock(p.id, lock);
  let calls = 0;
  svc.planMods = async () => (calls++, svc.plans.set('x' + calls, {}), { planId: 'x' + calls, changes: [{ type: 'update', name: 'Sodium' }, { type: 'add', name: 'Fabric API' }] });
  const r = await svc.modUpdates(p.id);
  assert.equal(r.count, 1);
  assert.deepEqual(r.names, ['Sodium']);
  assert.equal(svc.plans.size, 0, 'план подсчёта не остаётся в памяти');
  await svc.modUpdates(p.id);
  assert.equal(calls, 1, 'повторно — из кэша');
  lock.mods[0].versionId = 'v2';
  await svc.store.saveLock(p.id, lock);
  await svc.modUpdates(p.id);
  assert.equal(calls, 2, 'состав изменился — проверяем заново');
  await svc.modUpdates(p.id, { force: true });
  assert.equal(calls, 3, '«Проверить ещё раз» идёт мимо кэша');
});

test('новости Mojang: только нужные поля, картинки только с launchercontent, офлайн — из кэша', async () => {
  const sample = {
    version: 1,
    entries: [
      { title: 'Minecraft: Java Edition 1.21.4', version: '1.21.4', type: 'release', date: '2024-12-03T10:00:00Z', shortText: 'The <b>Garden</b> Awakens', image: { url: '/images/1-21-4.jpg' }, contentPath: '1.21.4-abc.json', id: 'a' },
      { title: 'Minecraft Snapshot 25w02a', version: '25w02a', type: 'snapshot', date: '2025-01-08T10:00:00Z', shortText: 'x', image: { url: 'https://evil.example/x.jpg' }, contentPath: '../../etc/passwd', id: 'b' },
      { nope: true },
    ],
  };
  const list = parseNews(sample);
  assert.equal(list.length, 2);
  assert.equal(list[0].version, '25w02a', 'новые сверху');
  assert.equal(list[0].image, null, 'картинка с чужого адреса не показывается');
  assert.equal(list[0].contentPath, null, 'путь к тексту проверяется');
  assert.equal(list[1].image, 'https://launchercontent.mojang.com/images/1-21-4.jpg');
  assert.equal(list[1].text, 'The Garden Awakens', 'HTML из краткого текста убран');
  assert.deepEqual(parseNews({ unexpected: 1 }), []);
  // формат v1: полный текст прямо в записи, картинка — относительный путь
  const v1 = parseNews({ entries: [{ title: 'Minecraft Java Edition 1.19.4', version: '1.19.4', type: 'release', date: '2023-03-14T00:00:00Z', body: '<h1>New</h1><p>Horses &amp; more</p>', image: { url: 'images/1-19-4.jpg' }, id: 'c' }] });
  assert.equal(v1[0].text, 'New Horses & more');
  assert.equal(v1[0].body, '<h1>New</h1><p>Horses &amp; more</p>');
  assert.equal(v1[0].image, 'https://launchercontent.mojang.com/images/1-19-4.jpg');

  const svc = services();
  let online = true;
  http.setFetch(async (url) => {
    if (!online) throw new Error('offline');
    if (url.endsWith('/v2/javaPatchNotes.json')) return new Response(JSON.stringify(sample), { status: 200 });
    if (url.endsWith('/v2/1.21.4-abc.json')) return new Response(JSON.stringify({ body: '<p>Hello</p>' }), { status: 200 });
    return new Response('nf', { status: 404 });
  });
  try {
    assert.equal((await svc.news()).length, 2);
    assert.equal((await svc.newsBody('1.21.4-abc.json')).body, '<p>Hello</p>');
    await assert.rejects(svc.newsBody('../x.json'));
    // v2 пропал — берём v1
    const v1svc = services();
    http.setFetch(async (url) => (url.endsWith('/javaPatchNotes.json') && !url.includes('/v2/') ? new Response(JSON.stringify({ version: 1, entries: [{ title: 'Old', type: 'release', date: '2020-01-01', body: '<p>x</p>' }] }), { status: 200 }) : new Response('nf', { status: 404 })));
    assert.equal((await v1svc.news())[0].title, 'Old');
    http.setFetch(async () => {
      throw new Error('offline');
    });
    online = false;
    fs.utimesSync(path.join(svc.root, 'cache', 'java-patch-notes.json'), new Date(0), new Date(0)); // кэш устарел
    assert.equal((await svc.news()).length, 2, 'без сети — последние сохранённые новости');
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
  }
});
