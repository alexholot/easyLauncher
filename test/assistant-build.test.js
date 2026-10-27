'use strict';
// Помощник-сборщик: подбор модов по рецептам, выбор версии игры и загрузчика, отсев несовместимого,
// задание «одной кнопкой» (новая сборка, моды, память, графика) и починка вылета.
// Каталог Modrinth — локальная имитация (test/mockapi.js). Настоящий Modrinth проверялся вручную.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const builder = require('../core/ai/builder');
const { ModrinthProvider } = require('../core/catalog/modrinth');
const { planChanges } = require('../core/modplan');
const { emptyLock } = require('../core/store');
const { Services } = require('../core/services');
const { Launcher } = require('../core/launcher');
const { createMock } = require('./mockapi');
const { testLauncher } = require('./helpers');

/** JAR мода Fabric с полями fabric.mod.json (depends, provides, jars) и вложенными JAR. */
function modJar(id, extra = {}, nested = {}) {
  const AdmZip = require('adm-zip');
  const z = new AdmZip();
  z.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', ...extra })));
  z.addFile(`${id}/Main.class`, Buffer.from('cafebabe' + id));
  for (const [name, buf] of Object.entries(nested)) z.addFile(name, buf);
  return z.toBuffer();
}

let mock;
test.before(async () => {
  mock = await createMock();
  const P = (id, slug, title, extra) => mock.addMrProject(id, slug, title, 'required', 'required', extra);
  const V = (id, pid, number, o = {}) => mock.addMrVersion(id, pid, number, { buf: mock.fabricJar(pid.toLowerCase()), ...o });
  // JEI под Fabric только бета — помощник ставит замену той же роли (EMI)
  P('P_JEI', 'jei', 'Just Enough Items');
  V('V_JEI', 'P_JEI', '19.0-beta', { type: 'beta' });
  P('P_EMI', 'emi', 'EMI');
  V('V_EMI', 'P_EMI', '1.1');
  P('P_LITH', 'lithium', 'Lithium');
  V('V_LITH', 'P_LITH', '0.15');
  // у Zombie Awareness обязательная зависимость без релиза под 1.21.1 — мод убирается из подборки
  P('P_ZA', 'zombie-awareness', 'Zombie Awareness');
  V('V_ZA', 'P_ZA', '2.0', { deps: [{ project_id: 'P_ZLIB', dependency_type: 'required' }] });
  P('P_ZLIB', 'zlib', 'Zombie Lib', { game_versions: ['1.20.1'] });
  V('V_ZLIB', 'P_ZLIB', '1.0', { mc: ['1.20.1'] });
  P('P_UN', 'undead-nights', 'Undead Nights');
  V('V_UN', 'P_UN', '1.0');
  // Simply Swords объявил несовместимость с Better Combat — остаётся один (тот, что раньше в подборке)
  P('P_BC', 'better-combat', 'Better Combat');
  V('V_BC', 'P_BC', '2.0');
  P('P_SS', 'simply-swords', 'Simply Swords');
  V('V_SS', 'P_SS', '1.5', { deps: [{ project_id: 'P_BC', dependency_type: 'incompatible' }] });
  // зависимости, о которых каталог не знает: видны только внутри JAR (fabric.mod.json → depends)
  P('P_MOBA', 'mob-a', 'Horde Alpha');
  V('V_MOBA', 'P_MOBA', '1.0', { buf: modJar('moba', { depends: { 'hidden-lib': '*' } }) });
  P('P_HLIB', 'hidden-lib', 'Hidden Lib');
  V('V_HLIB', 'P_HLIB', '1.0', { buf: modJar('hidden-lib') });
  P('P_MOBB', 'mob-b', 'Horde Beta');
  V('V_MOBB', 'P_MOBB', '1.0', { buf: modJar('mobb', { depends: { 'no-such-lib': '*' } }) });
  P('P_MOBC', 'mob-c', 'Horde Gamma');
  V('V_MOBC', 'P_MOBC', '1.0', { buf: modJar('mobc', { depends: { 'hidden-lib': '>=1' } }) });
  // техника — только под NeoForge
  for (const [id, slug, title] of [['P_MEK', 'mekanism', 'Mekanism'], ['P_AE2', 'ae2', 'Applied Energistics 2'], ['P_IA', 'immersive-aircraft', 'Immersive Aircraft']])
    P(id, slug, title, { loaders: ['neoforge'], categories: ['neoforge'], game_versions: ['1.21.1', '1.20.1'] });
});
test.after(() => mock.close());

