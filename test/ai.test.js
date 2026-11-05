'use strict';
// Помощник: правила, проверка ответов модели, отсутствие выдумок в плане, выгрузка модели.
// Модель заменена процессом-имитацией llama-server (test/fixtures/fake-llama.js) — это не проверка качества.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Assistant, validateIntent, ruleIntent, proposeMods } = require('../core/ai/assistant');
const { diagnose, sanitize, keyLines, suspects } = require('../core/ai/diagnose');
const { AiManager, processRssMb } = require('../core/ai/manager');
const { planChanges } = require('../core/modplan');
const { ModrinthProvider } = require('../core/catalog/modrinth');
const { createMock } = require('./mockapi');

const FAKE = path.join(__dirname, 'fixtures', 'fake-llama.js');
const fakeModel = path.join(os.tmpdir(), 'fake-model.gguf');
fs.writeFileSync(fakeModel, 'GGUF');
const lock = { format: 'easylauncher.lock/2', minecraft: '1.21.1', loader: 'fabric', mods: [] };

let mock;
test.before(async () => {
  mock = await createMock();
  mock.mr.projects.P_CREATE.title = 'Create';
});
test.after(() => mock.close());

function manager(mode, extra = {}) {
  process.env.FAKE_LLAMA_MODE = mode;
  return new AiManager(fs.mkdtempSync(path.join(os.tmpdir(), 'easy-ai-')), { serverBinary: process.execPath, serverArgs: [FAKE], modelPath: fakeModel, idleMs: 0, ...extra });
}

test('правила понимают русские запросы из сценариев', () => {
  const a = ruleIntent('Собери выживание с Create для четырёх друзей');
  assert.equal(a.intent, 'build');
  assert.deepEqual(a.searchTerms, ['Create']);
  assert.equal(a.players, 4);
  const b = ruleIntent('Добавь приключений, но без сложной техники');
  assert.equal(b.intent, 'add');
  assert.ok(b.themes.includes('adventure'));
  assert.ok(b.avoid.includes('technology') && !b.themes.includes('technology'));
  const c = ruleIntent('У меня слабый ноутбук, помоги с настройками');
  assert.equal(c.intent, 'optimize');
  assert.equal(c.lowEnd, true);
  assert.equal(ruleIntent('После обновления игра перестала запускаться').intent, 'diagnose');
  const z = ruleIntent('Хочу зомби ночью, страшную атмосферу и без огнестрельного оружия');
  assert.equal(z.archetype, 'night_horror');
  assert.ok(z.constraints.includes('no_firearms'));
});

test('строгая проверка ответа модели', () => {
  const ok = { intent: 'add', themes: ['magic'], avoid: [], searchTerms: ['Iris'], players: null, lowEnd: false, clarify: null };
  assert.ok(validateIntent(ok));
  assert.equal(validateIntent({ ...ok, run: 'calc.exe' }), null, 'лишние поля (действия) отклоняются');
  assert.equal(validateIntent({ ...ok, intent: 'shell' }), null);
  assert.equal(validateIntent({ ...ok, themes: ['nuclear'] }), null);
  assert.equal(validateIntent({ ...ok, searchTerms: ['https://x.y/mod.jar'] }), null, 'ссылки не принимаются');
  assert.equal(validateIntent({ ...ok, players: 1000 }), null);
  assert.equal(validateIntent({ ...ok, archetype: 'execute_shell' }), null);
  assert.equal(validateIntent({ ...ok, constraints: ['download_any_url'] }), null);
  assert.equal(validateIntent('строка'), null);
});

test('модель понимает запрос, план строит код, выдуманный мод в план не попадает', async () => {
  const mr = new ModrinthProvider({ base: mock.base() + '/mr' });
  const search = async (q) => (await mr.search({ query: q, minecraft: '1.21.1', loader: 'fabric' })).hits;
  const ai = manager('good');
  const asst = new Assistant({ llm: ai });
  const u = await asst.understand('Собери выживание с Create для четырёх друзей');
  assert.equal(u.by, 'model');
  const prop = await proposeMods(u.intent, { search, lock });
  assert.ok(prop.add.some((p) => p.name === 'Create'));
  const plan = await planChanges({ lock, providers: { modrinth: mr }, request: { add: prop.add.map((p) => ({ source: p.source, projectId: p.id })) } });
  assert.ok(plan.changes.every((c) => c.key.startsWith('modrinth:')), 'в плане только проекты из каталога');
  const ex = await asst.explain(plan);
  assert.equal(ex.by, 'model');
  await ai.stop();

  const hall = manager('hallucinate');
  const u2 = await new Assistant({ llm: hall }).understand('добавь SuperMegaMod9000');
  const prop2 = await proposeMods(u2.intent, { search, lock });
  assert.deepEqual(prop2.add, []);
  assert.deepEqual(prop2.notFound, ['SuperMegaMod9000'], 'пользователю честно сообщается, что такого мода нет');
  await hall.stop();
});

