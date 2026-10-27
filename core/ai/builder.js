'use strict';
// Сборщик для помощника: подбор модов под тему, выбор версии игры и загрузчика для новой сборки,
// настройки игры под ПК. Моды берутся только из каталога: известные популярные проекты (slug Modrinth)
// и самые скачиваемые в категории темы. Совместимость, зависимости и конфликты проверяет обычный план
// (planChanges); то, что проверку не прошло, убирается из подборки (planPruned), а не ставится.
const { keyOf } = require('../lock');

// Основа сборки по ролям. В группе — замены одного и того же: берётся первая, что есть под сборку
const BASE = {
  performance: [['sodium', 'embeddium'], ['lithium', 'canary'], ['ferrite-core'], ['modernfix'], ['entityculling'], ['immediatelyfast']],
  qol: [['jei', 'emi', 'rei'], ['jade', 'wthit'], ['appleskin'], ['xaeros-minimap'], ['xaeros-world-map'], ['mouse-tweaks'], ['controlling'], ['modmenu']],
};

// Известные популярные моды по темам (наличие и загрузчики сверены с Modrinth, октябрь 2026)
const RECIPES = {
  technology: [['create', 'create-fabric'], ['ae2'], ['mekanism'], ['immersive-aircraft']],
  magic: [['irons-spells-n-spellbooks'], ['ars-nouveau'], ['botania'], ['waystones']],
  adventure: [['when-dungeons-arise'], ['yungs-better-dungeons'], ['dungeons-and-taverns'], ['towns-and-towers'], ['artifacts'], ['l_enders-cataclysm', 'bosses-of-mass-destruction'], ['waystones'], ['yungs-better-mineshafts']],
  exploration: [['terralith', 'biomes-o-plenty'], ['tectonic'], ['explorify'], ['incendium'], ['nullscape'], ['waystones']],
  farming: [['farmers-delight', 'farmers-delight-refabricated'], ['serene-seasons'], ['appleskin']],
  building: [['chipped'], ['supplementaries'], ['handcrafted'], ['macaws-furniture']],
  decoration: [['supplementaries'], ['handcrafted'], ['another-furniture'], ['comforts']],
  furniture: [['handcrafted'], ['another-furniture'], ['macaws-furniture']],
  storage: [['sophisticated-backpacks'], ['sophisticated-storage'], ['toms-storage']],
  mobs: [['naturalist'], ['friends-and-foes'], ['creeper-overhaul'], ['mowzies-mobs'], ['mutant-monsters'], ['alexs-mobs']],
  zombies: [['zombie-awareness'], ['undead-nights'], ['the-undead-revamped'], ['improved-mobs']],
  horror: [['from-the-fog'], ['the-man-from-the-fog'], ['cave-dweller-evolved']],
  weapons: [['better-combat'], ['simply-swords'], ['spartan-weaponry']],
  vehicles: [['immersive-aircraft'], ['small-ships'], ['create-aeronautics'], ['immersive-vehicles']],
  dragons: [['ice-and-fire-dragons'], ['dragon-mounts-legacy']],
  space: [['ad-astra']],
  medieval: [['medieval-buildings'], ['better-combat'], ['towns-and-towers']],
  survival: [['tough-as-nails'], ['serene-seasons'], ['comforts']],
  ocean: [['yungs-better-ocean-monuments'], ['aquamirae'], ['upgrade-aquatic'], ['aquaculture']],
  hardcore: [['improved-mobs'], ['enhanced-ai'], ['tough-as-nails']],
  visuals: [['iris', 'oculus'], ['continuity'], ['lambdynamiclights', 'dynamic-lights']],
  performance: BASE.performance,
  qol: BASE.qol,
  multiplayer: [],
};

