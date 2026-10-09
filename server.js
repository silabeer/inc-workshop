// Сервер воркшопа инцидентов. Без зависимостей: node server.js [порт]
// Источник правды — состояние сессии здесь; браузеры шлют команды и получают по SSE
// каждый своё представление (проектор, роль, ведущий), паки в браузер не уходят.
// Окружение: PORT, HOST, DATA_DIR, GM_PIN.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const E = require('./workshop-engine.js');

const ROOT = __dirname;
const HEARTBEAT_MS = 25000; // прокси и мобильные сети рвут молчащий SSE через 30–60 с
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2' };
const GM_CMDS = ['team', 'start', 'discussion', 'voting', 'revote', 'vote', 'reveal', 'next', 'finish', 'undo', 'release', 'reset'];

function loadPacks(dir, log) {
  const packs = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    let p;
    try { p = require(path.join(dir, f)); } catch (e) { log('пак ' + f + ' не загружается: ' + e.message); continue; }
    const errs = E.validate(p);
    if (errs.length) { log('пак ' + f + ' пропущен: ' + errs[0] + (errs.length > 1 ? ` (и ещё ${errs.length - 1})` : '')); continue; }
    packs.push(p);
  }
  return packs;
}

function lanUrls(port) {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => `http://${i.address}:${port}/#play`);
}