test('некорректный ответ, попытка инъекции и ссылка — отклоняются', async () => {
  for (const mode of ['garbage', 'inject', 'badurl']) {
    const ai = manager(mode);
    const r = await new Assistant({ llm: ai }).understand('Собери техно-сборку');
    assert.equal(r.by, 'rules', mode + ': ответ модели отброшен, работают правила');
    assert.ok(r.rejected);
    await ai.stop();
  }
  const ai = manager('othermod');
  const plan = { changes: [{ type: 'add', name: 'Create', to: '6' }], warnings: [] };
  const ex = await new Assistant({ llm: ai }).explain(plan, { otherNames: ['Sodium', 'Create'] });
  assert.equal(ex.by, 'template', 'упоминание мода не из плана — пояснение отброшено');
  await ai.stop();
});

test('диагностика: правила, вычистка личных данных, честное «мало данных»', async () => {
  const f = diagnose('java.lang.UnsupportedClassVersionError: x has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0');
  assert.equal(f[0].id, 'java-version');
  assert.match(f[0].fix, /Java 21.*Java 17/);
  const dep = diagnose("Mod 'Create' (create) 6.0.0 requires any version of 'Fabric API' (fabric-api), which is missing!");
  assert.ok(dep.some((x) => x.id === 'missing-dep-fabric' && /Fabric API/.test(x.fix)));
  const mixin = diagnose('Compatibility level JAVA_17 specified by breakingplace201forge.mixins.json is higher than the maximum level supported by this version of mixin (JAVA_13).');
  assert.equal(mixin[0].id, 'mixin-java');
  assert.deepEqual(mixin[0].data, { mixinConfig: 'breakingplace201forge.mixins.json', requiredJava: 17 });
  assert.match(mixin[0].fix, /Java 17.*только 13/);
  const s = sanitize('C:\\Users\\Alex\\AppData --accessToken eyJabcdefghijk.eyJabcdefghijk.sig 192.168.1.5:25565');
  assert.ok(!/Alex|eyJ|192\.168/.test(s));
  const asst = new Assistant({ llm: null });
  const r = await asst.diagnose('[main/INFO]: всё хорошо');
  assert.match(r.needMore, /нет ошибок/);
  const ai = manager('good');
  const r2 = await new Assistant({ llm: ai }).diagnose('[Render thread/ERROR]: Something odd happened\nCaused by: java.lang.IllegalStateException: odd');
  assert.equal(r2.by, 'model');
  assert.equal(r2.guess.confident, false);
  await ai.stop();
});

