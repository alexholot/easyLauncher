'use strict';
// Fabric Loader: профиль клиента и лаунчер сервера с meta.fabricmc.net.
const path = require('path');
const fs = require('fs');
const http = require('./http');

const META = 'https://meta.fabricmc.net/v2';

async function latestLoader(mc, { signal } = {}) {
  const list = await http.json(`${META}/versions/loader/${encodeURIComponent(mc)}`, { signal });
  if (!Array.isArray(list) || !list.length) throw new Error('Fabric пока не поддерживает Minecraft ' + mc + '.');
  return (list.find((x) => x.loader.stable) || list[0]).loader.version;
}

/** Установить профиль Fabric рядом с версиями Mojang. Возвращает id профиля. */
async function installClientProfile(mojang, mc, { signal, loader } = {}) {
  // Без сети используем уже установленный профиль
  const local = () => {
    try {
      return fs
        .readdirSync(mojang.versionsDir)
        .filter((d) => d.startsWith('fabric-loader-') && d.endsWith('-' + mc))
        .sort()
        .pop();
    } catch {
      return null;
    }
  };
  try {
    loader = loader || (await latestLoader(mc, { signal }));
  } catch (e) {
    if (e.code === 'CANCELLED') throw e;
    const id = local();
    if (id) return { id, loader: id.split('-')[2] };
    throw e;
  }
  const id = `fabric-loader-${loader}-${mc}`;
  if (!(await mojang.readLocalVersion(id))) {
    const profile = await http.json(
      `${META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`,
      { signal },
    );
    profile.id = id;
    await mojang.saveVersion(profile);
  }
  return { id, loader };
}

/** Серверный лаунчер Fabric: при первом старте сам скачает server.jar и библиотеки. */
async function installServerLauncher(dir, mc, loader, { signal } = {}) {
  const dest = path.join(dir, 'fabric-server-launch.jar');
  const stamp = path.join(dir, '.easylauncher-fabric');
  const want = mc + '|' + loader;
  try {
    if (fs.readFileSync(stamp, 'utf8') === want && fs.existsSync(dest)) return dest;
  } catch {}
  const installers = await http.json(`${META}/versions/installer`, { signal });
  const installer = (installers.find((x) => x.stable) || installers[0]).version;
  await http.retryFs(() => fs.promises.rm(dest, { force: true }), path.basename(dest));
  await http.download(
    `${META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`,
    dest,
    { signal },
  );
  fs.writeFileSync(stamp, want);
  return dest;
}

module.exports = { latestLoader, installClientProfile, installServerLauncher };