// Добор популярных модов темы: поиск по словам (категории Modrinth слишком широкие — в «снаряжение»
// попадает и еда); category без query — самые скачиваемые в узкой категории
const FILL = {
  adventure: [{ query: 'dungeon' }, { query: 'structures' }, { query: 'boss' }, { query: 'loot' }, { query: 'exploration' }],
  technology: [{ query: 'create' }, { query: 'machines' }, { query: 'automation' }],
  magic: [{ query: 'magic' }, { query: 'spells' }, { query: 'enchantments' }, { query: 'wizard' }],
  building: [{ query: 'building blocks' }, { query: 'decoration' }],
  decoration: [{ query: 'decoration' }],
  furniture: [{ query: 'furniture' }],
  farming: [{ query: 'farming' }, { query: 'crops' }, { query: 'cooking' }],
  storage: [{ category: 'storage' }],
  exploration: [{ query: 'biomes' }, { query: 'structures' }],
  mobs: [{ category: 'mobs' }],
  weapons: [{ query: 'weapons' }, { query: 'swords' }, { query: 'combat' }],
  vehicles: [{ query: 'vehicles' }, { query: 'ships' }],
  zombies: [{ query: 'zombie' }, { query: 'apocalypse' }],
  horror: [{ query: 'horror' }],
  dragons: [{ query: 'dragon' }],
  space: [{ query: 'space' }, { query: 'planets' }],
  medieval: [{ query: 'medieval' }, { query: 'knights' }],
  survival: [{ query: 'survival' }],
  ocean: [{ query: 'ocean' }, { query: 'underwater' }],
  hardcore: [{ query: 'difficulty' }],
  visuals: [{ query: 'visual' }],
};
// Моды, которые меняют всю игру (покемоны, огнестрел, классы) или экран: сами не добавляются,
// только если игрок назвал их сам
const OVERHAULS = new Set(['cobblemon', 'timeless-and-classics-zero', 'tacz', 'pixelmon', 'origins', 'minecolonies', 'epic-fight', 'pehkui', 'enhancedvisuals', 'first-person-model', 'immersive-portals-mod', 'better-third-person', 'shoulder-surfing-reloaded', 'tinkers-construct', 'goety']);

// Моды одной роли: второй такой при доборе из каталога не берётся (два миникарты или две замены Sodium мешают)
const RIVALS = [
  ['sodium', 'embeddium', 'rubidium', 'magnesium', 'optifabric'],
  ['iris', 'oculus'],
  ['jei', 'emi', 'rei', 'roughly-enough-items'],
  ['jade', 'wthit', 'the-one-probe', 'hwyla'],
  ['xaeros-minimap', 'journeymap', 'voxelmap-updated', 'ftb-chunks'],
  ['xaeros-world-map', 'journeymap'],
  ['lithium', 'canary', 'radium'],
  ['lambdynamiclights', 'dynamic-lights'],
];

// add — добавить к сборке по просьбе; small/normal/big — новая сборка
const SIZES = {
  add: { base: [], perTheme: 4, limit: 8 },
  more: { base: [], perTheme: 8, limit: 20 },
  small: { base: ['performance'], perTheme: 3, limit: 15 },
  normal: { base: ['performance', 'qol'], perTheme: 6, limit: 35 },
  big: { base: ['performance', 'qol'], perTheme: 14, limit: 70 },
};
const DEFAULT_THEMES = ['adventure', 'exploration'];
const HEAVY_TECH = /create|mekanism|tech|industrial|automation/i;

const THEME_RU = { adventure: 'Приключения', technology: 'Техника', magic: 'Магия', building: 'Строительство', farming: 'Фермы', storage: 'Хранилища', exploration: 'Исследования', performance: 'Оптимизация', visuals: 'Графика', qol: 'Удобства', multiplayer: 'Мультиплеер', hardcore: 'Хардкор', decoration: 'Декор', mobs: 'Мобы', zombies: 'Зомби', horror: 'Хоррор', weapons: 'Оружие', vehicles: 'Транспорт', dragons: 'Драконы', space: 'Космос', medieval: 'Средневековье', survival: 'Выживание', furniture: 'Мебель', ocean: 'Океан' };

const normalize = (s) => String(s).toLowerCase().replace(/[^a-zа-я0-9]+/g, '');

