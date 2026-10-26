'use strict';
// Первый и повторный запуск через настоящий конвейер установки (Mojang и Fabric — локальная имитация).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('../core/http');
const { Launcher } = require('../core/launcher');
const { createFakeMojang } = require('./fakemojang');
const { buildFixtures, waitEvent } = require('./helpers');

test('первый запуск скачивает игру, Java и ресурсы с реальным прогрессом; повторный — без сети', async (t) => {
  if (!buildFixtures().ok) return t.skip('нет JDK');
  const fm = await createFakeMojang({ delayMs: 0 });
  http.setFetch((url, o) => fetch(fm.rewrite(url), o));
  const l = new Launcher(fs.mkdtempSync(path.join(os.tmpdir(), 'easy-first-')), { totalMem: 16 * 1024 ** 3 });
  try {
    const p = await l.store.createProfile({ minecraft: '1.21.1', loader: 'fabric' });
    const stages = [];
    l.on('event', (e) => e.type === 'stage' && stages.push(e));
    const stopped = waitEvent(l, (e) => e.type === 'client' && e.state === 'stopped');
    await l.play({ profileId: p.id, nickname: 'Steve', ram: 1 });
    assert.equal((await stopped).code, 0, 'поддельный клиент запустился через скачанную «Java»');
    const files = stages.filter((s) => s.stage === 'files' && s.detail);
    for (const d of ['Fabric', 'Java', 'Библиотеки и игра', 'Ресурсы игры']) assert.ok(files.some((s) => s.detail === d), 'этап ' + d);
    const assets = files.filter((s) => s.detail === 'Ресурсы игры');
    assert.equal(assets[0].unit, 'bytes');
    assert.equal(assets.at(-1).percent, 100);
    assert.ok(assets.some((s) => s.percent > 0 && s.percent < 100), 'промежуточный прогресс — по полученным байтам');
    assert.equal((await l.store.getLock(p.id)).loaderVersion, '0.16.9', 'версия Fabric запоминается');
    assert.ok(l.clientLines.includes('arg:--gameDir'));
    // повторный запуск: файлы на месте — ни одного запроса в сеть, без вопросов
    const before = fm.requests.length;
    const again = waitEvent(l, (e) => e.type === 'client' && e.state === 'stopped');
    await l.play({ profileId: p.id, nickname: 'Steve', ram: 1 });
    await again;
    assert.deepEqual(fm.requests.slice(before), []);
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
    fm.close();
    await l.shutdown();
  }
});
