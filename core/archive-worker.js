'use strict';
// Тяжёлая упаковка мира идёт вне главного потока Electron, чтобы окно не зависало.
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const AdmZip = require('adm-zip');

function safeEntries(zip) {
  for (const entry of zip.getEntries()) {
    const name = String(entry.entryName || '').replace(/\\/g, '/');
    const clean = path.posix.normalize(name);
    if (!name || name.startsWith('/') || clean === '..' || clean.startsWith('../') || !(clean === 'world' || clean.startsWith('world/')))
      throw new Error('В резервной копии найден небезопасный путь.');
  }
}

try {
  if (workerData.action === 'backup') {
    const zip = new AdmZip();
    zip.addLocalFolder(workerData.source, 'world', (name) => !/(^|[\\/])session\.lock$/.test(name));
    zip.writeZip(workerData.target);
    if (!new AdmZip(workerData.target).getEntry('world/level.dat')) throw new Error('Резервная копия получилась неполной.');
  } else if (workerData.action === 'restore') {
    const zip = new AdmZip(workerData.source);
    safeEntries(zip);
    if (!zip.getEntry('world/level.dat')) throw new Error('В копии нет level.dat.');
    fs.mkdirSync(workerData.target, { recursive: true });
    zip.extractAllTo(workerData.target, true);
  } else throw new Error('Неизвестная операция с резервной копией.');
  parentPort.postMessage({ ok: true });
} catch (e) {
  parentPort.postMessage({ ok: false, message: e.message });
}
