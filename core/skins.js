'use strict';
// Гардероб: локальная галерея скинов игрока, скин и плащи аккаунта Microsoft.
// Файлы скинов живут в <корень>/skins; окно получает только пути внутри этой папки (показ через easyimg://).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const http = require('./http');
const { readJson, writeJson } = require('./store');

const PROFILE_API = 'https://api.minecraftservices.com/minecraft/profile';
const MODELS = ['classic', 'slim'];
const MAX_ITEMS = 60;
const MAX_BYTES = 512 * 1024;

const fail = (code, message, action) => Object.assign(new Error(message), { code, action });

/**
 * Размер PNG по заголовку IHDR. null — это не PNG.
 * Скин Minecraft — 64×64 (с 1.8) или 64×32 (старый формат); HD-скины 128/256/512 игра без модов не показывает.
 */
function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (sig.some((b, i) => buf[i] !== b) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function checkSkin(buf) {
  if (buf.length > MAX_BYTES) throw fail('SKIN_BAD', 'Файл скина больше 512 КБ.', 'Скин — маленькая картинка PNG 64×64.');
  const s = pngSize(buf);
  if (!s) throw fail('SKIN_BAD', 'Это не картинка PNG.', 'Скин Minecraft — файл .png размером 64×64.');
  if (s.width !== 64 || (s.height !== 64 && s.height !== 32))
    throw fail('SKIN_BAD', `Картинка ${s.width}×${s.height}, а скин Minecraft — 64×64 (или старый 64×32).`, 'Выбери другой файл скина.');
  return s;
}

/** Ссылки на текстуры приходят с http:// — качаем только с серверов Mojang и только по https. */
function textureUrl(u) {
  const m = /^https?:\/\/textures\.minecraft\.net\/texture\/([0-9a-f]{20,80})$/i.exec(u || '');
  return m ? `https://textures.minecraft.net/texture/${m[1]}` : null;
}

class Skins {
  constructor(root) {
    this.dir = path.join(root, 'skins');
    this.indexFile = path.join(this.dir, 'skins.json');
    this.write = Promise.resolve();
  }

  async index() {
    const d = (await readJson(this.indexFile)) || {};
    const items = (Array.isArray(d.items) ? d.items : []).filter((x) => x && /^[\w-]{6,40}$/.test(x.id) && fs.existsSync(this.file(x.id)));
    return { items, active: items.some((x) => x.id === d.active) ? d.active : null };
  }

  file(id) {
    return path.join(this.dir, id + '.png');
  }

  /** Изменения индекса — по очереди: два быстрых клика не теряют запись. */
  change(fn) {
    const next = this.write.catch(() => {}).then(async () => {
      const idx = await this.index();
      const r = await fn(idx);
      await writeJson(this.indexFile, idx);
      return r;
    });
    this.write = next;
    return next;
  }

  async list() {
    const idx = await this.index();
    return { active: idx.active, items: idx.items.map((x) => ({ ...x, file: this.file(x.id) })) };
  }

  /** Добавить скин из байтов (перетаскивание в окно) или из файла (диалог выбора). */
  async add({ name, model, bytes }) {
    const buf = Buffer.from(bytes || []);
    checkSkin(buf);
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    return this.change(async (idx) => {
      const same = idx.items.find((x) => x.sha1 === hash);
      if (same) return { ...same, file: this.file(same.id), duplicate: true };
      if (idx.items.length >= MAX_ITEMS) throw fail('SKINS_FULL', `В гардеробе уже ${MAX_ITEMS} скинов.`, 'Удали ненужные, чтобы добавить новый.');
      const item = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        name: String(name || 'Скин').replace(/\.png$/i, '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40) || 'Скин',
        model: MODELS.includes(model) ? model : 'classic',
        sha1: hash,
        added: new Date().toISOString(),
      };
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(this.file(item.id), buf);
      idx.items.unshift(item);
      return { ...item, file: this.file(item.id) };
    });
  }

  /** Байты скина или плаща для 3D-просмотра: только PNG из папки гардероба. */
  async read(file) {
    const rel = path.relative(this.dir, path.resolve(String(file || '')));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !/\.png$/i.test(rel)) throw new Error('Файл не из гардероба.');
    return fsp.readFile(path.join(this.dir, rel));
  }

  async addFile(file) {
    if (!/\.png$/i.test(file || '')) throw fail('SKIN_BAD', 'Скин — файл .png.', 'Выбери картинку PNG 64×64.');
    const st = await fsp.stat(file);
    if (st.size > MAX_BYTES) throw fail('SKIN_BAD', 'Файл скина больше 512 КБ.', 'Скин — маленькая картинка PNG 64×64.');
    return this.add({ name: path.basename(file), bytes: await fsp.readFile(file) });
  }

  async update(id, patch = {}) {
    return this.change(async (idx) => {
      const it = idx.items.find((x) => x.id === id);
      if (!it) throw fail('SKIN_MISSING', 'Такого скина нет в гардеробе.');
      if (patch.name !== undefined) it.name = String(patch.name).replace(/[\r\n\t]/g, ' ').trim().slice(0, 40) || it.name;
      if (patch.model !== undefined) {
        if (!MODELS.includes(patch.model)) throw new Error('Модель — classic или slim.');
        it.model = patch.model;
      }
      if (patch.favorite !== undefined) it.favorite = patch.favorite === true;
      return { ...it, file: this.file(it.id) };
    });
  }

  async remove(id) {
    return this.change(async (idx) => {
      const i = idx.items.findIndex((x) => x.id === id);
      if (i < 0) return false;
      idx.items.splice(i, 1);
      if (idx.active === id) idx.active = null;
      await fsp.rm(this.file(id), { force: true });
      return true;
    });
  }

  /**
   * Надеть скин. С аккаунтом Microsoft скин загружается в профиль Minecraft — его видят на всех серверах.
   * Без входа он только выбран в лаунчере: игра без входа показывает стандартный скин.
   */
  async apply(id, auth) {
    const { items } = await this.index();
    const it = items.find((x) => x.id === id);
    if (!it) throw fail('SKIN_MISSING', 'Такого скина нет в гардеробе.');
    let uploaded = false;
    if (auth?.accessToken) {
      const form = new FormData();
      form.append('variant', it.model);
      form.append('file', new Blob([await fsp.readFile(this.file(id))], { type: 'image/png' }), 'skin.png');
      try {
        await http.api(PROFILE_API + '/skins', { method: 'POST', headers: { Authorization: 'Bearer ' + auth.accessToken }, body: form });
      } catch (e) {
        if (e.status === 401) throw fail('AUTH_REQUIRED', 'Сессия Microsoft истекла.', 'Войди снова и повтори.');
        if (e.status === 429) throw fail('SKIN_LIMIT', 'Mojang просит подождать: скин меняли слишком часто.', 'Попробуй через минуту.');
        if (e.status === 400) throw fail('SKIN_BAD', 'Mojang не принял этот скин.', 'Проверь, что картинка — обычный скин 64×64.');
        throw fail('SKIN_NET', 'Не удалось загрузить скин в профиль Minecraft: ' + e.message, 'Проверь интернет и повтори.');
      }
      uploaded = true;
    }
    await this.change(async (idx) => void (idx.active = id));
    return { uploaded };
  }

  /** Скин и плащи аккаунта: текстуры скачиваются в папку гардероба, чтобы окно показывало их без сети. */
  async account(auth) {
    if (!auth?.accessToken) return null;
    let p;
    try {
      p = await http.api(PROFILE_API, { headers: { Authorization: 'Bearer ' + auth.accessToken } });
    } catch (e) {
      if (e.status === 401) throw fail('AUTH_REQUIRED', 'Сессия Microsoft истекла.', 'Войди снова.');
      throw fail('SKIN_NET', 'Профиль Minecraft не загрузился: ' + e.message, 'Проверь интернет.');
    }
    const dir = path.join(this.dir, 'account');
    const fetchTex = async (url, name) => {
      const u = textureUrl(url);
      if (!u) return null;
      const dest = path.join(dir, name + '-' + u.split('/').pop().slice(0, 16) + '.png');
      if (!fs.existsSync(dest)) await http.download(u, dest);
      return dest;
    };
    const skin = (p.skins || []).find((s) => s.state === 'ACTIVE');
    const capes = [];
    for (const c of (p.capes || []).slice(0, 40)) {
      if (!/^[\w-]{1,64}$/.test(c.id || '')) continue;
      const file = await fetchTex(c.url, 'cape').catch(() => null);
      if (file) capes.push({ id: c.id, alias: String(c.alias || 'Плащ').slice(0, 40), active: c.state === 'ACTIVE', file });
    }
    return {
      name: p.name,
      skin: skin ? { file: await fetchTex(skin.url, 'skin').catch(() => null), model: skin.variant === 'SLIM' ? 'slim' : 'classic' } : null,
      capes,
    };
  }

  /** Сделать плащ активным (или снять — capeId null). */
  async setCape(capeId, auth) {
    if (!auth?.accessToken) throw fail('AUTH_REQUIRED', 'Плащи есть только у аккаунта Microsoft.', 'Войди через Microsoft.');
    if (capeId !== null && !/^[\w-]{1,64}$/.test(capeId || '')) throw new Error('Неизвестный плащ.');
    const headers = { Authorization: 'Bearer ' + auth.accessToken };
    try {
      if (capeId) await http.api(PROFILE_API + '/capes/active', { method: 'PUT', headers, json: { capeId } });
      else await http.api(PROFILE_API + '/capes/active', { method: 'DELETE', headers });
    } catch (e) {
      if (e.status === 401) throw fail('AUTH_REQUIRED', 'Сессия Microsoft истекла.', 'Войди снова.');
      throw fail('SKIN_NET', 'Плащ не сменился: ' + e.message, 'Проверь интернет и повтори.');
    }
    return true;
  }
}

module.exports = { Skins, pngSize, checkSkin, textureUrl };
