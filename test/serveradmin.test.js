'use strict';
// Админ-панель сервера хозяина: команды игрокам и миру, списки из файлов сервера, server.properties,
// правила игры по ответам сервера в журнал. Сервер — имитация (без Java): видно, какие команды ушли.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ServerAdmin } = require('../core/serveradmin');
const { parseProperties } = require('../core/server');

function fakeServer(dir, { rules = {}, snake = false } = {}) {
  const srv = new EventEmitter();
  Object.assign(srv, { state: 'running', profileId: 'p1', port: 25565, players: new Set(['HostPlayer', 'Friend1']), proc: { pid: 1 }, startedAt: Date.now() - 65000, ramGb: 3, sent: [] });
  srv.command = (c) => {
    srv.sent.push(c);
    const m = c.match(/^gamerule (\S+)$/);
    if (!m) return;
    // новые версии понимают только имена через подчёркивание
    const name = m[1];
    const camel = name.replace(/_(\w)/g, (_, ch) => ch.toUpperCase());
    setImmediate(() => {
      if (snake !== name.includes('_') || !(camel in rules)) return srv.emit('log', `[Server thread/INFO]: Incorrect argument for command`);
      srv.emit('log', `[Server thread/INFO]: Gamerule ${name} is currently set to: ${rules[camel]}`);
    });
  };
  return { server: srv, store: { serverDir: () => dir } };
}

function serverDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-admin-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Мир с друзьями\nmax-players=8\ndifficulty=normal\ngamemode=survival\npvp=true\nallow-flight=false\nspawn-protection=0\nview-distance=10\nsimulation-distance=6\nenable-command-block=false\nonline-mode=true\nwhite-list=true\n');
  fs.writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify([{ uuid: 'a', name: 'HostPlayer' }, { uuid: 'b', name: 'Friend1' }]));
  fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify([{ uuid: 'a', name: 'HostPlayer', level: 4 }]));
  fs.writeFileSync(path.join(dir, 'banned-players.json'), JSON.stringify([{ uuid: 'c', name: 'Griefer', reason: 'ломал дома' }]));
  return dir;
}

test('панель: состояние сервера, игроки онлайн, белый список, операторы, баны', async () => {
  const dir = serverDir();
  const admin = new ServerAdmin(fakeServer(dir), { rss: async () => 1500 });
  const info = await admin.info();
  assert.deepEqual(info.online, [{ name: 'HostPlayer', op: true }, { name: 'Friend1', op: false }]);
  assert.deepEqual(info.whitelist, ['HostPlayer', 'Friend1']);
  assert.deepEqual(info.bans, [{ name: 'Griefer', reason: 'ломал дома', created: null }]);
  assert.equal(info.properties.motd, 'Мир с друзьями');
  assert.equal(info.properties.pvp, true);
  assert.equal(info.memoryMb, 1500);
  assert.equal(info.ramGb, 3);
});

test('панель: команды игрокам и миру — только проверенные ники, без переводов строк', async () => {
  const l = fakeServer(serverDir());
  const admin = new ServerAdmin(l);
  admin.player('kick', 'Friend1', { reason: 'спать пора\nop Friend1' });
  admin.player('ban', 'Griefer');
  admin.player('op', 'Friend1');
  admin.player('gamemode', 'Friend1', { mode: 'creative' });
  admin.player('whitelist-remove', 'Friend1');
  admin.world('day');
  admin.world('say', 'Перезапуск через 5 минут');
  assert.deepEqual(l.server.sent, ['kick Friend1 спать пора op Friend1', 'ban Griefer Забанен хозяином', 'op Friend1', 'gamemode creative Friend1', 'whitelist remove Friend1', 'kick Friend1 Тебя убрали из белого списка', 'time set day', 'say Перезапуск через 5 минут']);
  assert.throws(() => admin.player('op', 'Friend1; stop'), /Ник/);
  assert.throws(() => admin.player('gamemode', 'Friend1', { mode: 'god' }), /режим/);
  assert.throws(() => admin.player('explode', 'Friend1'), /Неизвестное действие/);
  assert.throws(() => admin.world('say', '   '), /Напиши/);
});

test('панель: настройки сервера — сразу командой или после перезапуска; лишние ключи не принимаются', async () => {
  const dir = serverDir();
  const l = fakeServer(dir);
  const admin = new ServerAdmin(l);
  const r = await admin.setProperties({ difficulty: 'hard', gamemode: 'creative', pvp: false, 'max-players': 12, motd: 'Новый\nмир' });
  assert.deepEqual(l.server.sent, ['difficulty hard', 'defaultgamemode creative'], 'сложность и режим — сразу');
  assert.deepEqual(r.restartNeeded.sort(), ['max-players', 'motd', 'pvp']);
  const props = parseProperties(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'));
  assert.equal(props.get('pvp'), 'false');
  assert.equal(props.get('max-players'), '12');
  assert.equal(props.get('motd'), 'Новый мир', 'перевод строки не ломает файл');
  assert.equal(props.get('online-mode'), 'true', 'проверку аккаунтов панель не трогает');
  // выбор запомнен: следующий запуск сервера возьмёт его вместо значений по умолчанию
  const { readOverrides } = require('../core/serveradmin');
  assert.deepEqual(await readOverrides(dir), { difficulty: 'hard', gamemode: 'creative', pvp: false, 'max-players': 12, motd: 'Новый мир' });
  await assert.rejects(admin.setProperties({ 'online-mode': false }), /нельзя/);
  await assert.rejects(admin.setProperties({ 'max-players': 1000 }), /от 1 до 100/);
});

test('панель: правила игры по ответу сервера; новые имена через подчёркивание', async () => {
  const rules = { keepInventory: false, doDaylightCycle: true, playersSleepingPercentage: 100 };
  const old = new ServerAdmin(fakeServer(serverDir(), { rules }));
  assert.deepEqual(await old.gamerules(), rules);
  const fresh = fakeServer(serverDir(), { rules, snake: true });
  const admin = new ServerAdmin(fresh);
  assert.deepEqual(await admin.gamerules(), rules, 'сервер новой версии понял правила через подчёркивание');
  await admin.setGamerule('keepInventory', true);
  assert.equal(fresh.server.sent.at(-1), 'gamerule keep_inventory true');
  await assert.rejects(admin.setGamerule('keepInventory; stop', true), /Неизвестное правило/);
  await assert.rejects(admin.setGamerule('playersSleepingPercentage', 500), /от 0 до 100/);
});