const intentOf = (o) => ({ intent: 'build', themes: [], avoid: [], searchTerms: [], players: null, lowEnd: false, clarify: null, ...o });

function services() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-asst-'));
  const launcher = testLauncher(Launcher, root, { totalMem: 32 * 1024 ** 3 });
  launcher.cache.allowHosts = [new RegExp('^' + mock.base().replace(/\./g, '\\.') + '/cdn/')];
  const s = new Services(root, { launcher, catalogBase: { modrinth: mock.base() + '/mr', curseforgeBackend: mock.base() } });
  // версии Mojang и загрузчиков — без сети
  s.launcher.versions = async () => [{ id: '1.21.1', type: 'release' }];
  s.loaderSupport = async () => null;
  return s;
}

test('пожелания к сборке: новая ли, версия, загрузчик, размер', () => {
  assert.deepEqual(builder.buildWishes('Сделай новую сборку с зомби на 1.20.1 forge'), { wantsNew: true, minecraft: '1.20.1', loader: 'forge', size: 'normal' });
  const big = builder.buildWishes('хочу большую сборку на неофорже');
  assert.equal(big.wantsNew, true);
  assert.equal(big.loader, 'neoforge');
  assert.equal(big.size, 'big');
  assert.equal(builder.buildWishes('сделай маленькую сборку для ноутбука').size, 'small');
  const add = builder.buildWishes('добавь Create и оптимизацию');
  assert.equal(add.wantsNew, false);
  assert.equal(add.minecraft, null);
  assert.equal(builder.buildWishes('сборка на 26.1').minecraft, '26.1');
  assert.equal(builder.buildName(['zombies', 'weapons']), 'Зомби и оружие');
});

test('подборка: известные моды под версию, замена роли, отсев сломанной зависимости и конфликта', async () => {
  const provider = new ModrinthProvider({ base: mock.base() + '/mr' });
  const target = { minecraft: '1.21.1', loader: 'fabric' };
  const lock = emptyLock('1.21.1', 'fabric');
  const pick = await builder.pickMods({ intent: intentOf({ themes: ['zombies', 'weapons'], searchTerms: ['Create'] }), target, lock, provider, size: 'normal' });
  const names = pick.add.map((a) => a.name);
  assert.ok(names.includes('Create Fabric'), '«Create» нашёлся как порт «Create Fabric»');
  assert.deepEqual(pick.notFound, []);
  for (const n of ['Sodium', 'Lithium', 'Just Enough Items', 'Zombie Awareness', 'Undead Nights', 'Better Combat', 'Simply Swords']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('Mekanism'), 'мод без версии под Fabric не берётся');
  assert.ok(!names.includes('EMI'), 'вторая программа рецептов не ставится сразу');

  const providers = { modrinth: provider };
  const r = await builder.planPruned((request) => planChanges({ lock, request, providers }), pick.add, { waitMs: 0 });
  assert.ok(r.plan.ok, r.plan.errors.map((e) => e.message).join('; '));
  const kept = r.items.map((a) => a.name);
  assert.ok(kept.includes('EMI') && !kept.includes('Just Enough Items'), 'JEI (только бета) заменён на EMI');
  assert.ok(!kept.includes('Zombie Awareness'), 'мод со сломанной зависимостью убран');
  assert.ok(kept.includes('Better Combat') && !kept.includes('Simply Swords'), 'из конфликтующей пары остался один');
  assert.ok(r.dropped.some((d) => d.name === 'Just Enough Items' && d.replacedBy === 'EMI'));
  assert.ok(r.plan.changes.some((c) => c.name === 'Fabric API' && c.dependencyOf === 'Create Fabric'), 'зависимость добавлена сама');
});

