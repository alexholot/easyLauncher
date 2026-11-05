'use strict';
// Пробный запуск сборки, проверка после обновления модов и поиск виновника вылета — окна и их ход.

/** Окно ожидания пробного запуска; слушает события лаунчера, пока открыто. */
function checkProgress(title, text) {
  dialog(title, `<p>${text}</p><p class="hint" id="chk-step">Готовлю игру…</p><div class="bar indeterminate"><span></span></div><div class="actions"><button class="btn btn-ghost" id="chk-cancel">Остановить</button></div>`);
  const off = bridge.onEvent((ev) => {
    const step = $('#chk-step');
    if (!step) return;
    if (ev.type === 'stage') step.textContent = ev.detail ? `${ev.label || 'Подготовка'}: ${ev.detail}` : ev.label || 'Подготовка…';
    if (ev.type === 'probe' && ev.state === 'running') step.textContent = 'Игра запускается — окно Minecraft откроется и закроется само.';
    if (ev.type === 'probe' && ev.state === 'ready') step.textContent = 'Игра загрузилась, проверяю, что не упадёт…';
    if (ev.type === 'bisect' && ev.state === 'run') step.textContent = `Запуск ${ev.run} из ~${ev.total}: проверяю ${ev.testing} ${plural(ev.testing, 'мод', 'мода', 'модов')} из ${ev.of}`;
  });
  return off;
}

const REASON = { loaded: 'игра загрузилась до главного меню', crashed: 'игра вылетела при запуске', errors: 'моды не загрузились (экран ошибок)', timeout: 'не дождались загрузки за 8 минут', cancelled: 'проверка остановлена' };

/** «Проверить запуск»: игра откроется и закроется сама. */
async function probeDialog(pid) {
  const off = checkProgress('Проверка запуска', 'Лаунчер запустит игру с этой сборкой, дождётся главного меню и закроет её.');
  $('#chk-cancel').onclick = () => call('mods:culpritCancel');
  try {
    const r = await call('game:probe', pid);
    if (r.ok) dialog('Сборка запускается', `<div class="notice"><strong>Всё в порядке</strong>Игра загрузилась до главного меню за ${r.seconds} с.</div><div class="actions"><button class="btn btn-primary" data-close>Отлично</button></div>`);
    else if (r.ok === null) dialog('Проверка не завершена', `<p>${esc(REASON[r.reason] || r.reason)}.</p><div class="actions"><button class="btn btn-primary" data-close>Понятно</button></div>`);
    else
      dialog(
        'Сборка не запускается',
        `<div class="notice error"><strong>${esc(REASON[r.reason] || 'Ошибка')}</strong>${r.evidence ? esc(r.evidence) : ''}</div><p>Лаунчер может сам найти мод-виновника: он несколько раз запустит игру с половиной модов.</p><div class="actions"><button class="btn btn-primary" id="chk-find">Найти виновника</button><button class="btn btn-ghost" data-close>Закрыть</button></div>`,
      );
    if ($('#chk-find')) $('#chk-find').onclick = () => culpritDialog(pid);
  } catch (e) {
    errorDialog(e, 'Проверка не удалась');
  } finally {
    off();
  }
}

