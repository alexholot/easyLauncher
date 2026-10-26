'use strict';
// Локальная имитация Modrinth API, прокси CurseForge и CDN для тестов каталога и установщика.
// Форматы ответов повторяют схемы официальных API (по типам @xmcl/modrinth и @xmcl/curseforge).
const http = require('http');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

function fabricJar(id, environment = '*') {
  const z = new AdmZip();
  z.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', environment })));
  z.addFile(`${id}/Main.class`, Buffer.from('cafebabe' + id));
  return z.toBuffer();
}
function forgeJar(id) {
  const z = new AdmZip();
  z.addFile('META-INF/mods.toml', Buffer.from(`[[mods]]\nmodId="${id}"\n`));
  return z.toBuffer();
}
const sha = (b, a) => crypto.createHash(a).update(b).digest('hex');

function createMock() {
  const files = {}; // name → Buffer
  const opts = { cfAuthFail: false, dropOnce: new Set(), corrupt: new Set(), requests: [] };
  let base = '';

  function file(name, buf) {
    files[name] = buf;
    return { filename: name, url: `${base}/cdn/${name}`, size: buf.length, hashes: { sha1: sha(buf, 'sha1'), sha512: sha(buf, 'sha512') } };
  }

  const mr = { projects: {}, versions: {} };
  function mrProject(id, slug, title, client, server, extra = {}) {
    mr.projects[id] = { id, slug, title, description: title + ' description', client_side: client, server_side: server, project_type: 'mod', categories: ['fabric'], game_versions: ['1.21.1'], icon_url: null, ...extra };
  }
  function mrVersion(id, projectId, number, { mc = ['1.21.1'], loaders = ['fabric'], type = 'release', deps = [], buf, env, published = '2026-09-01T00:00:00Z' }) {
    const f = file(`${projectId}-${number}.jar`, buf);
    mr.versions[id] = {
      id,
      project_id: projectId,
      name: number,
      version_number: number,
      version_type: type,
      game_versions: mc,
      loaders,
      date_published: published,
      environment: env,
      files: [{ ...f, primary: true }],
      dependencies: deps,
    };
  }

  const cf = { mods: {}, files: {} };
  function cfMod(id, name, { allow = true } = {}) {
    cf.mods[id] = { id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), summary: name, authors: [{ name: 'author' }], logo: null, links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${id}` }, categories: [], downloadCount: 10, dateModified: '2026-09-01', allowModDistribution: allow, latestFilesIndexes: [] };
  }
  function cfFile(id, modId, name, { buf, gv = ['1.21.1', 'Fabric'], deps = [], releaseType = 1 }) {
    const f = file(`cf-${id}-${name}.jar`, buf);
    const allow = cf.mods[modId].allowModDistribution !== false;
    cf.files[id] = {
      id,
      modId,
      displayName: name,
      fileName: f.filename,
      releaseType,
      fileDate: '2026-09-01T00:00:00Z',
      fileLength: f.size,
      hashes: [{ value: f.hashes.sha1, algo: 1 }, { value: 'md5', algo: 2 }],
      downloadUrl: allow ? f.url : null,
      gameVersions: gv,
      dependencies: deps,
      isAvailable: true,
    };
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    opts.requests.push(req.method + ' ' + u.pathname);
    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    // ---- CDN с поддержкой Range ----
    if (u.pathname.startsWith('/cdn/')) {
      const name = decodeURIComponent(u.pathname.slice(5));
      let buf = files[name];
      if (!buf) return json(404, {});
      if (opts.corrupt.has(name)) buf = Buffer.concat([buf.subarray(0, buf.length - 1), Buffer.from([buf[buf.length - 1] ^ 1])]);
      const range = req.headers.range && /bytes=(\d+)-/.exec(req.headers.range);
      const start = range ? Number(range[1]) : 0;
      res.writeHead(range ? 206 : 200, { 'Content-Length': buf.length - start, 'Accept-Ranges': 'bytes' });
      if (opts.dropOnce.has(name) && !range) {
        // обрыв посреди файла
        opts.dropOnce.delete(name);
        res.write(buf.subarray(0, Math.floor(buf.length / 2)));
        return setTimeout(() => res.destroy(), 20);
      }
      return res.end(buf.subarray(start));
    }
    // ---- Modrinth ----
    let m;
    if (u.pathname === '/mr/search') {
      const q = (u.searchParams.get('query') || '').toLowerCase();
      const facets = JSON.parse(u.searchParams.get('facets') || '[]').flat();
      const hits = Object.values(mr.projects)
        .filter((p) => !q || p.title.toLowerCase().includes(q))
        .filter((p) => facets.every((f) => !f.startsWith('versions:') || p.game_versions.includes(f.slice(9))))
        .map((p) => ({ ...p, project_id: p.id, author: 'dev', versions: p.game_versions, display_categories: p.categories }));
      return json(200, { hits, total_hits: hits.length, offset: 0, limit: 20 });
    }
    if (u.pathname === '/mr/tag/category') return json(200, [{ name: 'adventure', project_type: 'mod', header: 'categories' }, { name: 'technology', project_type: 'mod', header: 'categories' }]);
    if ((m = u.pathname.match(/^\/mr\/project\/([^/]+)\/version$/))) {
      const p = Object.values(mr.projects).find((x) => x.id === m[1] || x.slug === m[1]);
      if (!p) return json(404, {});
      const gv = u.searchParams.get('game_versions') && JSON.parse(u.searchParams.get('game_versions'));
      const ld = u.searchParams.get('loaders') && JSON.parse(u.searchParams.get('loaders'));
      return json(200, Object.values(mr.versions).filter((v) => v.project_id === p.id && (!gv || v.game_versions.some((x) => gv.includes(x))) && (!ld || v.loaders.some((x) => ld.includes(x)))));
    }
    if ((m = u.pathname.match(/^\/mr\/project\/([^/]+)$/))) {
      const p = Object.values(mr.projects).find((x) => x.id === m[1] || x.slug === m[1]);
      return p ? json(200, p) : json(404, {});
    }
    if ((m = u.pathname.match(/^\/mr\/version\/([^/]+)$/))) return mr.versions[m[1]] ? json(200, mr.versions[m[1]]) : json(404, {});
    // ---- CurseForge (через прокси сервера easyLauncher) ----
    if (u.pathname.startsWith('/cf/')) {
      if (opts.cfAuthFail) return json(403, { error: 'forbidden' });
      if (u.pathname === '/cf/v1/mods/search') {
        const q = (u.searchParams.get('searchFilter') || '').toLowerCase();
        const data = Object.values(cf.mods).filter((x) => !q || x.name.toLowerCase().includes(q));
        return json(200, { data, pagination: { totalCount: data.length } });
      }
      if (u.pathname === '/cf/v1/categories') return json(200, { data: [{ id: 412, name: 'Technology' }] });
      if ((m = u.pathname.match(/^\/cf\/v1\/mods\/(\d+)\/files\/(\d+)$/))) return cf.files[m[2]] ? json(200, { data: cf.files[m[2]] }) : json(404, {});
      if ((m = u.pathname.match(/^\/cf\/v1\/mods\/(\d+)\/files$/))) {
        const gv = u.searchParams.get('gameVersion');
        return json(200, { data: Object.values(cf.files).filter((f) => String(f.modId) === m[1] && (!gv || f.gameVersions.includes(gv))) });
      }
      if ((m = u.pathname.match(/^\/cf\/v1\/mods\/(\d+)$/))) return cf.mods[m[1]] ? json(200, { data: cf.mods[m[1]] }) : json(404, {});
    }
    json(404, { error: 'not found' });
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      const fabricApi = fabricJar('fabric-api');
      // Modrinth
      mrProject('P_FAPI', 'fabric-api', 'Fabric API', 'required', 'required');
      mrVersion('V_FAPI', 'P_FAPI', '0.116.0', { buf: fabricApi });
      mrProject('P_SOD', 'sodium', 'Sodium', 'required', 'unsupported');
      mrVersion('V_SOD', 'P_SOD', '0.8.13', { buf: fabricJar('sodium', 'client'), env: 'client_only' });
      mrProject('P_CREATE', 'create-fabric', 'Create Fabric', 'required', 'required');
      mrVersion('V_CREATE', 'P_CREATE', '6.0.0', { buf: fabricJar('create'), deps: [{ project_id: 'P_FAPI', dependency_type: 'required' }, { project_id: 'P_BAD', dependency_type: 'incompatible' }] });
      mrVersion('V_CREATE_OLD', 'P_CREATE', '5.0.0', { buf: fabricJar('create5'), published: '2026-01-01T00:00:00Z' });
      mrProject('P_OLD', 'oldmod', 'Old Mod', 'required', 'required', { game_versions: ['1.20.1'] });
      mrVersion('V_OLD', 'P_OLD', '1.0', { mc: ['1.20.1'], buf: fabricJar('oldmod') });
      mrProject('P_BETA', 'betamod', 'Beta Mod', 'required', 'required');
      mrVersion('V_BETA', 'P_BETA', '0.1-beta', { type: 'beta', buf: fabricJar('betamod') });
      mrProject('P_BAD', 'badmod', 'Bad Mod', 'required', 'required');
      mrVersion('V_BAD', 'P_BAD', '1.0', { buf: fabricJar('badmod') });
      mrProject('P_FORGE', 'forgeonly', 'Forge Only', 'required', 'required');
      mrVersion('V_FORGE_LIE', 'P_FORGE', '1.0', { buf: forgeJar('forgeonly') }); // заявлен как fabric, внутри — forge
      // CurseForge
      cfMod(1001, 'Just Enough Items');
      cfMod(1002, 'JEI Library');
      cfFile(5001, 1001, 'jei-19.0', { buf: fabricJar('jei'), deps: [{ modId: 1002, relationType: 3 }] });
      cfFile(5002, 1002, 'jeilib-1.0', { buf: fabricJar('jeilib') });
      cfMod(2001, 'Blocked Mod', { allow: false });
      cfFile(6001, 2001, 'blocked-1.0', { buf: fabricJar('blocked') });
      cfMod(3001, 'Sodium');
      cfFile(7001, 3001, 'sodium-cf', { buf: fabricJar('sodium-cf', 'client') });
      cfMod(3002, 'Fabric API');
      cfFile(7002, 3002, 'fabric-api-cf', { buf: fabricApi }); // тот же файл, что на Modrinth
      resolve({ server, base: () => base, opts, files, cf, mr, addMrVersion: mrVersion, fabricJar, blockedBuf: () => files['cf-6001-blocked-1.0.jar'], close: () => server.close() });
    }),
  );
}

module.exports = { createMock, fabricJar };
