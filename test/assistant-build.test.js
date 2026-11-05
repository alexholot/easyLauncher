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
const { diagnose } = require('../core/ai/diagnose');
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
  // как Iris и Sodium: шейдерам нужна старая ветка 0.6.x, а каталог по умолчанию даёт новейшую 0.8.13,
  // которая к тому же объявляет шейдеры до 1.8.13 несовместимыми
  P('P_SHD', 'lumen-core', 'Lumen Core');
  V('V_SHD', 'P_SHD', '1.8.8+1.21.1', { buf: modJar('shadersx', { version: '1.8.8+mc1.21.1', depends: { speedy: '0.6.x' } }), deps: [{ project_id: 'P_SPD', dependency_type: 'required' }] });
  mock.addMrProject('P_SPD', 'speedy', 'Speedy', 'required', 'unsupported');
  V('V_SPD8', 'P_SPD', 'mc1.21.1-0.8.13-fabric', { buf: modJar('speedy', { version: '0.8.13+mc1.21.1', breaks: { shadersx: '<1.8.13' } }) });
  V('V_SPD6', 'P_SPD', 'mc1.21.1-0.6.13-fabric', { buf: modJar('speedy', { version: '0.6.13+mc1.21.1', breaks: { shadersx: '<1.8.0' } }), published: '2026-01-01T00:00:00Z' });
  // как Structure Pool API: библиотека помечена «только сервер», но мод генерации мира без неё не запустится
  P('P_LNE', 'loot-explore', 'Loot Explore');
  V('V_LNE', 'P_LNE', '1.0.24', { buf: modJar('lootx', { depends: { pool_api: '>=1.2.1+1.21.1' } }) });
  mock.addMrProject('P_POOL', 'pool-api', 'Pool API', 'unsupported', 'required');
  V('V_POOL', 'P_POOL', '1.2.1+1.21.1', { buf: modJar('pool_api', { version: '1.2.1+1.21.1' }), env: 'server_only' });
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