test('версия и загрузчик новой сборки: где больше модов темы; NeoForge не берётся для 1.20.1', async () => {
  const provider = new ModrinthProvider({ base: mock.base() + '/mr' });
  const supported = async () => null;
  const tech = intentOf({ themes: ['technology'] });
  const ranked = await builder.rankTargets({ intent: tech, wishes: {}, provider, versions: ['1.21.1', '1.20.1'], supported });
  assert.deepEqual(ranked[0], { minecraft: '1.21.1', loader: 'neoforge' }, 'техника есть только под NeoForge');
  // для 1.20.1 моды выпускают под Forge — NeoForge там не предлагаем, если игрок сам не просил
  assert.deepEqual(await builder.rankTargets({ intent: tech, wishes: {}, provider, versions: ['1.20.1'], supported }), []);
  assert.deepEqual((await builder.rankTargets({ intent: tech, wishes: { loader: 'neoforge' }, provider, versions: ['1.20.1'], supported }))[0], { minecraft: '1.20.1', loader: 'neoforge' });
  // загрузчик не поддерживает версию — пара не предлагается
  const none = await builder.rankTargets({ intent: tech, wishes: {}, provider, versions: ['1.21.1'], supported: async () => new Set(['1.19.2']) });
  assert.deepEqual(none, []);
});

test('память и графика под ПК и размер сборки', () => {
  assert.deepEqual(builder.gameSetup({ totalGb: 32, reserveGb: 6, mods: 10 }), { ram: 3, options: { render: 12, simulation: 10, fps: 120, graphics: 1 } });
  assert.equal(builder.gameSetup({ totalGb: 8, reserveGb: 2, mods: 70 }).ram, 6);
  assert.equal(builder.gameSetup({ totalGb: 8, reserveGb: 2, mods: 70 }).options.render, 8);
  assert.equal(builder.gameSetup({ totalGb: 4, reserveGb: 2, mods: 40 }).ram, 2, 'не больше, чем есть свободной памяти');
  assert.deepEqual(builder.gameSetup({ totalGb: 16, reserveGb: 3, mods: 5, lowEnd: true }).options, { render: 6, simulation: 5, fps: 60, graphics: 0 });
  // «подними FPS» на мощном ПК: графика не повышается, а снижается
  assert.deepEqual(builder.gameSetup({ totalGb: 32, reserveGb: 6, mods: 10, fps: true }).options, { render: 8, simulation: 6, fps: 120, graphics: 0 });
});

test('новая сборка одной кнопкой: ничего не меняется до «Создать», затем сборка, моды, память, графика', async () => {
  const s = services();
  const first = await s.ensureFirstProfile('1.21.1');
  // сначала уточняющие вопросы; ответы по умолчанию — из текста запроса
  const q = await s.ask('сделай большую сборку с зомби и оружием на фабрике', first.id);
  assert.equal(q.kind, 'clarify');
  const pickedOf = (id) => q.questions.find((x) => x.id === id).options.find((o) => o.selected).value;
  assert.deepEqual(['size', 'version', 'loader', 'perf', 'qol', 'visuals', 'setup'].map(pickedOf), ['big', 'auto', 'fabric', true, true, false, true]);
  // без оптимизации, удобств и настройки ПК — их и нет в задании
  const bare = await s.ask('сделай сборку с зомби и оружием', first.id, { perf: false, qol: false, setup: false });
  assert.ok(!bare.groups.some((g) => g.title === 'Оптимизация' || g.title === 'Удобства'));
  assert.ok(!bare.task.steps.some((x) => /памяти|графику/.test(x)));
  const r = await s.ask('сделай сборку с зомби и оружием', first.id, { size: 'normal', version: 'auto', loader: 'auto', perf: true, qol: true, setup: true });
  assert.equal(r.kind, 'build');
  assert.ok(!q.questions.some((x) => x.id === 'where'), 'в сборке без модов спрашивать «куда» незачем');
  assert.deepEqual([r.build.minecraft, r.build.loader], ['1.21.1', 'fabric']);
  assert.match(r.task.steps[0], /Создать сборку «Зомби и оружие»: Minecraft 1\.21\.1, Fabric/);
  assert.ok(r.task.steps.some((x) => /Выделить игре \d ГБ памяти/.test(x)));
  assert.ok(r.groups.some((g) => g.title === 'Зомби' && g.names.includes('Undead Nights')));
  assert.equal((await s.store.listProfiles()).length, 1, 'до подтверждения сборка не создана');

  const res = await s.runTask(r.task.id);
  assert.equal(res.created, true);
  const p = await s.store.getProfile(res.profileId);
  assert.equal(p.name, 'Зомби и оружие');
  assert.equal(p.loader, 'fabric');
  assert.ok(p.ram >= 2);
  const lock = await s.store.getLock(p.id);
  assert.equal(lock.mods.length, r.build.mods + r.build.deps);
  assert.ok(lock.mods.some((m) => m.name === 'Undead Nights') && lock.mods.some((m) => m.name === 'EMI'));
  assert.ok(fs.existsSync(path.join(s.store.gameDir(p.id), 'mods')), 'файлы модов в папке сборки');
  const st = await s.settings();
  assert.equal(st.lastProfile, p.id, 'новая сборка выбрана');
  assert.ok(st.options && st.options.render >= 6, 'графика настроена (раньше игрок её не задавал)');
  await assert.rejects(s.runTask(r.task.id), /устарело/, 'задание выполняется один раз');
  await s.shutdown();
});