/** Поиск виновника вылета (mode: 'build' — вся сборка, 'update' — моды неудачного обновления). */
async function culpritDialog(pid, mode = 'build') {
  const off = checkProgress(
    mode === 'update' ? 'Ищу виноватое обновление' : 'Поиск виновника вылета',
    mode === 'update' ? 'Лаунчер по очереди проверяет обновления: часть модов — в новых версиях, часть — в прежних.' : 'Лаунчер запускает игру с половиной модов, потом с половиной оставшихся — так за несколько запусков находится мод, из-за которого вылет. Окно Minecraft будет открываться и закрываться — это нормально. Состав сборки не меняется.',
  );
  $('#chk-cancel').onclick = () => {
    $('#chk-cancel').disabled = true;
    $('#chk-step').textContent = 'Останавливаю…';
    call('mods:culpritCancel');
  };
  let r;
  try {
    r = await call('mods:culprit', pid, mode);
  } catch (e) {
    off();
    if (e.code === 'CANCELLED') return dialog('Поиск остановлен', '<p>Состав сборки не менялся.</p><div class="actions"><button class="btn btn-primary" data-close>Понятно</button></div>');
    return errorDialog(e, 'Поиск не удался');
  }
  off();
  if (!r.reproduced)
    return dialog(
      'Игра запускается',
      `<p>Со всеми ${mode === 'update' ? 'обновлениями' : 'модами'} игра дошла до главного меню${r.reason === 'timeout' ? ' (или грузилась дольше 8 минут)' : ''}. Значит, вылет случается позже — уже в мире.</p><p class="hint">Поиск виновника работает для вылетов при запуске. Для вылета в мире пришли отчёт помощнику — он разберёт его.</p><div class="actions"><button class="btn btn-primary" data-close>Понятно</button></div>`,
    );
  const c = r.culprits;
  const pair = c.length > 1;
  const row = (x) =>
    `<div class="culprit"><div><b>${esc(x.name)}</b><small>${x.kind === 'file' ? 'свой файл из папки модов' : x.kind === 'update' ? 'новая версия из обновления' : 'мод сборки'}</small></div><div class="culprit-acts">${
      x.kind === 'mod' ? `<button class="btn btn-secondary btn-small" data-cul-off="${esc(x.id)}">Выключить</button><button class="btn btn-ghost btn-small" data-cul-upd="${esc(x.id)}">Обновить</button>` : x.kind === 'file' ? `<button class="btn btn-secondary btn-small" data-cul-file="${esc(x.id)}">Выключить</button>` : ''
    }</div></div>`;
  const findings = (r.findings || []).map((f) => `<div class="notice"><strong>${esc(f.title)}</strong>${esc(f.fix)}</div>`).join('');
  const others = mode === 'update' ? `<p>Остальные обновления можно поставить без него — а версию «${esc(c[0].name)}» закрепить, чтобы она не обновлялась, пока автор не исправит.</p>` : '';
  dialog(
    pair ? 'Виноваты два мода вместе' : mode === 'update' ? 'Виновато одно обновление' : 'Виновник найден',
    `<p>${pair ? 'По отдельности они работают, а вместе игра вылетает:' : `Найдено за ${r.runs} ${plural(r.runs, 'запуск', 'запуска', 'запусков')}:`}</p>${c.map(row).join('')}${findings}${others}<div class="actions">${mode === 'update' ? '<button class="btn btn-primary" id="cul-rest">Поставить остальные обновления</button>' : ''}<button class="btn btn-ghost" data-close>Закрыть</button></div>`,
  );
  const done = async (msg) => {
    closeDialog();
    toast(msg);
    await refresh();
    render();
  };
  $$('[data-cul-off]').forEach((b) => (b.onclick = () => call('mods:enable', pid, b.dataset.culOff, false).then(() => done('Мод выключен — запусти игру.'), errorDialog)));
  $$('[data-cul-file]').forEach((b) => (b.onclick = () => call('mods:folderToggle', pid, b.dataset.culFile, false).then(() => done('Мод выключен — запусти игру.'), errorDialog)));
  $$('[data-cul-upd]').forEach(
    (b) =>
      (b.onclick = async () => {
        const plan = await call('mods:plan', pid, { update: [b.dataset.culUpd] }).catch((e) => (errorDialog(e), null));
        if (!plan) return;
        if (!plan.changes.length && plan.ok) return toast('Новее версии нет — лучше выключить мод.');
        planDialog(plan, 'Обновить мод', { pid, request: { update: [b.dataset.culUpd] } });
      }),
  );
  if ($('#cul-rest'))
    $('#cul-rest').onclick = async () => {
      // виноватый мод закрепляется на прежней версии — «обновить всё» его пропустит
      await call('mods:pin', pid, c[0].id, true).catch(() => {});
      const plan = await call('mods:plan', pid, { update: 'all' }).catch((e) => (errorDialog(e), null));
      if (plan) planDialog(plan, 'Обновления без виноватого', { pid, request: { update: 'all' }, noVerify: false });
    };
}

