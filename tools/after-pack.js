'use strict';
// EOS необязателен и хранится вне git. Добавляем его только в Windows-сборку, когда оба файла есть.
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const root = context.packager.projectDir;
  const dll = path.join(root, 'eos-sdk', 'SDK', 'Bin', 'EOSSDK-Win64-Shipping.dll');
  const config = path.join(root, 'eos.local.json');
  if (!fs.existsSync(dll) || !fs.existsSync(config)) {
    console.warn('EOS не добавлен: локальные DLL и eos.local.json не найдены. Остальные возможности сборки работают.');
    return;
  }
  const target = path.join(context.appOutDir, 'resources', 'eos');
  await fs.promises.mkdir(target, { recursive: true });
  await fs.promises.copyFile(dll, path.join(target, 'EOSSDK-Win64-Shipping.dll'));
  await fs.promises.copyFile(config, path.join(target, 'eos.json'));
};
