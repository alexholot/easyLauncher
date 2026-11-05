'use strict';
// Диагностика падений по правилам. Лог — недоверенные данные: только читаем и цитируем фрагменты.

/** Убрать из лога личное: пути пользователя, токены доступа, адреса. */
function sanitize(text, max = 60000) {
  return String(text || '')
    .slice(-max)
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/g, '$1%USER%')
    .replace(/(\/(?:home|Users)\/)[^/\s]+/g, '$1%USER%')
    .replace(/(--accessToken\s+)\S+/g, '$1***')
    .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/g, '***jwt***')
    .replace(/\b(\d{1,3}\.){3}\d{1,3}(:\d+)?\b/g, (m) => (m.startsWith('127.') ? m : '***ip***'));
}

/** «any 0.6.x version» → «0.6.x», «version 1.2.1 or later» → «1.2.1 или новее» — для текста игроку. */
function ver(s) {
  const t = String(s || '')
    .replace(/^any version$/, 'любая версия')
    .replace(/^any (\S+) version$/, '$1')
    .replace(/^version (\S+) or later$/, '$1 или новее')
    .replace(/^any version before (\S+)$/, 'до $1')
    .replace(/^any version after (\S+)$/, 'после $1')
    .replace(/^version (\S+)$/, '$1');
  return t.slice(0, 60);
}

