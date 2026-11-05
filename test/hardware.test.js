'use strict';
// «Ускорить сборку»: определение мощности компьютера и настройки графики под неё
const test = require('node:test');
const assert = require('node:assert');
const { classify, gpuName } = require('../core/hardware');
const { gameSetup } = require('../core/ai/builder');

test('имя видеокарты из строки рендерера Chromium', () => {
  assert.equal(gpuName('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002489) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'NVIDIA GeForce RTX 3060 Ti');
  assert.equal(gpuName('ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'Intel(R) UHD Graphics 620');
  assert.equal(gpuName('ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'AMD Radeon RX 6700 XT');
  assert.equal(gpuName(null), null);
});

test('уровни: встроенная видеокарта, мало памяти или ядер — слабый; сильная видеокарта и 16+ ГБ — мощный', () => {
  const r = (gpu, ramGb, cores) => classify({ gpu, ramGb, cores });
  assert.equal(r('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002489) Direct3D11 vs_5_0 ps_5_0, D3D11)', 32, 12).tier, 'strong');
  const igpu = r('ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 16, 8);
  assert.deepStrictEqual([igpu.tier, igpu.gpuKind, igpu.reasons], ['weak', 'integrated', ['встроенная видеокарта']]);
  assert.equal(r('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 16, 12).tier, 'weak', 'встроенная видеокарта AMD');
  assert.equal(r('ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)', 16, 8).tier, 'mid');
  assert.deepStrictEqual(r('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)', 8, 8).reasons, ['8 ГБ памяти'], 'сильная видеокарта, но мало памяти — слабый');
  assert.equal(r(null, 16, 8).tier, 'mid', 'видеокарта не определилась — средний');
  assert.equal(r(null, 16, 4).tier, 'weak');
});

test('настройки графики: слабый — дальность 6 и быстрая графика; мощный — дальность 10 даже в режиме FPS', () => {
  const weak = gameSetup({ totalGb: 16, reserveGb: 3, mods: 40, fps: true, gpuTier: 'weak' });
  assert.deepStrictEqual([weak.options.render, weak.options.simulation, weak.options.graphics], [6, 5, 0]);
  const strong = gameSetup({ totalGb: 32, reserveGb: 6, mods: 20, fps: true, gpuTier: 'strong' });
  assert.equal(strong.options.render, 10);
  const mid = gameSetup({ totalGb: 32, reserveGb: 6, mods: 20, fps: true, gpuTier: 'mid' });
  assert.equal(mid.options.render, 8);
  assert.equal(gameSetup({ totalGb: 32, reserveGb: 6, mods: 20, fps: true }).options.render, 8, 'без сведений о видеокарте — как раньше');
});
