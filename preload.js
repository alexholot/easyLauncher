'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Каждый вызов возвращает значение или бросает ошибку с кодом и подсказкой следующего действия
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.ok) return r.value;
  // contextBridge передаёт у Error только текст — поэтому ошибка уходит обычным объектом с кодом
  throw { message: r?.error?.message || 'Неизвестная ошибка', ...(r?.error || {}) };
}
const on = (channel) => (fn) => {
  const h = (_e, v) => fn(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

const channels = [
  'win:minimize', 'win:maximize', 'win:close', 'sys:info',
  'auth:status', 'auth:logout', 'auth:login',
  'settings:get', 'settings:set', 'storage:info', 'storage:clean', 'java:pick','bg:set', 'bg:for',
  'home:info', 'home:updates', 'home:news', 'home:newsBody', 'bg:shot', 'profiles:overview', 'profiles:first', 'profiles:select', 'profiles:details', 'profiles:create', 'profiles:update', 'profiles:delete',
  'profiles:screenshots', 'profiles:export', 'profiles:import', 'profiles:coverPick', 'profiles:coverShot', 'profiles:coverClear',
  'worlds:list', 'worlds:coverPick', 'worlds:coverShot', 'worlds:coverPin', 'worlds:coverClear',
  'worlds:backups', 'worlds:backup', 'worlds:restore', 'worlds:delete', 'worlds:chronicle', 'worlds:map', 'worlds:mapTile', 'perf:last', 'perf:dismiss', 'challenge:status', 'challenge:catalog', 'challenge:create', 'challenge:accept', 'challenge:abandon', 'challenge:compare', 'memories:film', 'memories:filmFolder',
  'mc:versions', 'game:probe', 'mods:verify', 'mods:culprit', 'mods:culpritCancel', 'perf:boost', 'trophies:list', 'image:save', 'shots:data', 'shots:info', 'voice:status', 'voice:join', 'voice:leave', 'voice:hotkey', 'voice:test', 'loaders:versions', 'loaders:support', 'mc:status', 'mc:play', 'mc:cancel', 'mc:stopClient', 'mc:clientLog', 'server:command', 'server:log', 'admin:info', 'admin:player', 'admin:world', 'admin:props', 'admin:rules', 'admin:rule', 'admin:restart',
  'catalog:status', 'catalog:search', 'catalog:categories', 'catalog:project',
  'mods:install', 'mods:plan', 'mods:apply', 'mods:cancel', 'mods:rollback', 'mods:pin', 'mods:enable', 'mods:pickFile', 'mods:icons', 'mods:graph', 'mods:folder', 'mods:folderToggle', 'mods:folderRemove', 'mods:folderOpen',
  'coop:start', 'coop:end', 'room:open', 'room:invite', 'room:invites', 'room:revoke',
  'guest:open', 'guest:prepare', 'guest:connect', 'guest:leave',
  'ai:status', 'ai:plan', 'ai:install', 'ai:uninstall', 'ai:unload', 'ai:ask', 'ai:reroll', 'ai:run',
  'skins:list', 'skins:add', 'skins:pick', 'skins:read', 'skins:update', 'skins:remove', 'skins:apply', 'skins:account', 'skins:cape',
  'memories:status', 'memories:list', 'memories:remove', 'memories:pin', 'memories:plan', 'memories:install', 'memories:uninstall', 'memories:test', 'memories:folder',
  'open:folder', 'open:external', 'clipboard:write',
];
const api = {};
for (const c of channels) api[c] = (...args) => call(c, ...args);

contextBridge.exposeInMainWorld('easy', {
  call: (channel, ...args) => {
    if (!api[channel]) return Promise.reject(new Error('Неизвестный вызов ' + channel));
    return api[channel](...args);
  },
  onEvent: on('mc:event'),
  onModsProgress: on('mods:progress'),
  onRoom: on('room:state'),
  onGuestStage: on('guest:stage'),
  onAiProgress: on('ai:progress'),
  onInvite: on('invite:open'),
  onMemories: on('memories:state'),
  onMemoriesProgress: on('memories:progress'),
  // голосовой чат: события (звук, состав) и отправка кадра с микрофона без ожидания ответа
  onVoice: on('voice:event'),
  voiceSend: (buf) => buf instanceof Uint8Array && buf.length <= 4000 && ipcRenderer.send('voice:send', buf),
  // масштаб интерфейса (Настройки → Внешний вид)
  zoom: (f) => webFrame.setZoomFactor(Math.min(1.5, Math.max(0.75, Number(f) || 1))),
});
