'use strict';
// Отрисовка одной плитки карты вне главного потока: разбор региона занимает до секунды.
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { renderRegion, encodePng } = require('./worldmap');

try {
  const { mca, out, dataVersion } = workerData;
  const r = renderRegion(fs.readFileSync(mca), dataVersion);
  const tmp = out + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, encodePng(r.rgba, r.width, r.height));
  fs.renameSync(tmp, out);
  parentPort.postMessage({ ok: true, chunks: r.chunks });
} catch (e) {
  parentPort.postMessage({ ok: false, message: e.message });
}