test('диагностика: «…Exception» без пробела перед словом, виновник из crash-report Forge, Mixin с названием мода', async () => {
  const npe = [
    '---- Minecraft Crash Report ----',
    'Description: Ticking entity',
    '',
    'java.lang.NullPointerException: Cannot invoke "Player.getX()" because "this.targetPlayer" is null',
    '\tat com.mrcrayfish.cave_dweller.entity.ai.goals.CaveDwellerChaseGoal.tick(CaveDwellerChaseGoal.java:112) ~[cave_dweller-1.20.1-1.7.0.jar%23214!/:1.7.0]',
    '\tat net.minecraft.world.entity.ai.goal.WrappedGoal.tick(WrappedGoal.java:65)',
    '',
    '-- Head --',
    'Thread: Server thread',
    'Suspected Mod: ',
    '\tCave Dweller Evolved (cave_dweller), Version: 1.7.0',
    '\t\tat TRANSFORMER/cave_dweller@1.7.0/com.mrcrayfish.cave_dweller.entity.ai.goals.CaveDwellerChaseGoal.tick(CaveDwellerChaseGoal.java:112)',
    '',
    '-- System Details --',
    '\tJVM Flags: 4 total; -Xmx2G',
  ].join('\n');
  const lines = keyLines(npe);
  assert.ok(lines.some((l) => /NullPointerException/.test(l)), 'NullPointerException попадает в ключевые строки');
  assert.ok(lines.some((l) => /CaveDwellerChaseGoal\.tick/.test(l)), 'и первая строка стека после неё');
  assert.ok(!lines.some((l) => /JVM Flags/.test(l)));
  assert.deepEqual(suspects(npe), [{ name: 'Cave Dweller Evolved', id: 'cave_dweller', version: '1.7.0' }]);
  const noModel = await new Assistant({ llm: null }).diagnose(npe);
  assert.match(noModel.needMore, /Cave Dweller Evolved.*1\.7\.0/, 'без модели — честная подсказка, на кого указала игра');
  assert.ok(!/нет ошибок/.test(noModel.needMore));
  const ai = manager('good');
  const withModel = await new Assistant({ llm: ai }).diagnose(npe);
  assert.equal(withModel.by, 'model', 'такой вылет доходит до модели');
  await ai.stop();
  // Forge: Mixin упал у конкретного мода — правило называет его, а не «один из модов»
  const forge = ['-- Mod loading issue for: oculus --', 'Details:', '\tCaused by 1: org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin [mixins.oculus.compat.sodium.json:X] FAILED during APPLY'].join('\n');
  const mx = diagnose(forge).filter((f) => f.id === 'mixin');
  assert.equal(mx.length, 1, 'одна находка, без дубля от общего правила');
  assert.deepEqual(mx[0].data, { modId: 'oculus' });
  assert.match(mx[0].fix, /oculus/);
  assert.equal(diagnose('MixinApplyError: Mixin [a.json:B] FAILED during APPLY').filter((f) => f.id === 'mixin').length, 1, 'общее правило работает как раньше');
  // окно «Found N error(s) during startup» (настоящий вывод Fabulously Optimized + REI без Architectury)
  const nf = diagnose('Found 1 error(s) during startup:\n- Architectury API is a required dependency of Roughly Enough Items 12.1.785 but it is not installed!\nhttps://www.curseforge.com/minecraft/mc-mods/architectury-api/');
  assert.deepEqual(nf.map((f) => f.id), ['missing-dep-notifier']);
  assert.deepEqual(nf[0].data, { mod: 'Roughly Enough Items', depName: 'Architectury API', depId: 'architectury-api' });
});

test('модель загружается по запросу и полностью выгружается', async () => {
  const ai = manager('good');
  assert.equal((await ai.status()).running, false, 'в простое модель не загружена');
  await ai.start();
  const pid = ai.proc.pid;
  const rss = await processRssMb(pid);
  assert.ok(rss > 150, 'во время работы занята память: ' + rss + ' МБ');
  await ai.stop();
  assert.equal(ai.proc, null);
  assert.throws(() => process.kill(pid, 0), 'процесс модели завершён');
  assert.equal((await ai.status()).rssMb, 0);
  // автовыгрузка после простоя
  const idle = manager('good', { idleMs: 300 });
  await idle.start();
  const pid2 = idle.proc.pid;
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(idle.proc, null);
  assert.throws(() => process.kill(pid2, 0));
});