test('сборка с загрузчиком выбрана: помощник спрашивает, куда ставить моды — в неё или в новую', async () => {
  const s = services();
  const p = await s.createProfile({ name: 'fabric 26.3', minecraft: '1.21.1', loader: 'fabric' });
  const q = await s.ask('сделай сборку с зомби и оружием', p.id);
  assert.equal(q.kind, 'clarify');
  const where = q.questions.find((x) => x.id === 'where');
  assert.equal(where.options.find((o) => o.selected).value, 'current', 'по умолчанию — в выбранную сборку');
  assert.match(where.options[0].label, /fabric 26\.3/);
  assert.deepEqual(q.questions.filter((x) => x.only === 'new').map((x) => x.id), ['size', 'version', 'loader', 'qol', 'visuals'], 'версия и загрузчик — только для новой сборки');
  // «новую» в тексте — по умолчанию новая
  const q2 = await s.ask('сделай новую сборку с зомби', p.id);
  assert.equal(q2.questions.find((x) => x.id === 'where').options.find((o) => o.selected).value, 'new');
  // ответ «в текущую» — моды подбираются под её версию и загрузчик, новая сборка не создаётся
  const r = await s.ask('сделай сборку с зомби и оружием', p.id, { where: 'current', amount: 'few', perf: false, setup: true });
  assert.equal(r.kind, 'plan');
  assert.ok(r.task.steps.some((x) => /Undead Nights/.test(x)));
  assert.ok(!r.task.steps.some((x) => /Создать сборку/.test(x)));
  await s.shutdown();
});

test('связи модов по файлам: mods.toml, вложенные JAR, provides', () => {
  const { checkLinks, parseModsToml } = require('../core/modlinks');
  const toml = parseModsToml(`modLoader="javafml"
[[mods]] #главный мод
modId="zombieawareness"
[[dependencies.zombieawareness]]
    modId="coroutil"
    mandatory=true
    side="BOTH"
[[dependencies.zombieawareness]]
    modId="jei"
    mandatory=false
[[dependencies.zombieawareness]]
    modId="servertools"
    type="required"
    side="SERVER"
[[dependencies.zombieawareness]]
    modId="badmod"
    type="incompatible"`);
  assert.deepEqual(toml, { ids: ['zombieawareness'], requires: ['coroutil'], breaks: ['badmod'] }, 'необязательные и серверные зависимости клиенту не нужны');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-links-'));
  const put = (name, buf) => (fs.writeFileSync(path.join(dir, name), buf), { name, file: path.join(dir, name) });
  const needs = put('a.jar', modJar('a', { depends: { minecraft: '*', fabricloader: '*', libx: '*', liby: '*' } }));
  // libx лежит внутри другого мода (jar-in-jar), liby объявлен через provides
  const bundle = put('b.jar', modJar('b', { jars: [{ file: 'META-INF/jars/libx.jar' }], provides: ['liby'] }, { 'META-INF/jars/libx.jar': modJar('libx') }));
  assert.deepEqual(checkLinks([needs, bundle]).missing, [], 'встроенная библиотека и provides удовлетворяют зависимость');
  assert.deepEqual(checkLinks([needs]).missing.map((m) => [m.id, m.by[0].name]), [['libx', 'a.jar'], ['liby', 'a.jar']]);
  // один JAR для Fabric и Forge (как Towns and Towers): в Forge-сборке требования fabric.mod.json не действуют
  const AdmZip = require('adm-zip');
  const z = new AdmZip(modJar('multi', { depends: { 'fabric-api': '*' } }));
  z.addFile('META-INF/mods.toml', Buffer.from('[[mods]]\nmodId="multi"\n[[dependencies.multi]]\nmodId="cristellib"\nmandatory=true\n'));
  const multi = put('multi.jar', z.toBuffer());
  assert.deepEqual(checkLinks([multi], 'forge').missing.map((m) => m.id), ['cristellib']);
  assert.deepEqual(checkLinks([multi], 'fabric').missing.map((m) => m.id), ['fabric-api']);
  assert.deepEqual(checkLinks([needs], 'forge').missing, [], 'чистый Fabric-мод в Forge-сборке — требования не читаются');
  // свой файл игрока: даёт зависимость, но его собственные требования не проверяются
  const own = { ...put('own.jar', modJar('own', { provides: ['libx', 'liby'], depends: { nothing: '*' } })), providerOnly: true };
  assert.deepEqual(checkLinks([needs, own]).missing, []);
});

