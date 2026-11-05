'use strict';
// Фото-режим: откуда скриншот (мир и день — из сессии летописи, в которой он сделан)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Services } = require('../core/services');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'easy-ph-'));

test('подпись скриншота: мир и игровой день из летописи; скриншот без сессии — только сборка и дата', async () => {
  const svc = new Services(tmp(), { memories: Object.assign(new EventEmitter(), { list: async () => [], dir: tmp(), gameStarted() {}, gameStopped() {} }) });
  const p = await svc.store.createProfile({ name: 'Зомби', minecraft: '1.20.1', loader: 'forge' });
  const shots = path.join(svc.store.gameDir(p.id), 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, 'a.png'), 'x');
  fs.writeFileSync(path.join(shots, 'b.png'), 'x');
  await svc.chronicle.add(p.id, 'world1', { kind: 'session', seconds: 600, day: 17, shots: ['a.png'], pos: [10.4, 64, -200.6], dim: 'overworld' });
  const a = await svc.shotInfo(p.id, path.join(shots, 'a.png'));
  assert.deepStrictEqual([a.world, a.day, a.pos, a.build], ['world1', 17, [10.4, 64, -200.6], 'Зомби']);
  assert.ok(a.at);
  const b = await svc.shotInfo(p.id, path.join(shots, 'b.png'));
  assert.deepStrictEqual([b.world, b.day, b.pos], [null, null, null]);
});