test('варианты сборки: одинаковый код воспроизводится, другой меняет игровой состав', async () => {
  const mk = (slug, i = 0) => ({ key: 'modrinth:' + slug, id: slug, slug, name: slug.replace(/-/g, ' '), categories: ['fabric'], gameVersions: ['1.21.1'], loaders: ['fabric'], downloads: 5000 + i * 1000, updated: '2026-09-01T00:00:00Z', side: { client: 'required' } });
  const known = new Map(Object.values(builder.RECIPES).flat(2).map((slug, i) => [slug, mk(slug, i)]));
  const provider = {
    projects: async (slugs) => slugs.map((x) => known.get(x)).filter(Boolean),
    search: async ({ query = '', category = '' }) => ({ hits: Array.from({ length: 12 }, (_, i) => mk(`${(query || category || 'role').replace(/\W+/g, '-')}-${i}`, i)) }),
  };
  const target = { minecraft: '1.21.1', loader: 'fabric' };
  const lock = emptyLock('1.21.1', 'fabric');
  const intent = intentOf({ themes: ['zombies', 'survival'], archetype: 'night_horror', constraints: [], intensity: 'hard', pacing: 'slow' });
  const make = (variantId) => builder.pickMods({ intent, target, lock, provider, size: 'normal', roles: [], variantId });
  const a1 = await make('AAAA1111');
  const a2 = await make('AAAA1111');
  const b = await make('BBBB2222');
  const slugs = (x) => x.add.filter((m) => !m.reason.startsWith('base:')).map((m) => m.slug);
  assert.deepEqual(slugs(a1), slugs(a2), 'код варианта полностью воспроизводит выбор');
  assert.notDeepEqual(slugs(a1), slugs(b), 'другой код меняет игровые моды');
  assert.equal(a1.concept.id, 'night_horror');
  assert.ok(a1.themes.includes('horror'), 'концепция добавляет нужную игровую роль');
  assert.ok(a1.add.some((m) => m.reason === 'role:atmosphere'), 'мод выбран для роли атмосферы, а не только по популярности');
  const one = new Set(slugs(a1));
  const two = new Set(slugs(b));
  const overlap = [...one].filter((x) => two.has(x)).length / new Set([...one, ...two]).size;
  assert.ok(overlap <= 0.75, `игровые варианты слишком похожи: ${overlap}`);
  const many = await Promise.all(Array.from({ length: 24 }, (_, i) => make('VARIANT-' + i)));
  assert.ok(many.every((x) => x.add.length <= builder.SIZES.normal.limit), 'каждый вариант соблюдает размер');
  assert.ok(many.every((x) => new Set(x.add.map((m) => m.slug || m.id)).size === x.add.length), 'в вариантах нет дублей');
  assert.ok(new Set(many.map((x) => slugs(x).join('|'))).size >= 12, '24 генерации дают достаточно разных составов');
  const candidate = mk('recent-mod', 10);
  assert.ok(builder.candidateScore(candidate, 0, new Set(['recent-mod'])) < builder.candidateScore(candidate, 0, new Set()), 'недавний повтор получает штраф');
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
  assert.deepEqual(['size', 'version', 'loader', 'style', 'perf', 'qol', 'visuals', 'setup'].map(pickedOf), ['big', 'auto', 'fabric', 'surprise', true, true, false, true]);
  s.loaderSupport = async (loader) => (loader === 'forge' ? ['1.7.10', '1.20.1'] : loader === 'quilt' ? ['1.20.1'] : ['1.21.1', '1.20.1']);
  const impossible = await s.ask('сделай сборку на 1.7.10 quilt', first.id, { size: 'normal', version: '1.7.10', loader: 'quilt' });
  assert.equal(impossible.kind, 'message');
  assert.match(impossible.message, /Quilt не выпускался для Minecraft 1\.7\.10/);
  s.loaderSupport = async () => null;
  // без оптимизации, удобств и настройки ПК — их и нет в задании
  const bare = await s.ask('сделай сборку с зомби и оружием', first.id, { perf: false, qol: false, setup: false });
  assert.ok(!bare.groups.some((g) => g.title === 'Оптимизация' || g.title === 'Удобства'));
  assert.ok(!bare.task.steps.some((x) => /памяти|графику/.test(x)));
  const r = await s.ask('сделай сборку с зомби и оружием', first.id, { size: 'normal', version: 'auto', loader: 'auto', perf: true, qol: true, setup: true });
  assert.equal(r.kind, 'build');
  assert.ok(!q.questions.some((x) => x.id === 'where'), 'в сборке без модов спрашивать «куда» незачем');
  assert.deepEqual([r.build.minecraft, r.build.loader], ['1.21.1', 'fabric']);
  assert.match(r.task.steps[0], /Создать сборку «.+»: Minecraft 1\.21\.1, Fabric/);
  assert.match(r.build.variantId, /^[A-F0-9]{8}$/);
  assert.equal(r.concept.variantId, r.build.variantId);
  assert.ok(r.task.steps.some((x) => /Выделить игре \d ГБ памяти/.test(x)));
  assert.ok(r.groups.some((g) => g.title === 'Зомби' && g.names.length), 'есть моды основной темы');
  assert.equal((await s.store.listProfiles()).length, 1, 'до подтверждения сборка не создана');

  const res = await s.runTask(r.task.id);
  assert.equal(res.created, true);
  const p = await s.store.getProfile(res.profileId);
  assert.equal(p.name, r.build.name);
  assert.equal(p.loader, 'fabric');
  assert.ok(p.ram >= 2);
  const lock = await s.store.getLock(p.id);
  assert.equal(lock.mods.length, r.build.mods + r.build.deps);
  assert.ok(lock.mods.some((m) => m.name === 'EMI'));
  assert.ok(lock.mods.some((m) => r.groups.find((g) => g.title === 'Зомби')?.names.includes(m.name)), 'игровой мод темы установлен');
  assert.ok(fs.existsSync(path.join(s.store.gameDir(p.id), 'mods')), 'файлы модов в папке сборки');
  const st = await s.settings();
  assert.equal(st.lastProfile, p.id, 'новая сборка выбрана');
  assert.ok(st.options && st.options.render >= 6, 'графика настроена (раньше игрок её не задавал)');
  const history = JSON.parse(fs.readFileSync(path.join(s.root, 'ai', 'variants.json'), 'utf8'));
  assert.equal(history.at(-1).variantId, r.build.variantId, 'применённый вариант записан в локальную историю');
  await assert.rejects(s.runTask(r.task.id), /устарело/, 'задание выполняется один раз');
  await s.shutdown();
});

