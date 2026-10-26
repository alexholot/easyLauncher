'use strict';
// Сквозная проверка восьми пользовательских сценариев в настоящем Electron (Playwright):
//   xvfb-run -a node test/electron/ui-e2e.js <папка для скриншотов>
// Сети Mojang/Modrinth/CurseForge и вход Microsoft имитируются локально (см. e2e-setup.js);
// игра и сервер — поддельные Java-программы. Хозяин и друг — два отдельных экземпляра на одном ПК.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { _electron } = require('playwright');

const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'easy-shots-'));
fs.mkdirSync(shots, { recursive: true });
const root = path.join(__dirname, '..', '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron');
const results = [];

function launch(home, env = {}) {
  return _electron.launch({
    executablePath: electron,
    args: ['--no-sandbox', '--user-data-dir=' + path.join(home, 'ud'), root],
    env: { ...process.env, EASYLAUNCHER_HOME: home, EASYLAUNCHER_E2E_SETUP: path.join(__dirname, 'e2e-setup.js'), ...env },
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-ui-'));
  const app = await launch(home, { E2E_LOGGED_OUT: '1', E2E_DELAY_MS: '60', FAKE_CLIENT_MS: '2500' });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1300, height: 860 }).catch(() => {});
  const errors = [];
  w.on('pageerror', (e) => errors.push(e.message));
  w.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const shot = (n, page = w) => page.screenshot({ path: path.join(shots, n + '.png') });
  const text = (s, page = w) => page.textContent(s);
  const call = (ch, ...a) => w.evaluate(([c, args]) => window.easy.call(c, ...args), [ch, a]);
  const step = (n) => console.log('· ' + n);
  const scenario = async (name, fn) => {
    console.log('\n## ' + name);
    const t = Date.now();
    await fn();
    results.push(`OK  ${name} (${((Date.now() - t) / 1000).toFixed(1)} с)`);
  };
  const nav = async (v) => {
    await w.click(`[data-view="${v}"]`);
    await w.waitForTimeout(250);
  };
  const toastHas = (re) => w.waitForFunction((src) => new RegExp(src).test(document.querySelector('#toast').textContent) && !document.querySelector('#toast').hidden, re.source, { timeout: 20000 });
  const gameClosed = () => w.waitForSelector('#play:not([disabled])', { timeout: 30000 });

  try {
    await w.waitForSelector('.home h1', { timeout: 30000 });

    await scenario('1. Первый запуск: вход, установка Vanilla, запуск', async () => {
      assert.equal(await text('.home h1'), 'Minecraft', 'первая сборка создана сама');
      assert.match(await text('.first-run'), /Первый запуск/);
      assert.match(await text('#account-kind'), /Вход не выполнен/);
      await shot('01-first-run');
      await w.click('#play');
      await w.waitForSelector('#gate-login');
      await shot('02-login-explained');
      await w.click('#gate-login');
      // подготовка: реальные этапы и объёмы из конвейера установки
      await w.waitForFunction(() => /Ресурсы игры|Java|Библиотеки/.test(document.querySelector('#launch-state')?.textContent || ''), null, { timeout: 30000 });
      step('прогресс: ' + (await text('#launch-state')).replace(/\s+/g, ' '));
      await shot('03-installing');
      await w.waitForSelector('button:has-text("Minecraft запущен")', { timeout: 60000 });
      assert.match(await text('#account-kind'), /Аккаунт Microsoft/);
      await shot('04-game-running');
      const log = await call('mc:clientLog');
      assert.ok(!/quickPlay/.test(log), '«Играть» открывает главное меню, без входа в мир и на сервер');
      await gameClosed();
    });

    await scenario('2. Повторный запуск — сразу, без вопросов', async () => {
      const t = Date.now();
      await w.click('#play');
      await w.waitForSelector('button:has-text("Minecraft запущен")', { timeout: 20000 });
      const ms = Date.now() - t;
      assert.ok(await w.$eval('#overlay', (o) => o.hidden), 'ни одного диалога');
      step(`игра запущена через ${ms} мс после нажатия`);
      assert.ok(!(await w.$('.first-run')), 'подсказка первого запуска больше не показывается');
      await gameClosed();
    });

    await scenario('8а. Помощник выключен: модель не установлена', async () => {
      const ai = await call('ai:status');
      assert.equal(ai.installed, false);
      assert.equal(ai.running, false);
      step('модель не установлена и не запущена — дальше все сценарии идут без неё');
    });

    await scenario('3. Новая сборка и установка модов с зависимостями', async () => {
      await nav('builds');
      await w.click('#new');
      await w.fill('#nb-name', 'Техно');
      await w.click('[data-loader="fabric"]');
      await shot('05-new-build');
      await w.click('#nb button[type=submit]');
      await w.waitForSelector('#mod-results .mod-row', { timeout: 20000 });
      assert.match(await w.$eval('#mod-target', (s) => s.selectedOptions[0].textContent), /Техно — Fabric 1\.21\.1/);
      await shot('06-catalog');
      await w.click('.mod-row[data-proj="P_CREATE"] [data-install]');
      await toastHas(/Установлено в «Техно».*Fabric API/);
      assert.ok(await w.$eval('#overlay', (o) => o.hidden), 'простая установка — без диалога подтверждения');
      await w.waitForSelector('.mod-row[data-proj="P_CREATE"] .tag.green');
      step('Create установлен, Fabric API подтянут: ' + (await text('#toast')));
      await w.fill('#mod-q', 'sod');
      await w.press('#mod-q', 'Enter');
      await w.waitForSelector('.mod-row[data-proj="P_SOD"] [data-install]');
      await w.click('.mod-row[data-proj="P_SOD"] [data-install]');
      await w.waitForSelector('.mod-row[data-proj="P_SOD"] .tag.green', { timeout: 20000 });
      await shot('07-installed');
      // мод только с бета-версией: лаунчер спрашивает, игрок может явно разрешить
      await w.fill('#mod-q', 'beta');
      await w.press('#mod-q', 'Enter');
      await w.waitForSelector('.mod-row[data-proj="P_BETA"] [data-install]');
      await w.click('.mod-row[data-proj="P_BETA"] [data-install]');
      await w.waitForSelector('[data-prerelease]');
      assert.match(await text('#dialog-body'), /только тестовые версии/);
      assert.ok(await w.$eval('#plan-apply', (b) => b.disabled), 'без решения применить нельзя');
      await shot('07b-prerelease');
      await w.click('[data-prerelease]');
      await w.waitForSelector('#plan-apply:not([disabled])');
      assert.match(await text('#dialog-body'), /Добавить Beta Mod 0\.1-beta/);
      assert.match(await text('#dialog-body'), /Совместимость проверена/);
      await w.click('#plan-apply');
      await w.waitForSelector('.mod-row[data-proj="P_BETA"] .tag.green', { timeout: 20000 });
      step('бета-версия установлена после явного разрешения');
    });

    await scenario('4. Возврат из карточки мода к прежнему поиску', async () => {
      await w.fill('#mod-q', '');
      await w.press('#mod-q', 'Enter');
      await w.waitForFunction(() => document.querySelectorAll('#mod-results .mod-row').length > 3);
      const rows = await w.$$eval('#mod-results .mod-row', (r) => r.length);
      await w.$eval('#main', (m) => (m.scrollTop = m.scrollHeight));
      const scroll = await w.$eval('#main', (m) => m.scrollTop);
      await w.selectOption('#mod-sort', 'downloads');
      await w.waitForTimeout(400);
      await w.$eval('#main', (m) => (m.scrollTop = m.scrollHeight));
      const scrollSorted = await w.$eval('#main', (m) => m.scrollTop);
      await w.click('.mod-row[data-proj="P_SOD"] .mod-name');
      await w.waitForSelector('#proj h1:has-text("Sodium")');
      await shot('08-mod-card');
      await w.click('#back');
      await w.waitForSelector('#mod-results .mod-row');
      assert.equal(await w.$eval('#mod-sort', (s) => s.value), 'downloads', 'сортировка сохранена');
      assert.equal(await w.$eval('#mod-q', (i) => i.value), '', 'запрос сохранён');
      assert.equal(await w.$$eval('#mod-results .mod-row', (r) => r.length), rows, 'тот же список');
      assert.equal(await w.$eval('#main', (m) => m.scrollTop), scrollSorted, 'та же позиция прокрутки');
      step(`результатов: ${rows}, прокрутка ${scrollSorted}px восстановлена (до сортировки ${scroll}px)`);
      // поиск с текстом: возврат к «К результатам «sod»»
      await w.fill('#mod-q', 'sod');
      await w.press('#mod-q', 'Enter');
      await w.waitForSelector('.mod-row[data-proj="P_SOD"]');
      await w.click('.mod-row[data-proj="P_SOD"] .mod-name');
      assert.match(await text('#back'), /К результатам «sod»/);
      await w.click('#back');
      assert.equal(await w.$eval('#mod-q', (i) => i.value), 'sod');
    });

    await scenario('5. Обновление, выключение мода и откат', async () => {
      // на «площадке» вышла новая версия Sodium
      await app.evaluate(() => {
        const { mock } = global.__e2e;
        mock.addMrVersion('V_SOD2', 'P_SOD', '0.9.0', { buf: mock.fabricJar('sodium2', 'client'), env: 'client_only', published: '2026-10-01T00:00:00Z' });
      });
      await nav('builds');
      await w.click('.card:has-text("Техно") [data-open]');
      await w.waitForSelector('#check-upd');
      await w.click('#check-upd');
      await w.waitForSelector('.plan-steps');
      assert.match(await text('#dialog-body'), /Обновить Sodium 0\.8\.13 → 0\.9\.0/);
      await shot('09-update-plan');
      await w.click('#plan-apply');
      await w.waitForFunction(() => /0\.9\.0/.test(document.querySelector('#tab-body').textContent), null, { timeout: 20000 });
      step('обновлено до 0.9.0');
      // выключение зависимости — предупреждение
      await w.click('.mod-row:has-text("Fabric API") [data-toggle]');
      await w.waitForSelector('#dialog-body .notice');
      assert.match(await text('#dialog-body'), /нужен для: Create/);
      await w.click('#dialog-body [data-close]');
      await w.waitForSelector('.mod-row.off:has-text("Fabric API")');
      await shot('10-mod-off');
      await w.click('.mod-row:has-text("Fabric API") [data-toggle]');
      await w.waitForSelector('.mod-row:has-text("Fabric API"):not(.off)');
      // откат: состав до последнего изменения (обновления); включение/выключение в историю не попадает
      await w.click('#rollback');
      await w.click('#rb-go');
      await toastHas(/Прежний состав возвращён/);
      await w.waitForFunction(() => /0\.8\.13/.test(document.querySelector('#tab-body').textContent));
      step('откат вернул Sodium 0.8.13');
      await shot('11-rolled-back');
    });

    let link;
    await scenario('7. Сессия с друзьями и подключение друга', async () => {
      await nav('friends');
      await w.selectOption('#h-build', { label: 'Техно — Fabric 1.21.1' });
      await w.waitForSelector('#h-name');
      await w.fill('#h-name', 'Наш завод');
      await w.check('#h-eula');
      await shot('12-friends-setup');
      await w.click('#host-form button[type=submit]');
      await w.waitForSelector('.tag:has-text("Сервер работает")', { timeout: 60000 });
      await w.click('#inv-new');
      await w.waitForSelector('#inv-out code');
      link = await text('#inv-out code');
      assert.ok(link.startsWith('easylauncher://join?'));
      await shot('13-session');
      const fhome = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-friend-'));
      const friend = await launch(fhome, { E2E_PLAYER: 'Friend1', FAKE_CLIENT_MS: '8000' });
      try {
        const f = await friend.firstWindow();
        await f.setViewportSize({ width: 1300, height: 860 }).catch(() => {});
        f.on('pageerror', (e) => errors.push('friend: ' + e.message));
        await f.waitForSelector('.home h1', { timeout: 30000 });
        await f.click('[data-view="friends"]');
        await f.fill('#join-link', link);
        await f.click('#join-form button[type=submit]');
        await f.waitForSelector('#g-go', { timeout: 20000 });
        const preview = await text('#guest-flow', f);
        assert.ok(/Наш завод/.test(preview) && /Create/.test(preview) && /Fabric API/.test(preview), 'друг видит мир, версию и моды');
        assert.ok(/Необязательные моды хозяина \(1\)/.test(preview), 'клиентский Sodium хозяина — по желанию');
        await shot('14-friend-invite', f);
        await f.click('#g-go');
        await f.waitForSelector('#guest-flow .notice.ok', { timeout: 90000 });
        const route = (await text('#guest-flow', f)).replace(/\s+/g, ' ');
        step('друг: ' + route.slice(0, 100));
        assert.ok(/напрямую|relay|TURN/.test(route));
        await shot('15-friend-joined', f);
        await w.waitForFunction(() => /Friend1 — подключён/.test(document.querySelector('#main').textContent), null, { timeout: 30000 });
        assert.ok(((await w.textContent('#inv-out').catch(() => '')) || '').includes('easylauncher://join?'), 'ссылка-приглашение не пропала после подключения друга');
        step('у хозяина: ' + (await w.textContent('.people >> nth=1')).replace(/\s+/g, ' ').trim());
        await shot('16-host-sees-friend');
      } finally {
        await friend.close();
      }
      await w.click('#s-end');
      await w.click('#end-go');
      await w.waitForSelector('#host-form', { timeout: 60000 });
      step('сессия завершена, мир сохранён');
    });

    await scenario('6. Выбор мира и своя обложка', async () => {
      await nav('worlds');
      await w.selectOption('#w-build', { label: 'Техно — Fabric 1.21.1' });
      await w.waitForSelector('.card:has-text("Наш завод")');
      // игра в мире: журнал клиента сообщает мир и скриншот — обложка ставится сама
      await app.evaluate(() => (process.env.FAKE_SP_LEVEL = 'Наш завод'));
      await w.click('.card:has-text("Наш завод") [data-wplay]');
      await w.waitForSelector('button:has-text("Minecraft запущен")', { timeout: 30000 });
      // строки журнала приходят асинхронно — ждём, а не читаем один раз
      let joined = false;
      for (let i = 0; i < 40 && !joined; i++) {
        joined = /--quickPlaySingleplayer\s+arg:Наш завод/.test((await call('mc:clientLog')).replace(/\n/g, ' '));
        if (!joined) await w.waitForTimeout(100);
      }
      assert.ok(joined, 'вход сразу в выбранный мир');
      await gameClosed();
      await nav('worlds');
      await w.waitForSelector('.card:has-text("Наш завод") .card-cover.has-image', { timeout: 10000 });
      // обложка действительно показывается: картинка по easyimg:// загружается и декодируется
      const sessionCover = (await call('worlds:list', (await call('profiles:overview')).selected)).find((x) => x.name === 'Наш завод').cover;
      const decode = (file) => w.evaluate(async (f) => {
        const i = new Image();
        i.src = 'easyimg://img/?f=' + encodeURIComponent(f);
        try {
          await i.decode();
          return i.naturalWidth;
        } catch {
          return 0;
        }
      }, file);
      assert.equal(await decode(sessionCover.file), 640, 'обложка из скриншота сессии отображается');
      const errCount = errors.length;
      assert.equal(await decode('/etc/hostname'), 0, 'файлы вне папки лаунчера не отдаются');
      await w.waitForTimeout(200);
      errors.splice(errCount); // ожидаемый 404 от этой проверки
      await w.click('.card:has-text("Наш завод") .icon-button[data-world]');
      await w.waitForSelector('#wc-pick');
      assert.match(await text('#dialog-body'), /Последний скриншот, сделанный в этом мире · обновляется сама/);
      // своя картинка (системный диалог выбора файла подменён)
      const png = path.join(shots, '04-game-running.png');
      await app.evaluate(({ dialog }, file) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })), png);
      await w.click('#wc-pick');
      await w.waitForFunction(() => /Выбрана вручную · закреплена/.test(document.querySelector('#dialog-body').textContent));
      await w.waitForTimeout(500);
      await shot('17-world-cover');
      await w.click('#dialog-close');
      // следующая игра в мире не меняет закреплённую обложку
      await w.click('.card:has-text("Наш завод") [data-wplay]');
      await w.waitForSelector('button:has-text("Minecraft запущен")', { timeout: 30000 });
      await gameClosed();
      await app.evaluate(() => delete process.env.FAKE_SP_LEVEL);
      const worlds = await call('worlds:list', (await call('profiles:overview')).selected);
      assert.equal(worlds.find((x) => x.name === 'Наш завод').cover.source, 'manual');
      // фон главного экрана — обложка или скриншот выбранной сборки
      await nav('settings');
      await w.click('[data-bg="profile"]');
      await nav('play');
      await w.waitForSelector('.bg-label');
      await w.waitForTimeout(500);
      step('фон: ' + (await text('.bg-label')));
      assert.match(await text('.bg-label'), /Последний скриншот сборки/);
      await shot('18-home-background');
    });

    await scenario('8б. Помощник без модели: ответ по правилам', async () => {
      await w.click('#assistant-toggle');
      await w.fill('#assistant-input', 'Добавь мод SuperMegaMod9000 и Sodium');
      await w.press('#assistant-input', 'Enter');
      await w.waitForFunction(() => /по правилам/.test(document.querySelector('#assistant-feed').textContent), null, { timeout: 20000 });
      const ans = await text('#assistant-feed');
      assert.ok(/В каталоге нет.*SuperMegaMod9000/.test(ans), 'выдуманный мод назван отсутствующим, а не придуман');
      assert.ok(/Уже в сборке: Sodium/.test(ans), 'уже установленный мод не ставится повторно');
      await shot('19-assistant');
      await w.click('#assistant-close');
      assert.equal((await call('ai:status')).installed, false);
    });

    await scenario('9. Сборка NeoForge: выбор загрузчика и его версии, установка, запуск', async () => {
      await nav('builds');
      await w.click('#new');
      await w.fill('#nb-name', 'Классика');
      await w.click('[data-loader="neoforge"]');
      await w.waitForFunction(() => /рекомендуется/.test(document.querySelector('#nb-lv')?.selectedOptions[0]?.textContent || ''));
      assert.equal(await w.$eval('#nb-lv', (s) => s.value), '21.1.77', 'стабильная версия выбрана, бета — нет');
      await shot('22-new-neoforge');
      await w.click('#nb button[type=submit]');
      await w.waitForSelector('#mod-target');
      await nav('play');
      await w.click('#play');
      await w.waitForSelector('button:has-text("Minecraft запущен")', { timeout: 60000 });
      let ok = false;
      for (let i = 0; i < 40 && !ok; i++) {
        ok = /arg:neoforgeclient/.test(await call('mc:clientLog'));
        if (!ok) await w.waitForTimeout(100);
      }
      assert.ok(ok, 'запущен профиль NeoForge');
      step('NeoForge 21.1.77 установлен установщиком без окна и запущен');
      await gameClosed();
    });

    await nav('builds');
    await shot('20-builds');
    await nav('settings');
    await shot('21-settings');
    assert.deepEqual(errors, [], 'ошибок в интерфейсе нет');
    console.log('\n' + results.join('\n'));
    console.log('UI_E2E_OK ' + shots);
  } catch (e) {
    await shot('zz-failure').catch(() => {});
    console.log('\n' + results.join('\n'));
    console.log('UI_E2E_FAIL', e.stack, errors);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
})();