/** Проект есть под эту версию игры и загрузчик (Quilt запускает и моды Fabric). */
function fits(p, { minecraft, loader }) {
  return (p.gameVersions || []).includes(minecraft) && (p.loaders || []).some((l) => l === loader || (loader === 'quilt' && l === 'fabric'));
}

/** Что игрок хочет от сборки, кроме тем: новая ли она, версия, загрузчик, размер. */
function buildWishes(text) {
  const t = String(text).toLowerCase();
  const minecraft = (String(text).match(/(?<![\d.])(1\.\d{1,2}(?:\.\d{1,2})?|2\d\.\d{1,2}(?:\.\d{1,2})?)(?![\d.])/) || [])[1] || null;
  const loader = /neo\s?forge|неофорж/.test(t) ? 'neoforge' : /(?<![a-zа-яё])(forge|форж)/.test(t) ? 'forge' : /fabric|фабрик/.test(t) ? 'fabric' : /quilt|квилт/.test(t) ? 'quilt' : null;
  const wantsNew = /нов\S*\s+(\S+\s+)?сборк|(собер|сдела|созда|хоч|нуж)\S*\s+(\S+\s+){0,2}?сборк|сборк\S*\s+(с нуля|заново)/.test(t);
  const size = /(\d{2,}|сто|много|огромн|больш|полн)\S*\s+(\S+\s+)?(мод|сборк)/.test(t) ? 'big' : /(маленьк|небольш|л[её]гк|минимальн|простеньк)\S*\s+(\S+\s+)?(сборк|мод)/.test(t) ? 'small' : 'normal';
  return { wantsNew, minecraft, loader, size };
}

/** Название новой сборки по темам: «Зомби и оружие». */
function buildName(themes) {
  const names = themes.map((t) => THEME_RU[t]).filter(Boolean);
  if (!names.length) return 'Моя сборка';
  return names.length === 1 ? names[0] : `${names[0]} и ${names[1].toLowerCase()}`;
}

/** Проекты по slug одним запросом, если каталог умеет; иначе по одному. Нет проекта — его нет в ответе. */
async function projectMap(provider, slugs) {
  const uniq = [...new Set(slugs)];
  const map = new Map();
  if (typeof provider.projects === 'function') {
    for (const p of await provider.projects(uniq)) map.set(p.slug, p);
    return map;
  }
  for (const s of uniq) {
    try {
      map.set(s, await provider.project(s));
    } catch {}
  }
  return map;
}

function themesOf(intent, isNew) {
  const t = intent.themes.filter((x) => !intent.avoid.includes(x));
  return t.length || !isNew ? t : DEFAULT_THEMES.filter((x) => !intent.avoid.includes(x));
}

/**
 * Подборка модов: названные игроком (точное название), основа по размеру, известные моды тем,
 * затем добор самых скачиваемых модов категории темы. Только проекты под target.
 * → { add: [{source, id, slug, name, reason}], notFound, already }
 */