test('движок llama.cpp: выпуски-prerelease, .tar.gz и .zip, проверка SHA-256 при установке', async () => {
  const crypto = require('crypto');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const http = require('../core/http');
  const { AiManager, pickRuntime, runtimeAssetPattern } = require('../core/ai/manager');
  // имена файлов — как в текущих выпусках ggml-org/llama.cpp (release-publish.yml)
  const win = runtimeAssetPattern('win32', 'x64');
  const linux = runtimeAssetPattern('linux', 'x64');
  const rel = (tag, names, extra = {}) => ({ tag_name: tag, prerelease: true, ...extra, assets: names.map((n) => ({ name: n, size: 1, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://x/' + n })) });
  const list = [rel('b9000', ['llama-b9000-bin-win-cpu-x64.zip'], { draft: true }), rel('b8999', ['llama-b8999-bin-win-cpu-x64.zip', 'llama-b8999-bin-ubuntu-x64.tar.gz', 'llama-b8999-bin-win-cuda-12.4-x64.zip'])];
  assert.equal(pickRuntime(list, win).asset.name, 'llama-b8999-bin-win-cpu-x64.zip', 'черновик пропущен, CUDA не берётся');
  assert.equal(pickRuntime(list, linux).asset.name, 'llama-b8999-bin-ubuntu-x64.tar.gz');
  assert.equal(pickRuntime([rel('old', ['llama-b1-bin-win-avx2-x64.zip'])], win), null);
  const noDigest = rel('b2', ['llama-b2-bin-win-cpu-x64.zip']);
  noDigest.assets[0].digest = null;
  assert.equal(pickRuntime([noDigest], win), null, 'без SHA-256 не устанавливаем');

  if (process.platform !== 'linux') return;
  // полный путь plan → install на Linux: настоящий .tar.gz с «llama-server» внутри
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-llama-'));
  fs.mkdirSync(path.join(tmp, 'pkg', 'llama-b8999'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'pkg', 'llama-b8999', 'llama-server'), '#!/bin/sh\necho ok\n');
  const tgz = path.join(tmp, 'rt.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', path.join(tmp, 'pkg'), '.']);
  const tgzBuf = fs.readFileSync(tgz);
  const model = Buffer.from('GGUF-test-model');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const routes = {
    'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15': JSON.stringify([{ tag_name: 'b8999', prerelease: true, assets: [{ name: 'llama-b8999-bin-ubuntu-x64.tar.gz', size: tgzBuf.length, digest: 'sha256:' + sha(tgzBuf), browser_download_url: 'https://dl/rt.tar.gz' }] }]),
    'https://huggingface.co/api/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/tree/main': JSON.stringify([{ path: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', size: model.length, lfs: { oid: sha(model), size: model.length } }]),
    'https://dl/rt.tar.gz': tgzBuf,
    'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf': model,
  };
  http.setFetch(async (url) => (routes[url] ? new Response(routes[url], { status: 200, headers: { 'content-length': String(Buffer.byteLength(routes[url])) } }) : new Response('nf', { status: 404 })));
  try {
    const ai = new AiManager(path.join(tmp, 'root'));
    const plan = await ai.plan('qwen2.5-0.5b');
    assert.equal(plan.runtime.tag, 'b8999');
    const st = await ai.install(plan);
    assert.equal(st.installed, true);
    const state = JSON.parse(fs.readFileSync(path.join(tmp, 'root', 'ai', 'state.json'), 'utf8'));
    assert.match(state.runtime.binary, /llama-b8999[\\/]llama-server$/, 'llama-server найден в распакованном .tar.gz');
    assert.ok(fs.statSync(state.runtime.binary).mode & 0o100, 'исполняемый');
    // Gemma 3 4B: в первом репозитории файла нет — берётся следующий; mmproj (картинки) не скачивается
    routes['https://huggingface.co/api/models/unsloth/gemma-3-4b-it-GGUF/tree/main'] = JSON.stringify([
      { path: 'mmproj-gemma-3-4b-it-Q4_K_M.gguf', size: 9, lfs: { oid: 'x', size: 9 } },
      { path: 'gemma-3-4b-it-UD-Q4_K_XL.gguf', size: 9, lfs: { oid: 'y', size: 9 } },
      { path: 'gemma-3-4b-it-Q4_K_M.gguf', size: model.length, lfs: { oid: sha(model), size: model.length } },
    ]);
    const g = await ai.plan('gemma3-4b');
    assert.equal(g.model.url, 'https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf');
    assert.equal(g.model.terms, 'https://ai.google.dev/gemma/terms', 'условия Gemma показываются до установки');
    await assert.rejects(ai.plan('qwen3-4b'), /Не найден файл модели Qwen3 4B/);
    const st2 = await ai.status();
    assert.ok(['qwen3-4b', 'gemma3-4b', 'gemma3n-e2b'].every((id) => st2.models.some((m) => m.id === id && m.ramGb >= 6)));
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
  }
});

test('загрузка модели одна на всё приложение: второе «Скачать» не начинает вторую загрузку', async () => {
  const http = require('../core/http');
  let release;
  let started;
  const called = new Promise((r) => (started = r));
  // скачивание «висит», пока тест его не отпустит; дальше сервер отвечает 404 без повторов
  http.setFetch(() => {
    started();
    return release ? Promise.resolve(new Response('nf', { status: 404 })) : new Promise((r) => (release = () => r(new Response('nf', { status: 404 }))));
  });
  try {
    const ai = new AiManager(fs.mkdtempSync(path.join(os.tmpdir(), 'easy-ai-busy-')));
    const plan = { runtime: { tag: 'b1', name: 'rt.zip', url: 'https://x/rt.zip', size: 100, sha256: 'a'.repeat(64) }, model: { id: 'm', label: 'Тестовая модель', file: 'm.gguf', url: 'https://x/m.gguf', size: 200, sha256: 'b'.repeat(64) }, totalBytes: 300 };
    const first = ai.install(plan);
    await called;
    const st = await ai.status();
    assert.deepEqual([st.installing.label, st.installing.total], ['Тестовая модель', 300], 'окно видит идущую загрузку на любой вкладке');
    await assert.rejects(ai.install(plan), /Уже скачивается Тестовая модель/);
    await assert.rejects(ai.uninstall(), /ещё скачивается/);
    release();
    await assert.rejects(first);
    assert.equal((await ai.status()).installing, null, 'после ошибки можно скачать снова');
  } finally {
    http.setFetch((...a) => globalThis.fetch(...a));
  }
});

test('помощник не пропускает ответы модели, как на скриншотах игрока', async () => {
  const { Assistant, smallTalk, validateExplanation, templateExplanation } = require('../core/ai/assistant');
  // приветствие и «ты работаешь?» — ответ без модели
  assert.match(smallTalk('привет'), /Привет! Я помогаю/);
  assert.match(smallTalk('ты работаешь?'), /^Да, работаю\. Я помогаю/);
  assert.equal(smallTalk('добавь Create'), null);
  // модель приняла вопрос за ошибку, придумала searchTerm «farming», ответила уточнением «yes»
  const llm = (answer) => ({ available: () => true, complete: async () => answer });
  const base = { themes: [], avoid: [], searchTerms: [], players: null, lowEnd: false, clarify: null };
  let u = await new Assistant({ llm: llm({ ...base, intent: 'diagnose' }) }).understand('ну как ты там вообще');
  assert.equal(u.intent.intent, 'question', 'обычный вопрос не уходит в разбор ошибки');
  u = await new Assistant({ llm: llm({ ...base, intent: 'question', clarify: 'yes' }) }).understand('ну как ты там вообще');
  assert.equal(u.intent.clarify, null, 'английское «yes» не показывается');
  u = await new Assistant({ llm: llm({ ...base, intent: 'build', themes: ['farming'], searchTerms: ['farming', 'Sodium'] }) }).understand('хочу уютную ферму и чтобы не лагало, поставь Sodium');
  assert.deepEqual(u.intent.searchTerms, ['Sodium'], 'придуманное моделью слово не ищется как название мода');
  assert.ok(u.intent.themes.includes('farming') && u.intent.themes.includes('performance'));
  // пояснение на английском и с выдуманной версией — отклоняется
  const planNames = ["Farmer's Delight Refabricated", 'Sodium', 'Fabric API'];
  const facts = [{ type: 'add', name: 'Sodium', version: 'mc26.3-0.9.2-fabric' }];
  assert.equal(validateExplanation({ text: "Farmer's Delight Refabricated, Sodium and Fabric API have been added to the version 26.3." }, { planNames, otherNames: [], facts }), null);
  assert.equal(validateExplanation({ text: 'Sodium уже добавлен в версию 1.2.3.' }, { planNames, otherNames: [], facts }), null);
  assert.ok(validateExplanation({ text: 'Предлагаю добавить Sodium — он ускоряет отрисовку и поднимает FPS.' }, { planNames, otherNames: [], facts }));
  const t = templateExplanation({ changes: [{ type: 'add', name: 'Sodium' }, { type: 'add', name: 'Fabric API', dependencyOf: "Farmer's Delight" }, { type: 'add', name: "Farmer's Delight" }] });
  assert.match(t, /Предлагаю добавить Sodium, Farmer's Delight; Fabric API нужен для работы Farmer's Delight/);
});

test('«как дела» и «сборка на сто модов зомби апокалипсис» — как на скриншоте игрока', async () => {
  const { Assistant, smallTalk, proposeMods, ruleIntent } = require('../core/ai/assistant');
  assert.match(smallTalk('как дела'), /^Всё хорошо/);
  assert.match(smallTalk('как дела?'), /^Всё хорошо/);
  // маленькая модель вернула «вопрос» без тем — правила всё равно видят тему и размер
  const llm = { available: () => true, complete: async () => ({ intent: 'question', themes: [], avoid: [], searchTerms: [], players: null, lowEnd: false, clarify: null }) };
  const u = await new Assistant({ llm }).understand('хочу сборку на сто модов зомби апокалипсис');
  assert.equal(u.intent.intent, 'build');
  assert.ok(u.intent.themes.includes('zombies'));
  assert.equal(u.intent.big, true);
  assert.equal(ruleIntent('выживание с зомби').big, false);
  // большая сборка: несколько модов на тему + основа (оптимизация, удобства), не больше 20
  const catalog = (q) => Array.from({ length: 5 }, (_, i) => ({ key: `modrinth:${q}-${i}`, id: `${q}-${i}`, source: 'modrinth', name: `${q} ${i}`, categories: [] }));
  const prop = await proposeMods(u.intent, { search: async (q) => catalog(q), lock: { mods: [] } });
  const names = prop.add.map((m) => m.name);
  assert.ok(names.includes('zombie 0') && names.includes('zombie 2') && names.includes('apocalypse 1'), 'по 3 мода на запрос темы');
  assert.ok(names.some((n) => n.startsWith('sodium')) && names.some((n) => n.startsWith('jei')), 'основа: оптимизация и удобства');
  assert.ok(prop.add.length <= 20);
  assert.deepEqual(prop.notFound, []);
});