test('задание помощника: скрытая зависимость добавляется, мод без библиотеки убирается; проверка перед «Играть»', async () => {
  const s = services();
  const p = await s.createProfile({ name: 'Связи', minecraft: '1.21.1', loader: 'fabric' });
  // каталог не знает, что Horde Alpha нужен Hidden Lib: это видно только в его файле
  const a = await s.ask('добавь Horde Alpha и Horde Beta', p.id);
  assert.deepEqual(a.task.steps, ['Добавить Horde Alpha', 'Добавить Horde Beta']);
  const res = await s.runTask(a.task.id);
  assert.deepEqual(res.linksAdded, ['Hidden Lib']);
  assert.deepEqual(res.linksRemoved, ['Horde Beta'], 'для Horde Beta библиотеки нет нигде — мод не ставится, игра не вылетит');
  const names = (await s.store.getLock(p.id)).mods.map((m) => m.name).sort();
  assert.deepEqual(names, ['Hidden Lib', 'Horde Alpha']);

  // мод поставлен вручную через каталог: установка проходит, но лаунчер сразу говорит о проблеме
  const q = await s.createProfile({ name: 'Вручную', minecraft: '1.21.1', loader: 'fabric' });
  const inst = await s.install(q.id, { source: 'modrinth', projectId: 'P_MOBC' });
  assert.equal(inst.applied, true);
  assert.deepEqual(inst.missing.map((m) => m.id), ['hidden-lib']);
  // «Играть» не запускает заведомо вылетающую сборку, а предлагает исправление
  const err = await s.play({ profileId: q.id }, null).catch((e) => e);
  assert.equal(err.code, 'MISSING_DEPS');
  assert.match(err.message, /«Horde Gamma» требует «hidden-lib»/);
  assert.deepEqual(err.task.steps, ['Добавить Hidden Lib']);
  await s.runTask(err.task.id);
  assert.deepEqual((await s.linkReport(q.id)).missing, []);
  await s.shutdown();
});