function makeServer(opts = {}) {
  const DATA = process.env.DATA_DIR || ROOT; // каталог состояния и архива (в Docker — том)
  const FILE = opts.file || path.join(DATA, 'state.json');
  const ARCH = opts.archiveDir || path.join(DATA, 'archive');
  const GM_PIN = opts.gmPin !== undefined ? opts.gmPin : (process.env.GM_PIN || '');
  const log = opts.log ? (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a) : () => {};
  const packs = opts.packs || loadPacks(opts.scenariosDir || path.join(ROOT, 'scenarios'), opts.log ? log : console.error);
  if (!packs.length) throw new Error('нет ни одного валидного пака в scenarios/');
  const packById = id => packs.find(p => p.meta.id === id);

  // Восстановление после падения: продолжаем с того же шага.
  let pack = packs[0], session = E.createSession(pack);
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && packById(raw.scenarioId) && raw.session) { pack = packById(raw.scenarioId); session = raw.session; }
  } catch (e) { /* первого запуска state.json нет */ }

  const clients = new Set();
  // Атомарная запись: обрыв питания посреди writeFileSync не оставит битый state.json.
  function persist() {
    const tmp = FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify({ scenarioId: pack.meta.id, session })); fs.renameSync(tmp, FILE); }
    catch (e) { console.error('Не удалось сохранить состояние:', e.message); }
  }
  const catalog = () => packs.map(p => ({ id: p.meta.id, title: p.meta.title, brief: p.meta.brief, difficulty: p.meta.difficulty, etaMin: p.meta.etaMin, steps: p.steps.length }));
  function viewFor(c) {
    const v = E.view(pack, session, c.audience, { role: c.role, token: c.token, now: Date.now() });
    if (c.audience === 'gm') { v.catalog = catalog(); v.gmPin = !!GM_PIN; }
    return v;
  }
  const send = c => c.res.write('data: ' + JSON.stringify(viewFor(c)) + '\n\n');
  function broadcast() { for (const c of clients) send(c); persist(); }

  function archive() {
    if (!session.startedAt) return;
    const s = E.summary(pack, session);
    const at = new Date().toISOString();
    const rec = { at, scenarioId: pack.meta.id, title: pack.meta.title, team: session.team, score: s.score, max: s.max, grade: s.grade.label, complete: s.complete, metrics: s.metrics };
    fs.mkdirSync(ARCH, { recursive: true });
    fs.writeFileSync(path.join(ARCH, at.replace(/[^\w.-]+/g, '-') + '-' + pack.meta.id + '.json'), JSON.stringify({ summary: rec, session }));
  }

  function run(cmd) {
    if (cmd.type === 'reset') {
      const next = packById(cmd.scenarioId || pack.meta.id);
      if (!next) { const e = new Error('Нет такого кейса'); e.userError = true; throw e; }
      archive();
      // Команда и занятые роли переходят в новую партию: люди не перезаходят.
      session = E.createSession(next, { team: session.team, seats: session.seats });
      pack = next;
      return;
    }
    session = E.apply(pack, session, cmd, Date.now());
  }

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const isGm = req => !GM_PIN || req.headers['x-gm-pin'] === GM_PIN;
  function readBody(req, cb) {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { let o; try { o = JSON.parse(b || '{}'); } catch (e) { return cb(null); } cb(o && typeof o === 'object' ? o : null); });
  }
  function exec(res, cmd, who) {
    const before = session.phase;
    try { run(cmd); } catch (e) {
      if (!e.userError) { console.error(e); return json(res, 500, { error: 'Внутренняя ошибка сервера' }); }
      log('отказ', who, cmd.type, e.message);
      return json(res, cmd.type === 'claim' ? 409 : 400, { error: e.message });
    }
    // Журнал для разбора спорных моментов: каждая команда — одна строка в stdout.
    log(who, cmd.type, cmd.role || '', cmd.option || '', before !== session.phase ? before + ' → ' + session.phase : '');
    broadcast();
    json(res, 200, { ok: true });
  }
  function serveFile(res, file) {
    const type = TYPES[path.extname(file)];
    if (!type || !file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    let m;

    if (p === '/healthz') return json(res, 200, { ok: true, scenarioId: pack.meta.id, phase: session.phase, clients: clients.size, gmPin: !!GM_PIN });
    if (p === '/api/info') return json(res, 200, { playUrls: lanUrls(server.address().port), gmPin: !!GM_PIN, title: pack.meta.title });
    if (p === '/api/auth') return json(res, isGm(req) ? 200 : 401, { ok: isGm(req) });

    if (p === '/events') {
      const audience = u.searchParams.get('view');
      if (!['screen', 'play', 'gm'].includes(audience)) return json(res, 400, { error: 'view: screen | play | gm' });
      if (audience === 'gm' && GM_PIN && u.searchParams.get('pin') !== GM_PIN) return json(res, 401, { error: 'Нужен PIN ведущего' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const c = { res, audience, role: u.searchParams.get('role'), token: u.searchParams.get('token') };
      clients.add(c); send(c);
      const hb = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS); hb.unref();
      req.on('close', () => { clearInterval(hb); clients.delete(c); });
      return;
    }

    if (req.method === 'POST' && (p === '/api/claim' || p === '/api/vote' || p === '/api/cmd')) {
      return readBody(req, body => {
        if (!body) return json(res, 400, { error: 'Тело запроса — JSON-объект' });
        if (p === '/api/claim') return exec(res, { type: 'claim', role: body.role, token: body.token }, 'телефон');
        if (p === '/api/vote') {
          if (!body.token || session.seats[body.role] !== body.token) return json(res, 403, { error: 'Роль занята другим устройством' });
          return exec(res, { type: 'vote', role: body.role, option: body.option }, body.role);
        }
        if (!isGm(req)) { log('отказ: неверный PIN', body.type); return json(res, 401, { error: 'Нужен PIN ведущего' }); }
        if (!GM_CMDS.includes(body.type)) return json(res, 400, { error: 'Неизвестная команда' });
        return exec(res, body, 'ведущий');
      });
    }

    // Полный пак — только ведущему: печать карточек для бумажного режима.
    if (p === '/api/pack') {
      if (!isGm(req)) return json(res, 401, { error: 'Нужен PIN ведущего' });
      return json(res, 200, packById(u.searchParams.get('id') || pack.meta.id) || pack);
    }

    if (p === '/archive' && req.method === 'GET') {
      let list = [];
      try {
        list = fs.readdirSync(ARCH).filter(f => f.endsWith('.json'))
          .map(f => { try { return Object.assign({ file: f }, JSON.parse(fs.readFileSync(path.join(ARCH, f), 'utf8')).summary); } catch (e) { return null; } })
          .filter(Boolean).sort((a, b) => b.file.localeCompare(a.file));
      } catch (e) { /* архива ещё нет */ }
      return json(res, 200, list);
    }
    if ((m = p.match(/^\/archive\/([\w.-]+\.json)$/))) {
      const f = path.resolve(ARCH, m[1]);
      if (!f.startsWith(path.resolve(ARCH) + path.sep) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }

    if (p === '/' || p === '/index.html') return serveFile(res, path.join(ROOT, 'index.html'));
    if (p === '/theme.css') return serveFile(res, path.join(ROOT, 'theme.css'));
    if ((m = p.match(/^\/(fonts|ui)\/([\w.-]+)$/))) return serveFile(res, path.join(ROOT, m[1], m[2]));
    res.writeHead(404); res.end();
  });

  // Закрывает SSE-потоки и все соединения (Node 18 сам не рвёт keep-alive и оборванные клиентом SSE), иначе server.close() ждёт их.
  const close = server.close.bind(server);
  server.close = cb => {
    for (const c of clients) c.res.end();
    clients.clear();
    const r = close(cb);
    if (server.closeAllConnections) server.closeAllConnections();
    return r;
  };
  return server;
}

if (require.main === module) {
  const PORT = +(process.argv[2] || process.env.PORT || 8085);
  const HOST = process.env.HOST || '0.0.0.0';
  const server = makeServer({ log: true });
  server.listen(PORT, HOST, () => {
    console.log('Воркшоп инцидентов запущен.');
    console.log('  Проектор:        http://localhost:' + PORT + '/#screen');
    console.log('  Пульт ведущего:  http://localhost:' + PORT + '/#gm');
    lanUrls(PORT).forEach(url => console.log('  Телефоны ролей:  ' + url));
    console.log('Состояние: state.json (рестарт продолжит с того же шага). Архив партий: archive/.');
    console.log(process.env.GM_PIN ? 'Пульт защищён PIN (GM_PIN).' : 'Пульт открыт всем в сети. Чтобы защитить: GM_PIN=4821 npm start');
  });
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

module.exports = { makeServer, loadPacks };