async function pickMods({ intent, target, lock, provider, size = 'add', roles: wantRoles = null }) {
  const cfg = SIZES[size] || SIZES.add;
  const { minecraft, loader } = target;
  const picked = new Map();
  const notFound = [];
  const already = [];
  const inLock = new Set(lock.mods.map((m) => m.key));
  const used = new Set(lock.mods.map((m) => m.slug).filter(Boolean));
  const avoided = (p) => {
    const cats = (p.categories || []).join(' ');
    return (intent.avoid.includes('technology') && HEAVY_TECH.test(p.name + ' ' + cats)) || (intent.avoid.includes('magic') && /magic/i.test(cats));
  };
  const rival = (slug) => RIVALS.some((g) => g.includes(slug) && g.some((s) => used.has(s)));
  const take = (p, reason, force = false) => {
    if (picked.has(p.key) || inLock.has(p.key)) return false;
    if (!force && (picked.size >= cfg.limit || avoided(p) || rival(p.slug))) return false;
    picked.set(p.key, { source: 'modrinth', id: p.id, slug: p.slug || null, name: p.name, reason });
    if (p.slug) used.add(p.slug);
    return true;
  };

  // 1. Названные игроком моды — только точное совпадение названия, без ограничений по размеру
  for (const term of intent.searchTerms) {
    let hits = [];
    try {
      hits = (await provider.search({ query: term, minecraft, loader, limit: 10 })).hits;
    } catch {
      continue;
    }
    // «Create» = «Create Fabric»: порт мода под загрузчик часто называется с его именем в конце
    const bare = (s) => normalize(s).replace(/(fabric|forge|neoforge|quilt|refabricated)$/, '');
    const exact = hits.find((h) => [h.name, h.slug || ''].some((n) => normalize(n) === normalize(term) || bare(n) === normalize(term)));
    if (!exact) notFound.push(term);
    else if (inLock.has(exact.key)) already.push(exact.name);
    else take(exact, 'term', true);
  }

  // 2. Основа и известные моды тем
  const themes = themesOf(intent, size !== 'add');
  // роли основы — из ответов игрока на уточняющие вопросы, иначе по размеру сборки
  const roles = wantRoles ? [...wantRoles] : [...cfg.base];
  if (intent.lowEnd && !roles.includes('performance')) roles.unshift('performance');
  const perTheme = size === 'big' && themes.length ? Math.max(cfg.perTheme, Math.ceil((cfg.limit - 14) / themes.length)) : cfg.perTheme;
  const groups = [];
  for (const role of roles) for (const g of BASE[role]) groups.push({ g, reason: 'base:' + role });
  for (const t of themes) for (const g of RECIPES[t] || []) groups.push({ g, reason: 'theme:' + t, theme: t });
  const projects = groups.length ? await projectMap(provider, groups.flatMap((x) => x.g)) : new Map();
  const count = {};
  for (const { g, reason, theme } of groups) {
    if (theme && (count[theme] || 0) >= perTheme) continue;
    const fitting = g.map((s) => projects.get(s)).filter((x) => x && fits(x, target));
    const p = fitting[0];
    if (!p || !take(p, reason)) continue;
    // замены той же роли — если первый мод не пройдёт проверку плана (planPruned)
    picked.get(p.key).alts = fitting.slice(1).map((x) => ({ id: x.id, slug: x.slug || null, name: x.name }));
    if (theme) count[theme] = (count[theme] || 0) + 1;
  }

  // 2б. Советы нейросети: только точное название из каталога, под эту сборку и популярный мод
  for (const name of intent.suggest || []) {
    if (picked.size >= cfg.limit) break;
    let hits = [];
    try {
      hits = (await provider.search({ query: name, minecraft, loader, limit: 10 })).hits;
    } catch {
      continue;
    }
    const bare = (s) => normalize(s).replace(/(fabric|forge|neoforge|quilt|refabricated)$/, '');
    const hit = hits.find((h) => [h.name, h.slug || ''].some((n) => bare(n) === bare(name)));
    if (hit && (hit.downloads || 0) >= 300000 && !OVERHAULS.has(hit.slug) && !(hit.categories || []).includes('library')) take(hit, 'ai');
  }

  // 3. Добор: популярные моды по словам темы (библиотеки придут сами как зависимости).
  // Из одного запроса — не больше доли темы, дополнения к уже выбранным модам — только для техники
  // (аддоны Create — суть такой сборки), иначе сборка забивается вариациями одного мода
  const names = () => [...picked.values(), ...lock.mods].map((m) => normalize(m.name)).filter((n) => n.length >= 6);
  const searchOf = (q) => provider.search({ ...q, sort: q.query ? 'relevance' : 'downloads', minecraft, loader, limit: 30 });
  // поиски нужных тем — параллельно (ответы кэшируются), разбор ниже — по порядку
  await Promise.all(themes.filter((t) => (count[t] || 0) < perTheme).flatMap((t) => (FILL[t] || []).map((q) => searchOf(q).catch(() => null))));
  for (const t of themes) {
    const queries = FILL[t] || [];
    for (const q of queries) {
      if ((count[t] || 0) >= perTheme || picked.size >= cfg.limit) break;
      let hits = [];
      try {
        hits = (await searchOf(q)).hits;
      } catch {
        continue;
      }
      let fromQuery = 0;
      const cap = Math.ceil(perTheme / queries.length) + 1;
      for (const h of hits) {
        if ((count[t] || 0) >= perTheme || fromQuery >= cap) break;
        if ((h.categories || []).some((c) => c === 'library' || c === 'cursed') || h.side?.client === 'unsupported' || OVERHAULS.has(h.slug)) continue;
        // малоизвестные моды не берём: популярность — грубая, но честная мера того, что мод работает у людей
        if ((h.downloads || 0) < 300000) continue;
        if (t !== 'technology' && (/addon|compat|patch|restriction|overhaul|integration|\bfix\b/i.test(h.name) || names().some((n) => normalize(h.name).includes(n)))) continue;
        if (take(h, 'popular:' + t)) {
          count[t] = (count[t] || 0) + 1;
          fromQuery++;
        }
      }
    }
  }
  return { add: [...picked.values()], notFound, already, themes };
}

