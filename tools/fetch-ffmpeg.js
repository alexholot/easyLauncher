'use strict';
// FFmpeg для «Камеры воспоминаний» в установщик Windows: скачивает свежую LGPL-сборку BtbN, проверяет SHA-256
// и кладёт в ffmpeg-dist/ (только ffmpeg.exe и библиотеки, без ffplay/ffprobe). electron-builder копирует
// папку в resources/ffmpeg. Запускается сам перед `npm run dist:win`; в git папка не попадает.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const http = require('../core/http');
const { pickFfmpeg } = require('../core/memories');

const out = path.join(__dirname, '..', 'ffmpeg-dist');
const FF_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';

(async () => {
  const have = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(out, 'source.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  let pick;
  try {
    pick = pickFfmpeg(await (await http.request(FF_BASE + 'checksums.sha256', { retries: 2 })).text());
    if (!pick) throw new Error('в выпуске нет LGPL-сборки для Windows');
  } catch (e) {
    // без сети собираем с тем, что уже скачано; без FFmpeg установщик не собираем — камера бы не работала
    if (have && fs.existsSync(path.join(out, 'ffmpeg.exe'))) return console.log(`FFmpeg: нет сети (${e.message}), беру уже скачанный ${have.name}`);
    throw e;
  }
  if (have?.sha256 === pick.sha256 && fs.existsSync(path.join(out, 'ffmpeg.exe'))) return console.log('FFmpeg: уже есть', pick.name);
  const zip = path.join(__dirname, '..', 'dist', pick.name);
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  console.log('FFmpeg: скачиваю', pick.name);
  await http.download(pick.url, zip);
  if ((await http.hashFile(zip, 'sha256')) !== pick.sha256) {
    fs.rmSync(zip, { force: true });
    throw new Error('FFmpeg: хеш архива не совпал');
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const e of new AdmZip(zip).getEntries()) {
    const bin = /^[^/]+\/bin\/((?!ffplay|ffprobe)[\w.-]+\.(?:exe|dll))$/i.exec(e.entryName);
    const lic = /^[^/]+\/LICENSE\.txt$/i.test(e.entryName);
    if (bin) fs.writeFileSync(path.join(out, bin[1]), e.getData());
    else if (lic) fs.writeFileSync(path.join(out, 'LICENSE-ffmpeg.txt'), e.getData());
  }
  if (!fs.existsSync(path.join(out, 'ffmpeg.exe'))) throw new Error('FFmpeg: в архиве нет ffmpeg.exe');
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify({ name: pick.name, sha256: pick.sha256, url: pick.url }, null, 2));
  fs.rmSync(zip, { force: true });
  console.log('FFmpeg: готово', fs.readdirSync(out).join(', '));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