test('расширенные настройки: окно игры, аргументы и путь Java, очистка кэша не трогает нужное', async () => {
  const s = services();
  // окно и аргументы Java проверяются в ядре: из окна интерфейса может прийти что угодно
  assert.deepEqual((await s.saveSettings({ window: { width: 1600, height: 900 } })).window, { width: 1600, height: 900, fullscreen: false });
  assert.equal((await s.saveSettings({ jvmArgs: '-XX:+UseZGC -Dfoo=bar' })).jvmArgs, '-XX:+UseZGC -Dfoo=bar');
  await assert.rejects(s.saveSettings({ jvmArgs: '-Xmx16G' }), /Память задаётся/);
  await assert.rejects(s.saveSettings({ jvmArgs: '-XX:+A && calc.exe' }), /спецсимвол/);
  await assert.rejects(s.saveSettings({ javaPath: 'C:\\Windows\\notepad.exe' }), /java\.exe/);
  await assert.rejects(s.saveSettings({ afterLaunch: 'explode' }), /Неизвестное/);
  assert.equal((await s.saveSettings({ afterLaunch: 'hide', showNews: false })).afterLaunch, 'hide');
  // размер окна попадает в аргументы игры (has_custom_resolution), как в лаунчере Mojang
  const { buildClientArgs } = require('../core/mojang');
  const version = { id: '1.21.1', mainClass: 'Main', arguments: { game: [{ rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] }], jvm: [] } };
  const args = buildClientArgs(version, { gameDir: 'g', assetsDir: 'a', classpath: [], nativesDir: 'n', librariesDir: 'l', username: 'Player', ram: 4, window: { width: 1600, height: 900 }, extraJvm: ['-XX:+UseZGC'] });
  assert.deepEqual(args.slice(-4), ['--width', '1600', '--height', '900']);
  assert.ok(args.includes('-XX:+UseZGC'));
  assert.ok(!buildClientArgs(version, { gameDir: 'g', assetsDir: 'a', classpath: [], nativesDir: 'n', librariesDir: 'l', username: 'Player', ram: 4 }).includes('--width'));

  // очистка кэша: файл установленного мода и файл прежнего состава (для отката) остаются
  const p = await s.createProfile({ name: 'Кэш', minecraft: '1.21.1', loader: 'fabric' });
  await s.install(p.id, { source: 'modrinth', projectId: 'P_LITH' });
  await s.install(p.id, { source: 'modrinth', projectId: 'P_UN' });
  await s.applyPlan((await s.planMods(p.id, { remove: ['modrinth:P_UN'] })).planId);
  const stray = path.join(s.launcher.cache.dir, 'ab', 'ab'.padEnd(40, '0') + '.jar');
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.writeFileSync(stray, 'никому не нужен');
  const r = await s.cleanModCache();
  assert.ok(r.freed > 0 && !fs.existsSync(stray), 'ненужный файл удалён');
  const lock = await s.store.getLock(p.id);
  assert.ok(s.launcher.cache.has(lock.mods[0].file), 'файл мода сборки на месте');
  await s.rollbackMods(p.id);
  assert.ok((await s.store.getLock(p.id)).mods.some((m) => m.name === 'Undead Nights'), 'откат работает: файл прежнего состава не удалён');
  await s.shutdown();
});

test('добавить мод к сборке и починить вылеты: зависимость, память, сбой Mixin', async () => {
  const s = services();
  const p = await s.createProfile({ name: 'Моды', minecraft: '1.21.1', loader: 'fabric' });
  // «добавь Sodium» — к текущей сборке, одной кнопкой
  const add = await s.ask('добавь Sodium', p.id);
  assert.equal(add.kind, 'plan');
  assert.ok(add.task.steps.includes('Добавить Sodium'));
  await s.runTask(add.task.id);
  assert.ok((await s.store.getLock(p.id)).mods.some((m) => m.slug === 'sodium'));

  // в журнале — нет Fabric API: помощник сам находит его в каталоге
  const dep = await s.ask("Mod 'Create Fabric' (create) 6.0.0 requires any version of 'Fabric API' (fabric-api), which is missing!", p.id);
  assert.equal(dep.kind, 'diagnose');
  assert.deepEqual(dep.task.steps, ['Добавить Fabric API']);
  await s.runTask(dep.task.id);
  assert.ok((await s.store.getLock(p.id)).mods.some((m) => m.slug === 'fabric-api'));

  // не хватило памяти — больше памяти этой сборке
  const oom = await s.ask('java.lang.OutOfMemoryError: Java heap space', p.id);
  const ram = Number(oom.task.steps[0].match(/(\d+) ГБ/)[1]);
  await s.runTask(oom.task.id);
  assert.equal((await s.store.getProfile(p.id)).ram, ram);

  // мод не встроился, а обновления нет — убрать его (с копией миров)
  const mixin = await s.ask('Mixin apply for mod sodium failed sodium.mixins.json', p.id);
  assert.deepEqual(mixin.task.steps, ['Убрать Sodium']);
  assert.equal(mixin.task.significant, true);
  await s.runTask(mixin.task.id);
  assert.ok(!(await s.store.getLock(p.id)).mods.some((m) => m.slug === 'sodium'));

  // ошибка драйвера — исправить автоматически нечего, кнопки нет
  const gl = await s.ask('GLFW error 65542: WGL: The driver does not appear to support OpenGL', p.id);
  assert.equal(gl.kind, 'diagnose');
  assert.equal(gl.task, null);
  await s.shutdown();
});