const RULES = [
  {
    id: 'mixin-java',
    re: /Compatibility level (JAVA_(\d+)) specified by ([^\s]+\.mixins?\.json) is higher than the maximum level supported by this version of mixin \((JAVA_(\d+))\)/i,
    level: 'error',
    title: 'Мод собран для слишком новой Java',
    fix: (m) => `Файл «${m[3]}» требует Java ${m[2]}, а Mixin этой версии поддерживает только ${m[5]}. Лаунчер проверит файлы сборки и уберёт несовместимый мод.`,
    data: (m) => ({ mixinConfig: m[3], requiredJava: Number(m[2]) }),
  },
  {
    id: 'java-version',
    re: /UnsupportedClassVersionError[^\n]*class file version (\d+)[^\n]*up to (\d+)/,
    level: 'error',
    title: 'Мод или игра требуют более новую Java',
    fix: (m) => `Код собран для Java ${Number(m[1]) - 44}, а запущена Java ${Number(m[2]) - 44}. Лаунчер подбирает Java по версии Minecraft — если мод требует более новую, нужен другой релиз мода.`,
  },
  {
    id: 'oom',
    re: /java\.lang\.OutOfMemoryError: ([^\n]+)/,
    level: 'error',
    title: 'Не хватило памяти Java',
    fix: (m) =>
      /Metaspace/.test(m[1])
        ? 'Закончилась память под классы (Metaspace) — так бывает при очень большой сборке.'
        : 'Попробуй выделить игре на 1–2 ГБ больше в настройках, не превышая половину ОЗУ, или убрать тяжёлые моды.',
  },
  // Fabric: «Mod 'Loot & Explore' (loot_n_explore) 1.0.24 requires version 1.2.1 or later of structure_pool_api,
  // which is missing!» и «… requires any version of mod 'Fabric API' (fabric-api), which is missing!»
  {
    id: 'missing-dep-fabric',
    all: true,
    re: /Mod '([^'\n]+)' \(([\w.-]+)\) \S+ requires ([^\n]*?) of (?:mod )?(?:'([^'\n]+)' \(([\w.-]+)\)|([\w.-]+)),? which is missing/,
    level: 'error',
    title: 'Не хватает зависимости мода',
    fix: (m) => `«${m[1]}» требует «${m[4] || m[6]}» (${ver(m[3])}). Лаунчер может найти его в каталоге и добавить в сборку.`,
    data: (m) => ({ mod: m[1], modId: m[2], depName: m[4] || m[6], depId: m[5] || m[6] }),
  },
  // Fabric: «Mod 'Iris' (iris) 1.8.8 requires any 0.6.x version of mod 'Sodium' (sodium), but only the wrong version is present: 0.8.13!»
  {
    id: 'wrong-dep-version',
    all: true,
    re: /Mod '([^'\n]+)' \(([\w.-]+)\) \S+ requires ([^\n]*?) of (?:mod )?(?!'Minecraft')(?:'([^'\n]+)' \(([\w.-]+)\)|([\w.-]+)),? but only the wrong version is present: ([^\s!]+)/,
    level: 'error',
    title: 'Мод требует другую версию другого мода',
    fix: (m) => `«${m[1]}» работает только с «${m[4] || m[6]}» (${ver(m[3])}), а в сборке ${m[7]}. Лаунчер может подобрать подходящую версию.`,
    data: (m) => ({ mod: m[1], modId: m[2], depName: m[4] || m[6], depId: m[5] || m[6], have: m[7] }),
  },
  // окно «Found N error(s) during startup» (error_notifier и др.): «- Architectury API is a required dependency of
  // Roughly Enough Items 12.1.785 but it is not installed!» — название недостающего мода и того, кому он нужен
  {
    id: 'missing-dep-notifier',
    all: true,
    re: /(?:^|\n)\s*-?\s*([^\n]+?) is a required dependency of ([^\n]+?)(?: [\w.+-]*\d[\w.+-]*)? but it is not installed/,
    level: 'error',
    title: 'Не хватает зависимости мода',
    fix: (m) => `«${m[2]}» требует «${m[1]}». Лаунчер может найти его в каталоге и добавить в сборку.`,
    data: (m) => ({ mod: m[2], depName: m[1], depId: m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }),
  },
  {
    id: 'missing-dep-generic',
    // «requires version …» и «requires any …» разбирают правила выше: там после requires идёт не имя мода
    unless: /Mod '[^'\n]+' \([\w.-]+\) \S+ requires/,
    re: /(?:requires|depends on) (?:mod )?['"]?(?!(?:version|any|a|the)\b)([\w-]+)['"]?[^\n]*(?:which is missing|is not installed|but it is missing)/i,
    level: 'error',
    title: 'Не хватает зависимости мода',
    fix: (m) => `Не найден мод «${m[1]}». Добавь его через «Сборка».`,
    data: (m) => ({ depName: m[1], depId: m[1] }),
  },
  // Fabric: «Mod 'Sodium' (sodium) 0.8.13 is incompatible with any version before 1.8.13 of mod 'Iris' (iris), yet a conflicting version is present»
  {
    id: 'incompatible',
    all: true,
    re: /Mod '([^'\n]+)' \(([\w.-]+)\) \S+ is incompatible with ([^\n]*?) of (?:mod )?(?:'([^'\n]+)' \(([\w.-]+)\)|([\w.-]+))/,
    level: 'error',
    title: 'Несовместимые моды',
    fix: (m) => `«${m[1]}» несовместим с «${m[4] || m[6]}» (${ver(m[3])}). Лаунчер может подобрать версии или убрать один из них.`,
    data: (m) => ({ a: m[1], b: m[4] || m[6] }),
  },
  {
    id: 'incompatible-generic',
    unless: /Mod '[^'\n]+' \([\w.-]+\) \S+ (?:requires|is incompatible)/,
    re: /Incompatible mods? (?:found|set)/,
    level: 'error',
    title: 'Несовместимые моды',
    fix: () => 'В сборке есть моды, которые авторы объявили несовместимыми. Открой «Сборка» и проверь предупреждения.',
  },
  {
    id: 'wrong-mc',
    re: /requires (?:version [^ ]+ of )?(?:'Minecraft'|minecraft) \(minecraft\)[^\n]*(?:but only the wrong version is present: ([\d.]+))?/,
    level: 'error',
    title: 'Мод для другой версии Minecraft',
    fix: () => 'Один из модов рассчитан на другую версию игры. Обнови его через «Сборка» или выбери подходящую версию Minecraft.',
  },
  // Forge/NeoForge crash-report: «-- Mod loading issue for: oculus --» и ниже в нём MixinApplyError — виновник назван прямо
  {
    id: 'mixin',
    re: /-- Mod loading issue for: ([\w-]+) --[\s\S]{0,6000}?(?:MixinApplyError|MixinTransformerError|InvalidInjectionException|InvalidMixinException)[^\n]*/,
    level: 'error',
    title: 'Конфликт внедрений (Mixin)',
    fix: (m) => `Мод «${m[1]}» не смог встроиться в игру — обычно это несовместимость версий. Попробуй обновить или убрать его.`,
    data: (m) => ({ modId: m[1] }),
  },
  {
    id: 'mixin',
    unless: /-- Mod loading issue for: [\w-]+ --[\s\S]{0,6000}?(?:MixinApplyError|MixinTransformerError|InvalidInjectionException|InvalidMixinException)/,
    re: /(?:MixinApplyError|InvalidMixinException|Mixin apply for mod (\w+) failed)[^\n]*/,
    level: 'error',
    title: 'Конфликт внедрений (Mixin)',
    fix: (m) => (m[1] ? `Мод «${m[1]}» не смог встроиться в игру — обычно это несовместимость версий. Попробуй обновить или убрать его.` : 'Один из модов не смог встроиться в игру. Обычно помогает обновление или удаление последнего добавленного мода.'),
    data: (m) => ({ modId: m[1] || null }),
  },
  {
    id: 'gl-driver',
    re: /(?:GLFW error 65542|WGL: The driver does not appear to support OpenGL|Pixel format not accelerated|EXCEPTION_ACCESS_VIOLATION[^\n]*(?:atio|nvoglv|ig\w+icd))/,
    level: 'error',
    title: 'Проблема драйвера видеокарты',
    fix: () => 'Обнови драйвер видеокарты с сайта производителя. На ноутбуке проверь, что игра запускается на дискретной видеокарте.',
  },
  {
    id: 'port',
    re: /FAILED TO BIND TO PORT|Address already in use/,
    level: 'error',
    title: 'Порт занят',
    fix: () => 'Другой сервер или программа уже использует порт. Закрой лишний сервер Minecraft.',
  },
  {
    id: 'corrupt-jar',
    re: /(?:ZipException|zip END header not found|invalid LOC header)[^\n]*/,
    level: 'error',
    title: 'Повреждённый файл мода или игры',
    fix: () => 'Один из JAR-файлов повреждён. Лаунчер проверит хеши и скачает файл заново при следующем запуске.',
  },
  {
    id: 'main-class',
    re: /Could not find or load main class ([\w.]+)/,
    level: 'error',
    title: 'Не найдены файлы игры',
    fix: () => 'Файлы версии неполные. Запусти игру ещё раз — лаунчер докачает недостающее.',
  },
];

