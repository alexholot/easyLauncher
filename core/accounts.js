'use strict';
// Хранение аккаунта Microsoft и выдача токена для запуска игры.
const fs = require('fs');
const path = require('path');
const auth = require('./auth');

class Accounts {
  /**
   * root — папка лаунчера; vault — {encrypt(str)→Buffer|str, decrypt(Buffer)→str, available}
   * (в Electron это safeStorage, токены на диске зашифрованы средствами ОС).
   */
  constructor(root, vault) {
    this.file = path.join(root, 'accounts.json');
    this.vault = vault;
    this.data = { clientId: '', account: null };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {}
    this.secret = null;
    if (this.data.account?.secret) {
      try {
        this.secret = JSON.parse(this.vault.decrypt(Buffer.from(this.data.account.secret, 'base64')));
      } catch {
        this.data.account = null;
      }
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  get clientId() {
    return this.data.clientId || require('./defaults').DEFAULTS.msClientId;
  }

  setClientId(id) {
    id = String(id || '').trim();
    if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error('Client ID — это GUID вида 00000000-0000-0000-0000-000000000000.');
    this.data.clientId = id;
    this.save();
  }

  /** Публичные данные для интерфейса (без токенов). */
  status() {
    const a = this.data.account;
    return {
      clientId: this.clientId,
      secure: this.vault.available,
      account: a ? { type: 'msa', name: a.name, uuid: a.uuid, skin: a.skin || null } : null,
    };
  }

  store(ms, mc) {
    this.secret = {
      refreshToken: ms.refresh_token || this.secret?.refreshToken,
      mcToken: mc.accessToken,
      expiresAt: mc.expiresAt,
      xuid: mc.xuid,
    };
    this.data.account = {
      name: mc.name,
      uuid: mc.uuid,
      skin: mc.skin,
      secret: Buffer.from(this.vault.encrypt(JSON.stringify(this.secret))).toString('base64'),
    };
    this.save();
  }

  /** Завершить вход: код из окна Microsoft → профиль Minecraft. */
  async completeLogin(code, verifier) {
    const ms = await auth.exchangeCode(this.clientId, code, verifier);
    const mc = await auth.minecraftLogin(ms.access_token);
    this.store(ms, mc);
    return this.status();
  }

  logout() {
    this.data.account = null;
    this.secret = null;
    this.save();
  }

  /** Данные для запуска: обновляет токен Minecraft, если он истекает. null — офлайн-профиль. */
  async launchAuth() {
    const a = this.data.account;
    if (!a || !this.secret) return null;
    if (!this.secret.mcToken || this.secret.expiresAt - Date.now() < 10 * 60 * 1000) {
      if (!this.secret.refreshToken) throw new Error('Сессия Microsoft истекла. Войди снова в профиле.');
      let ms;
      try {
        ms = await auth.refreshMs(this.clientId, this.secret.refreshToken);
      } catch (e) {
        if (e.relogin) this.logout();
        throw e;
      }
      const mc = await auth.minecraftLogin(ms.access_token);
      this.store(ms, mc);
    }
    return {
      type: 'msa',
      name: this.data.account.name,
      uuid: this.data.account.uuid,
      accessToken: this.secret.mcToken,
      xuid: this.secret.xuid || '',
      clientId: this.clientId,
    };
  }
}

module.exports = { Accounts };
