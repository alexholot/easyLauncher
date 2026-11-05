'use strict';
// Насколько мощный компьютер для Minecraft: видеокарта (имя от Chromium), память, ядра процессора.
// Ничего не измеряет — только узнаёт модель и раскладывает по трём уровням, чтобы подобрать настройки.

/** «ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002489) Direct3D11 vs_5_0 ps_5_0, D3D11)» → «NVIDIA GeForce RTX 3060 Ti». */
function gpuName(renderer) {
  const s = String(renderer || '').trim();
  const m = /^ANGLE \(([^,]+),\s*(.+?)(?:\s*\(0x[0-9a-f]+\))?\s+(?:Direct3D|OpenGL|Vulkan|Metal)/i.exec(s);
  const name = (m ? m[2] : s).replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/\s{2,}/g, ' ').trim();
  return name.slice(0, 80) || null;
}

const INTEGRATED = /Intel.*(?:UHD|HD|Iris|Graphics)|AMD Radeon\(TM\) (?:Graphics|Vega)|Radeon (?:TM )?Graphics|Radeon Vega \d+ Graphics|Microsoft Basic Render|SwiftShader|llvmpipe|Mali|Adreno/i;
const STRONG = /RTX \d{4}|RTX A\d{4}|RX [67]\d{3}|RX 5[67]\d{2}|GTX 16[56]0|Arc A7\d\d|Radeon Pro W[67]/i;
const MID = /GTX (?:9\d0|10[5-8]0|16[35]0)|RX (?:4[6-9]0|5[5-9]0|5500)|Arc A[35]\d\d|Quadro|Radeon Pro/i;

/**
 * { gpu, ramGb, cores } → { tier: 'weak'|'mid'|'strong', gpuKind, gpu, label, reasons[] }.
 * Слабый: встроенная видеокарта, до 8 ГБ памяти или до 4 потоков; мощный: сильная видеокарта и от 16 ГБ.
 */
function classify({ gpu, ramGb, cores }) {
  const name = gpuName(gpu);
  const gpuKind = !name ? 'unknown' : INTEGRATED.test(name) ? 'integrated' : STRONG.test(name) ? 'strong' : MID.test(name) ? 'mid' : 'dedicated';
  const reasons = [];
  if (gpuKind === 'integrated') reasons.push('встроенная видеокарта');
  if (ramGb && ramGb <= 8) reasons.push(`${ramGb} ГБ памяти`);
  if (cores && cores <= 4) reasons.push(`${cores} потока процессора`);
  let tier = 'mid';
  if (reasons.length) tier = 'weak';
  else if (gpuKind === 'strong' && ramGb >= 16 && cores >= 8) tier = 'strong';
  const label = { weak: 'слабый для Minecraft с модами', mid: 'средний', strong: 'мощный' }[tier];
  return { tier, gpuKind, gpu: name, ramGb, cores, label, reasons };
}

module.exports = { classify, gpuName };
