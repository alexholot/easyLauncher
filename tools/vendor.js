'use strict';
// Копирует сторонние файлы интерфейса из node_modules в renderer/vendor: окно не грузит ничего из сети
// (CSP: только 'self'). Запуск после обновления пакетов: node tools/vendor.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = path.join(root, 'renderer', 'vendor');

const files = [
  // 3D-просмотр скина (three.js внутри сборки), лицензия MIT
  [nm('skinview3d', 'bundles', 'skinview3d.bundle.js'), 'skinview3d.bundle.js'],
  [nm('skinview3d', 'LICENSE'), 'LICENSE-skinview3d.txt'],
  // шрифты (SIL Open Font License): Manrope — текст, Unbounded — заголовки
  [nm('@fontsource-variable', 'manrope', 'files', 'manrope-cyrillic-wght-normal.woff2'), 'fonts/manrope-cyrillic.woff2'],
  [nm('@fontsource-variable', 'manrope', 'files', 'manrope-latin-wght-normal.woff2'), 'fonts/manrope-latin.woff2'],
  [nm('@fontsource-variable', 'manrope', 'LICENSE'), 'fonts/LICENSE-manrope.txt'],
  [nm('@fontsource-variable', 'unbounded', 'files', 'unbounded-cyrillic-wght-normal.woff2'), 'fonts/unbounded-cyrillic.woff2'],
  [nm('@fontsource-variable', 'unbounded', 'files', 'unbounded-latin-wght-normal.woff2'), 'fonts/unbounded-latin.woff2'],
  [nm('@fontsource-variable', 'unbounded', 'LICENSE'), 'fonts/LICENSE-unbounded.txt'],
];

for (const [src, rel] of files) {
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(rel, fs.statSync(dest).size);
}
