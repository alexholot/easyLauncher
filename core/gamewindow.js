'use strict';
// Окно игры в Windows: какое окно сейчас активно, чьё оно и где его изображение на экране.
// Вызовы user32 через koffi (он уже есть для EOS) — без лишних процессов и без опроса PowerShell.
let api = null;

function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const RECT = koffi.struct('EL_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const POINT = koffi.struct('EL_POINT', { x: 'int32', y: 'int32' });
    api = {
      foreground: user32.func('void * __stdcall GetForegroundWindow()'),
      threadPid: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)'),
      iconic: user32.func('bool __stdcall IsIconic(void *hWnd)'),
      clientRect: user32.func(`bool __stdcall GetClientRect(void *hWnd, _Out_ EL_RECT *rect)`),
      toScreen: user32.func(`bool __stdcall ClientToScreen(void *hWnd, _Inout_ EL_POINT *pt)`),
      metrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
      RECT,
      POINT,
    };
  } catch {
    api = false;
  }
  return api;
}

/**
 * Активное окно: pid владельца, свёрнуто ли, клиентская область (без рамки и заголовка) в пикселях экрана.
 * null — не Windows или user32 недоступен.
 */
function foreground() {
  const a = load();
  if (!a) return null;
  const hwnd = a.foreground();
  if (!hwnd) return { pid: 0 };
  const pid = [0];
  a.threadPid(hwnd, pid);
  const minimized = a.iconic(hwnd);
  const r = {};
  if (!a.clientRect(hwnd, r)) return { pid: pid[0], minimized };
  const p = { x: 0, y: 0 };
  a.toScreen(hwnd, p);
  return { pid: pid[0], minimized, rect: { x: p.x, y: p.y, width: r.right - r.left, height: r.bottom - r.top } };
}

/** Виртуальный экран (все мониторы) и число мониторов — для смещений gdigrab и выбора ddagrab. */
function screens() {
  const a = load();
  if (!a) return null;
  return { left: a.metrics(76), top: a.metrics(77), width: a.metrics(78), height: a.metrics(79), monitors: a.metrics(80) };
}

module.exports = { foreground, screens, available: () => !!load() };
