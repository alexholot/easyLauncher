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

const RULES = [
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
  {
    id: 'missing-dep-fabric',
    re: /Mod '([^']+)' \(([\w-]+)\) [\d.\w+-]+ requires (?:any version|version [^ ]+)(?: of| between [^ ]+ and [^ ]+ of)? (?:mod )?'?([^',\n]+)'?(?: \(([\w-]+)\))?/,
    level: 'error',
    title: 'Не хватает зависимости мода',
    fix: (m) => `«${m[1]}» требует «${m[3].trim()}». Открой «Сборка» — лаунчер предложит недостающий мод из каталога.`,
  },
  {
    id: 'missing-dep-generic',
    re: /(?:requires|depends on) (?:mod )?['"]?([\w-]+)['"]?[^\n]*(?:which is missing|is not installed|but it is missing)/i,
    level: 'error',
    title: 'Не хватает зависимости мода',
    fix: (m) => `Не найден мод «${m[1]}». Добавь его через «Сборка».`,
  },
  {
    id: 'incompatible',
    re: /Incompatible mods? (?:found|set)[\s\S]{0,300}?(?:Mod '([^']+)'[^\n]*incompatible with[^\n]*'([^']+)')?/,
    level: 'error',
    title: 'Несовместимые моды',
    fix: (m) => (m[1] ? `«${m[1]}» несовместим с «${m[2]}». Убери один из них.` : 'В сборке есть моды, которые авторы объявили несовместимыми. Открой «Сборка» и проверь предупреждения.'),
  },
  {
    id: 'wrong-mc',
    re: /requires (?:version [^ ]+ of )?(?:'Minecraft'|minecraft) \(minecraft\)[^\n]*(?:but only the wrong version is present: ([\d.]+))?/,
    level: 'error',
    title: 'Мод для другой версии Minecraft',
    fix: () => 'Один из модов рассчитан на другую версию игры. Обнови его через «Сборка» или выбери подходящую версию Minecraft.',
  },
  {
    id: 'mixin',
    re: /(?:MixinApplyError|InvalidMixinException|Mixin apply for mod (\w+) failed)[^\n]*/,
    level: 'error',
    title: 'Конфликт внедрений (Mixin)',
    fix: (m) => (m[1] ? `Мод «${m[1]}» не смог встроиться в игру — обычно это несовместимость версий. Попробуй обновить или убрать его.` : 'Один из модов не смог встроиться в игру. Обычно помогает обновление или удаление последнего добавленного мода.'),
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
    const m = clean.match(r.re);
    if (m) out.push({ id: r.id, level: r.level, title: r.title, fix: r.fix(m), evidence: m[0].slice(0, 300) });
  }
  return out;
}

/** Самые содержательные строки лога для модели: ошибки и начало цепочки Caused by. */
function keyLines(text, limit = 40) {
  const lines = sanitize(text).split(/\r?\n/);
  const picked = [];
  for (let i = 0; i < lines.length && picked.length < limit; i++) {
    if (/\b(ERROR|FATAL|Exception|Caused by|Error:|failed)\b/.test(lines[i])) picked.push(lines[i].slice(0, 240));
  }
  return picked;
}

module.exports = { diagnose, sanitize, keyLines, RULES };