/**
 * Пары «версия игры + загрузчик» для новой сборки, лучшие первыми: под какую пару есть больше известных
 * модов тем (и основы). При равенстве — новее версия, затем Fabric, NeoForge, Forge. Пустой список — нет пары.
 * versions — версии Minecraft от новой к старой; supported(loader) → Set версий или null (неизвестно).
 */
async function rankTargets({ intent, wishes, provider, versions, supported }) {
  const loaderList = wishes.loader ? [wishes.loader] : ['fabric', 'neoforge', 'forge'];
  const mcs = wishes.minecraft ? [wishes.minecraft] : [...new Set(versions)];
  const groups = [...themesOf(intent, true).flatMap((t) => (RECIPES[t] || []).map((g) => ({ g, w: 3 }))), ...BASE.performance.map((g) => ({ g, w: 1 })), ...BASE.qol.map((g) => ({ g, w: 1 }))];
  const projects = await projectMap(provider, groups.flatMap((x) => x.g));
  const all = [];
  for (const loader of loaderList) {
    let sup = null;
    try {
      sup = await supported(loader);
    } catch {}
    for (const minecraft of mcs) {
      if (sup && !sup.has(minecraft)) continue;
      // NeoForge до 1.20.2 — ответвление Forge: моды под 1.20.1 выпускают для Forge, хотя каталог пишет оба
      if (loader === 'neoforge' && !wishes.loader && /^1\.((1?\d)(\.\d+)?|20(\.1)?)$/.test(minecraft)) continue;
      const target = { minecraft, loader };
      const score = groups.reduce((a, { g, w }) => a + (g.some((s) => projects.get(s) && fits(projects.get(s), target)) ? w : 0), 0);
      if (score > 0) all.push({ ...target, score, rank: mcs.indexOf(minecraft) * 10 + loaderList.indexOf(loader) });
    }
  }
  return all.sort((a, b) => b.score - a.score || a.rank - b.rank).map(({ minecraft, loader }) => ({ minecraft, loader }));
}

/** Какие из явно добавляемых модов виноваты в ошибке плана (сам мод или тот, кому нужна сломанная зависимость). */
function culprits(plan, err, explicit) {
  if (!err.key) return [];
  const mods = new Map((plan.nextLock?.mods || []).map((m) => [m.key, m]));
  const up = (k, seen) => {
    if (seen.has(k)) return [];
    seen.add(k);
    if (explicit.has(k)) return [k];
    return [...mods.values()].filter((m) => m.dependencies?.some((d) => d.key === k && d.kind === 'required')).flatMap((m) => up(m.key, seen));
  };
  if (err.code !== 'CONFLICT') return up(err.key, new Set());
  // конфликт — убираем один мод из пары: тот, что в подборке дальше (добор менее важен основы и рецептов)
  const pair = [err.key, ...(mods.get(err.key)?.dependencies || []).filter((d) => d.kind === 'incompatible' && mods.has(d.key)).map((d) => d.key)];
  const order = [...explicit.keys()];
  const list = [...new Set(pair.flatMap((k) => up(k, new Set())))].sort((a, b) => order.indexOf(b) - order.indexOf(a));
  return list.slice(0, 1);
}