test('другой вариант строится в ядре по id задания и не меняет сборки до подтверждения', async () => {
  const s = services();
  const first = await s.ensureFirstProfile('1.21.1');
  const answers = { size: 'normal', version: 'auto', loader: 'auto', style: 'surprise', perf: false, qol: false, setup: false };
  const one = await s.ask('сделай сборку с зомби и оружием', first.id, answers);
  const two = await s.rerollTask(one.task.id);
  assert.equal(two.kind, 'build');
  assert.notEqual(two.task.id, one.task.id);
  assert.notEqual(two.build.variantId, one.build.variantId);
  assert.equal((await s.store.listProfiles()).length, 1, 'новый вариант ничего не создаёт сам');
  await assert.rejects(s.runTask(one.task.id), /устарело/, 'старый вариант после замены нельзя применить');
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
  assert.deepEqual(q.questions.filter((x) => x.only === 'new').map((x) => x.id), ['size', 'version', 'loader', 'style', 'qol', 'visuals'], 'версия, стиль и загрузчик — только для новой сборки');
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

test('версии модов по файлам: диапазоны Fabric, не та версия, несовместимость с версиями', () => {
  const { satisfies, checkLinks } = require('../core/modlinks');
  assert.ok(satisfies(['0.6.x'], '0.6.13+mc1.21.1'));
  assert.ok(!satisfies(['0.6.x'], '0.8.13+mc1.21.1'));
  assert.ok(satisfies('>=1.2.1+1.21.1', '1.2.1+1.21.1'), 'метка сборки после + не сравнивается');
  assert.ok(!satisfies('>=15.0.140', '15.0.127'));
  assert.ok(satisfies('<1.8.13', '1.8.8+mc1.21.1'));
  assert.ok(!satisfies('<1.8.13', '1.8.13'));
  assert.ok(satisfies('>=1.0 <2.0', '1.5') && !satisfies('>=1.0 <2.0', '2.0'));
  assert.ok(satisfies('~1.2.0', '1.2.9') && !satisfies('~1.2.0', '1.3.0'));
  assert.ok(satisfies('^2.1', '2.9') && !satisfies('^2.1', '3.0'));
  assert.ok(satisfies('[0.6-,0.7-)', '0.6.13') && !satisfies('[0.6-,0.7-)', '0.7.0'));
  assert.ok(!satisfies('>=1.0', '1.0-beta.1'), 'тестовая версия младше релиза');
  assert.ok(satisfies('>=2.0', '${version}'), 'непонятную версию честно сравнить нельзя — не мешаем');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-vers-'));
  const put = (name, buf, o = {}) => (fs.writeFileSync(path.join(dir, name), buf), { name, key: 'modrinth:' + name, file: path.join(dir, name), ...o });
  const shaders = put('shaders', modJar('shadersx', { version: '1.8.8', depends: { speedy: '0.6.x' } }));
  const speedy = put('speedy', modJar('speedy', { version: '0.8.13', breaks: { shadersx: '<1.8.13' } }));
  const r = checkLinks([shaders, speedy], 'fabric');
  assert.deepEqual(r.wrong.map((w) => [w.id, w.have, w.provider.name, w.by[0].name]), [['speedy', '0.8.13', 'speedy', 'shaders']]);
  assert.deepEqual(r.conflicts.map((c) => [c.a, c.b]), [['speedy', 'shaders']]);
  assert.deepEqual(checkLinks([shaders, put('speedy6', modJar('speedy', { version: '0.6.13', breaks: { shadersx: '<1.8.0' } }))], 'fabric'), { missing: [], conflicts: [], wrong: [] });
  // библиотека есть, но только для выделенного сервера — в игре её нет
  const lootx = put('lootx', modJar('lootx', { depends: { pool_api: '*' } }));
  assert.deepEqual(checkLinks([lootx, put('pool', modJar('pool_api'), { offGame: true })], 'fabric').missing.map((m) => m.id), ['pool_api']);
  // из двух копий библиотеки (отдельной и вложенной) Fabric берёт новую
  const cloth = (v) => modJar('cloth', { version: v });
  const yung = put('yung', modJar('yung', { depends: { cloth: '>=15.0.140' } }));
  const apple = put('apple', modJar('apple', { jars: [{ file: 'META-INF/jars/cloth.jar' }] }, { 'META-INF/jars/cloth.jar': cloth('15.0.127') }));
  assert.deepEqual(checkLinks([yung, apple, put('cloth', cloth('15.0.140'))], 'fabric').wrong, []);
  const old = checkLinks([yung, apple], 'fabric').wrong;
  assert.deepEqual(old.map((w) => [w.id, w.nested, w.have]), [['cloth', true, '15.0.127']], 'подходящей копии нет: нужна отдельная библиотека');

  // Как Breaking Place для Forge 1.17.1: релиз числится совместимым в каталоге, но внутри требует Java 17.
  const badMixin = put('breaking-place.jar', modJar('breakingplace', {}, { 'breakingplace201forge.mixins.json': Buffer.from(JSON.stringify({ compatibilityLevel: 'JAVA_17' })) }));
  const java = checkLinks([badMixin], 'forge', '1.17.1');
  assert.deepEqual(java.java.map((x) => [x.name, x.need, x.have, x.config]), [['breaking-place.jar', 17, 16, 'breakingplace201forge.mixins.json']]);
  assert.equal(Services.linkProblems(java), true);
  assert.match(Services.linkText(java), /«breaking-place\.jar» требует Java 17, а Minecraft этой версии работает на Java 16/);
  // свой JAR игрока лаунчер убрать не может — запуск из-за него не блокируется
  assert.deepEqual(checkLinks([{ ...badMixin, providerOnly: true }], 'forge', '1.17.1').java, []);
});

test('моды только для сервера ставятся в одиночную игру, кроме модов только для выделенного сервера', () => {
  const { inGame, onClient } = require('../core/lock');
  const worldgen = { side: { client: 'unsupported', server: 'required' } };
  assert.equal(onClient(worldgen), false, 'гостю на чужом сервере не нужен');
  assert.equal(inGame(worldgen), true, 'одиночная игра идёт на встроенном сервере — структурам он нужен');
  assert.equal(inGame({ side: { client: 'unsupported', server: 'required', dedicated: true } }), false);
  assert.equal(inGame({ side: { client: 'required', server: 'unsupported' } }), true);
  const { sideOf } = require('../core/catalog/modrinth');
  assert.deepEqual(sideOf('dedicated_server_only'), { client: 'unsupported', server: 'required', dedicated: true });
  assert.deepEqual(sideOf('server_only'), { client: 'unsupported', server: 'required' });
});

test('разбор вылета Fabric «Incompatible mods found»: имена модов, версии, а не слово «version»', () => {
  const log = `[05:53:45] [main/ERROR]: Incompatible mods found!
net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!
	 - Install structure_pool_api, version 1.2.1+1.21.1 or later.
	 - Mod 'Iris' (iris) 1.8.8+mc1.21.1 requires any 0.6.x version of mod 'Sodium' (sodium), but only the wrong version is present: 0.8.13+mc1.21.1!
	 - Mod 'Loot & Explore' (loot_n_explore) 1.0.24-1.21.1 requires version 1.2.1+1.21.1 or later of structure_pool_api, which is missing!
	 - Mod 'Sodium' (sodium) 0.8.13+mc1.21.1 is incompatible with any version before 1.8.13 of mod 'Iris' (iris), yet a conflicting version is present: 1.8.8+mc1.21.1!`;
  const f = diagnose(log);
  const by = (id) => f.filter((x) => x.id === id);
  assert.deepEqual(by('missing-dep-fabric').map((x) => x.data.depId), ['structure_pool_api']);
  assert.match(by('missing-dep-fabric')[0].fix, /«Loot & Explore» требует «structure_pool_api» \(1\.2\.1\+1\.21\.1 или новее\)/);
  assert.deepEqual(by('wrong-dep-version').map((x) => [x.data.depId, x.data.have]), [['sodium', '0.8.13+mc1.21.1']]);
  assert.match(by('wrong-dep-version')[0].fix, /«Iris» работает только с «Sodium» \(0\.6\.x\)/);
  assert.deepEqual(by('incompatible').map((x) => [x.data.a, x.data.b]), [['Sodium', 'Iris']]);
  assert.equal(by('missing-dep-generic').length, 0, 'раньше отсюда получался мод «version»');
  assert.equal(by('incompatible-generic').length, 0);
  assert.ok(!f.some((x) => /«version»/.test(x.fix)));
});

test('задание помощника: подбирает версию, которую требует другой мод, и ставит «серверную» библиотеку в игру', async () => {
  const s = services();
  const p = await s.createProfile({ name: 'Версии', minecraft: '1.21.1', loader: 'fabric' });
  const a = await s.ask('добавь Lumen Core и Loot Explore', p.id);
  const res = await s.runTask(a.task.id);
  assert.deepEqual(res.linksAdded, ['Pool API']);
  assert.equal(res.linksChanged.length, 1);
  assert.match(res.linksChanged[0], /^Speedy mc1\.21\.1-0\.6\.13-fabric — эту версию требует Lumen Core/);
  const lock = await s.store.getLock(p.id);
  assert.equal(lock.mods.find((m) => m.name === 'Speedy').version, 'mc1.21.1-0.6.13-fabric');
  assert.equal(Services.linkProblems(await s.linkReport(p.id)), false);
  // библиотека «только для сервера» лежит в папке игры — без неё Loot Explore не запустится
  const mods = fs.readdirSync(path.join(s.store.gameDir(p.id), 'mods'));
  assert.ok(mods.includes('P_POOL-1.2.1+1.21.1.jar'), mods.join(', '));

  // готовая сборка с неподходящей версией: «Играть» не запускает её, а предлагает подобрать версию
  const q = await s.createProfile({ name: 'Старая', minecraft: '1.21.1', loader: 'fabric' });
  await s.install(q.id, { source: 'modrinth', projectId: 'P_SHD' });
  const err = await s.play({ profileId: q.id }, null).catch((e) => e);
  assert.equal(err.code, 'MISSING_DEPS');
  assert.match(err.message, /«Lumen Core» требует Speedy 0\.6\.x, а стоит 0\.8\.13/);
  assert.deepEqual(err.task.steps, ['Speedy: версия mc1.21.1-0.8.13-fabric → mc1.21.1-0.6.13-fabric']);
  await s.runTask(err.task.id);
  assert.equal(Services.linkProblems(await s.linkReport(q.id)), false);

  // журнал вместо просьбы — разбор ошибки, а не вопросы о новой сборке
  const d = await s.ask("Mod 'Lumen Core' (shadersx) 1.8.8 requires any 0.6.x version of mod 'Speedy' (speedy), but only the wrong version is present: 0.8.13!", q.id);
  assert.equal(d.kind, 'diagnose');
  await s.shutdown();
});

test('вопросы перед сборкой: Quilt среди загрузчиков, «другая версия» — все релизы до 1.7.10', async () => {
  const s = services();
  s.launcher.versions = async () => ['1.21.4', '1.21.1', '1.20.4', '1.20.1', '1.16.5', '1.12.2', '1.7.10', '1.6.4'].map((id) => ({ id, type: 'release' }));
  const support = {
    fabric: ['1.21.4', '1.21.1', '1.20.4', '1.20.1'],
    quilt: ['1.21.4', '1.21.1', '1.20.1'],
    forge: ['1.21.1', '1.20.1', '1.16.5', '1.12.2', '1.7.10'],
    neoforge: ['1.21.4', '1.21.1', '1.20.1'],
  };
  s.loaderSupport = async (loader) => support[loader];
  const qs = await s.buildQuestions(intentOf({ themes: ['adventure'] }), { size: 'normal' });
  const loader = qs.find((q) => q.id === 'loader');
  assert.deepEqual(loader.options.map((o) => o.value), ['auto', 'fabric', 'quilt', 'forge', 'neoforge']);
  assert.deepEqual(loader.allowedByVersion['1.7.10'], ['forge'], 'для старой версии нельзя выбрать Quilt, Fabric или NeoForge');
  assert.deepEqual(loader.allowedByVersion['1.20.1'], ['fabric', 'quilt', 'forge', 'neoforge']);
  const v = qs.find((q) => q.id === 'version');
  assert.deepEqual(v.options.map((o) => o.value), ['auto', '1.21.4', '1.21.1', '1.20.1']);
  assert.deepEqual(v.more, ['1.20.4', '1.16.5', '1.12.2', '1.7.10']);
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
  await Promise.all([
    s.saveSettings({ nickname: 'ParallelUser' }),
    s.saveSettings({ checkUpdates: false }),
    s.saveSettings({ motion: false }),
  ]);
  const parallel = await s.settings();
  assert.equal(parallel.nickname, 'ParallelUser');
  assert.equal(parallel.checkUpdates, false);
  assert.equal(parallel.motion, false, 'параллельные изменения настроек не теряются');
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