/** «Ускорить сборку»: компьютер, что будет сделано — и одна кнопка. */
async function boostDialog(pid) {
  dialog('Ускорить сборку', '<p>Узнаю компьютер и подбираю моды оптимизации под эту сборку…</p><div class="bar indeterminate"><span></span></div>');
  let r;
  try {
    r = await call('perf:boost', pid);
  } catch (e) {
    return errorDialog(e, 'Не получилось подобрать');
  }
  const h = r.hardware;
  const pc = [h.gpu ? `видеокарта ${h.gpu}` : 'видеокарта не определилась', `${h.ramGb} ГБ памяти`, `${h.cores} ${plural(h.cores, 'поток', 'потока', 'потоков')} процессора`].join(' · ');
  dialog(
    'Ускорить сборку',
    `<div class="notice ${h.tier === 'weak' ? '' : 'boost-ok'}"><strong>Компьютер ${esc(h.label)}</strong>${esc(pc)}${h.reasons.length ? `<br>Почему: ${esc(h.reasons.join(', '))} — настройки будут бережнее.` : ''}</div><p><b>Что сделаю:</b></p>${taskSteps(r.task)}<p class="hint">${esc(r.note || '')}</p><div id="boost-progress"></div><div class="actions"><button class="btn btn-primary" id="boost-go">${icon('play')}Ускорить</button><button class="btn btn-ghost" data-close>Отмена</button></div>`,
    true,
  );
  $('#boost-go').onclick = async () => {
    $('#boost-go').disabled = true;
    $('#boost-progress').innerHTML = '<p class="hint"><span class="spinner"></span>Ставлю моды и настройки…</p>';
    const off = bridge.onModsProgress((x) => {
      if ($('#boost-progress')) $('#boost-progress').innerHTML = `<p class="hint">${x.phase === 'verify' ? 'Проверка файлов…' : `Скачано ${mb(x.done)} из ${mb(x.total)}${x.name ? ' · ' + esc(x.name) : ''}`}</p>`;
    });
    try {
      await call('ai:run', r.task.id);
      closeDialog();
      toast('Сборка ускорена. Сравни один и тот же мир до и после.');
      await refresh();
      render();
    } catch (e) {
      if ($('#boost-progress')) $('#boost-progress').innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
      if ($('#boost-go')) $('#boost-go').disabled = false;
    } finally {
      off();
    }
  };
}

/** После обновления модов: пробный запуск; вылет — прежний состав уже вернулся, предлагаем найти виноватое обновление. */
async function verifyAfterUpdate(pid) {
  const off = checkProgress('Проверяю обновления', 'Лаунчер запустит игру с обновлёнными модами и закроет её, когда она загрузится. Если игра вылетит — вернёт прежние версии.');
  $('#chk-cancel').onclick = () => call('mods:culpritCancel');
  let r;
  try {
    r = await call('mods:verify', pid);
  } catch (e) {
    off();
    return errorDialog(e, 'Проверка не удалась');
  }
  off();
  await refresh();
  render();
  if (r.ok) {
    closeDialog();
    return toast(`Обновления проверены: игра запускается (${r.seconds} с).`);
  }
  if (!r.rolledBack) return dialog('Проверка не завершена', `<p>${esc(REASON[r.reason] || r.reason)}. Обновления остались.</p><div class="actions"><button class="btn btn-primary" data-close>Понятно</button></div>`);
  dialog(
    'С обновлениями игра вылетала',
    `<div class="notice error"><strong>Прежние версии возвращены</strong>Игра с обновлениями не запустилась (${esc(REASON[r.reason] || r.reason)}), поэтому лаунчер вернул состав сборки, который работал. Миры сохранены в копиях.</div><p>Обновлялись: ${esc(r.changed.join(', '))}.</p>${(r.findings || []).map((f) => `<div class="notice"><strong>${esc(f.title)}</strong>${esc(f.fix)}</div>`).join('')}<div class="actions">${r.changed.length > 1 ? '<button class="btn btn-primary" id="ver-find">Найти виноватое обновление</button>' : ''}<button class="btn btn-ghost" data-close>Закрыть</button></div>`,
  );
  if ($('#ver-find')) $('#ver-find').onclick = () => culpritDialog(pid, 'update');
}