const NET = ['NETWORK', 'RATE_LIMIT'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * План с отсевом: моды, которые не прошли проверку (нет релиза, конфликт, сломанная зависимость),
 * убираются из подборки, и план строится заново. Сбой сети — пауза и повтор, моды не выкидываются.
 * makePlan(request) → полный план (с nextLock). → { plan, items, dropped }
 */
async function planPruned(makePlan, add, { waitMs = 5000 } = {}) {
  let items = [...add];
  const dropped = [];
  const choices = {};
  let plan = null;
  let request = null;
  let netTries = 0;
  for (let round = 0; round < 8; round++) {
    request = { add: items.map((a) => ({ source: a.source, projectId: a.id })), choices: { ...choices } };
    plan = await makePlan(request);
    if (plan.ok || !items.length) break;
    if (plan.errors.some((e) => NET.includes(e.code))) {
      if (++netTries > 3) break;
      await sleep(waitMs * netTries);
      continue;
    }
    for (const q of plan.questions || []) choices[q.key] = 'skip';
    const explicit = new Map(items.map((a) => [keyOf(a.source, a.id), a]));
    const bad = new Map();
    for (const e of plan.errors) for (const k of culprits(plan, e, explicit)) if (!bad.has(k)) bad.set(k, e.message);
    if (!bad.size && !(plan.questions || []).length) break;
    const next = [];
    for (const a of items) {
      const k = keyOf(a.source, a.id);
      if (!bad.has(k)) {
        next.push(a);
        continue;
      }
      // не прошёл проверку — ставим замену той же роли (JEI → EMI), если она есть
      const [alt, ...rest] = a.alts || [];
      dropped.push({ ...a, why: bad.get(k), replacedBy: alt?.name || null });
      if (alt) next.push({ source: a.source, id: alt.id, slug: alt.slug, name: alt.name, reason: a.reason, alts: rest });
    }
    items = next;
  }
  // request — с ним план строился в последний раз (нужен, чтобы перестроить его после проверки файлов)
  return { plan, items, dropped, request };
}

/** Заранее и параллельно загрузить релизы модов в кэш каталога: план потом идёт по ним без ожидания сети. */
async function prefetch(provider, items, target, parallel = 6) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift();
      await provider.versions(a.id, target).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
}

/**
 * Память и настройки графики под ПК и размер сборки. Это стартовые значения, а не замер.
 * fps — игрок просит поднять FPS: дальность и графика только снижаются, а не растут под мощный ПК.
 */
function gameSetup({ totalGb, reserveGb, mods, lowEnd = false, fps = false }) {
  const max = Math.max(2, totalGb - reserveGb);
  const want = mods <= 15 ? 3 : mods <= 50 ? 5 : mods <= 90 ? 6 : 8;
  const ram = Math.max(2, Math.min(want, max));
  const weak = lowEnd || totalGb <= 6;
  // видеокарту лаунчер не знает — дальность умеренная; большая сборка и так нагружает игру
  let render = weak ? 6 : totalGb <= 8 || mods > 60 ? 8 : totalGb <= 16 || mods > 30 ? 10 : 12;
  if (fps) render = Math.min(render, 8);
  const simulation = weak ? 5 : Math.min(render, fps ? 6 : 10);
  return { ram, options: { render, simulation, fps: weak && !fps ? 60 : 120, graphics: weak || fps ? 0 : 1 } };
}

module.exports = { BASE, RECIPES, RIVALS, SIZES, THEME_RU, fits, buildWishes, buildName, pickMods, rankTargets, culprits, planPruned, prefetch, gameSetup };