/** Возвращает список находок с цитатой из лога; пустой список — правила причину не нашли. */
function diagnose(text) {
  const clean = sanitize(text);
  const out = [];
  for (const r of RULES) {
    if (r.unless && r.unless.test(clean)) continue;
    // all — каждая строка отдельной находкой (в одном вылете Fabric бывает несколько причин), не больше 4
    const ms = r.all ? [...clean.matchAll(new RegExp(r.re.source, r.re.flags + 'g'))].slice(0, 4) : [clean.match(r.re)].filter(Boolean);
    const seen = new Set();
    for (const m of ms) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      // data — разобранные имена модов для автоматической починки (помощник проверяет их по каталогу и сборке)
      out.push({ id: r.id, level: r.level, title: r.title, fix: r.fix(m), evidence: m[0].slice(0, 300), data: r.data ? r.data(m) : null });
    }
  }
  return out;
}

// «NullPointerException», «IllegalStateException», «NoSuchMethodError» — слово приклеено к имени класса,
// поэтому граница слова только справа
const KEY_LINE = /\b(?:ERROR|FATAL)\b|\w*(?:Exception|Error)\b(?!\s*=)|Caused by|\bfailed\b|Compatibility level JAVA_|^Description: /;

/** Самые содержательные строки лога для модели: ошибки, начало цепочки Caused by и первая строка стека после ошибки. */
function keyLines(text, limit = 40) {
  const lines = sanitize(text).split(/\r?\n/);
  const picked = [];
  for (let i = 0; i < lines.length && picked.length < limit; i++) {
    // служебные строки отчёта без ошибки: «-- System Details --», флаги JVM, список модов
    if (!KEY_LINE.test(lines[i]) || /^\s*(?:JVM Flags|Mod List|Is Modded)\b/.test(lines[i])) continue;
    picked.push(lines[i].trim().slice(0, 240));
    const next = lines[i + 1] || '';
    if (/^\s*at [\w.$/@]+/.test(next) && picked.length < limit) picked.push(next.trim().slice(0, 240));
  }
  return [...new Set(picked)];
}

/** «Suspected Mod(s)» из crash-report Forge/NeoForge: [{ name, id, version }] — на кого указывает сама игра. */
function suspects(text) {
  const out = [];
  const block = String(text || '').match(/Suspected Mods?:[^\n]*\n((?:[ \t]+[^\n]*\n?)+)/);
  if (!block) return out;
  for (const m of block[1].matchAll(/^[ \t]+([^\n(]+?) \(([\w.-]+)\), Version: ([^\s]+)/gm)) {
    if (!['minecraft', 'forge', 'neoforge'].includes(m[2])) out.push({ name: m[1].trim(), id: m[2], version: m[3] });
  }
  return out.slice(0, 3);
}

module.exports = { diagnose, sanitize, keyLines, suspects, RULES };
