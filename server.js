// Сервер воркшопа инцидентов. Без зависимостей: node server.js [порт]
// Источник правды — состояние партий здесь; браузеры шлют команды и получают по SSE
// каждый своё представление (проектор, роль, зритель, ведущий), паки в браузер не уходят.
// Несколько партий одновременно — комнаты: /r/<комната>/ (комната main — на корне /).
// Окружение: PORT, HOST, DATA_DIR, GM_PIN, TLS_CERT, TLS_KEY, TRUST_PROXY, PUBLIC_URL, AUDIENCE_PER_IP, SSE_PER_IP.
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const E = require('./workshop-engine.js');
const { aggregate } = require('./analytics.js');

const ROOT = __dirname;
const HEARTBEAT_MS = 25000; // прокси и мобильные сети рвут молчащий SSE через 30–60 с
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2' };
const GM_CMDS = ['team', 'start', 'discussion', 'voting', 'revote', 'vote', 'reveal', 'next', 'finish', 'undo', 'release', 'reset', 'shuffle', 'sound', 'joinCode', 'note'];
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_ROOMS = 20;
const CODE_RE = /^[A-Za-z0-9]{4,12}$/;
// Защита от перебора PIN и кода входа: после FAIL_MAX неудач за FAIL_WINDOW_MS адрес ждёт FAIL_WINDOW_MS.
const FAIL_MAX = 10, FAIL_WINDOW_MS = 10 * 60 * 1000, FAIL_TABLE_MAX = 10000;
// Лимиты на адрес настраиваются под площадку: вся Wi-Fi зала часто выходит одним адресом (NAT).
const envInt = (name, def) => (/^\d+$/.test(process.env[name] || '') ? +process.env[name] : def);
const AUDIENCE_PER_IP = envInt('AUDIENCE_PER_IP', 250); // голосов зала с одного адреса за шаг: зал за одним NAT проходит, скрипт — нет
const SSE_PER_IP = envInt('SSE_PER_IP', 400), SSE_TOTAL = 3000; // потолок потоков: дешёвый DoS сотнями соединений не проходит
const SSE_MAX_BUFFER = 1 << 20;      // клиент, не читающий поток (больше 1 МБ в очереди), отключается
// Команд в секунду (кроме голосов зала): на устройство или сессию ведущего — люди столько не нажимают;
// на адрес — общий потолок, чтобы столы за одним NAT не мешали друг другу.
const CMD_PER_CLIENT = 20, CMD_PER_IP = 200, CMD_WINDOW_MS = 1000;
const AUDIENCE_BROADCAST_MS = 300;   // голоса зала рассылаются пачкой, а не на каждый голос
const SHUTDOWN_GRACE_MS = 3000;      // остановка: столько ждём незавершённые запросы, потом рвём соединения
// Секреты — в cookie, а не в адресе: адреса SSE-потоков попадают в журналы прокси.
const GM_COOKIE = 'incw_gm', DEVICE_COOKIE = 'incw_dev';
const GM_SESSION_MS = 12 * 60 * 60 * 1000, DEVICE_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[\w-]{8,64}$/;   // переносимый старый токен телефона
const COOKIE_TOKEN_RE = /^[\w-]{1,64}$/;
// Политика безопасности: всё своё, без внешних скриптов и встраивания в чужие страницы.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function loadPacks(dir, log) {
  const packs = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    let p;
    try { p = require(path.join(dir, f)); } catch (e) { log('пак ' + f + ' не загружается: ' + e.message); continue; }
    const errs = E.validate(p);
    if (errs.length) { log('пак ' + f + ' пропущен: ' + errs[0] + (errs.length > 1 ? ` (и ещё ${errs.length - 1})` : '')); continue; }
    packs.push(p);
  }
  // В каталоге — от лёгких к сложным: первым ведущий видит кейс для первого знакомства.
  const rank = d => ['лёгкая', 'средняя', 'высокая'].indexOf(d) + 1 || 9;
  return packs.sort((a, b) => rank(a.meta.difficulty) - rank(b.meta.difficulty) || a.meta.title.localeCompare(b.meta.title, 'ru'));
}

function lanUrls(port, scheme, room) {
  const suffix = (room && room !== 'main' ? '/r/' + room + '/' : '/') + '#play';
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => `${scheme}://${i.address}:${port}${suffix}`);
}

function parseTrust(v) {
  if (v === true || v === '1') return 'private';
  if (!v) return null;
  const list = String(v).split(',').map(x => x.trim()).filter(Boolean);
  return list.length ? list : null;
}
const bareIp = ip => String(ip || '').replace(/^::ffff:/, '');
const privateIp = ip => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip);

function userError(msg) { const e = new Error(msg); e.userError = true; return e; }

function makeServer(opts = {}) {
  const DATA = process.env.DATA_DIR || ROOT; // каталог состояния и архива (в Docker — том)
  const FILE = opts.file || path.join(DATA, 'state.json');
  const ARCH = opts.archiveDir || path.join(DATA, 'archive');
  const GM_PIN = opts.gmPin !== undefined ? opts.gmPin : (process.env.GM_PIN || '');
  // Каким прокси верить: '1' — соседям по хосту и частной сети (прокси рядом, в Docker-сети), иначе список адресов.
  const TRUST_PROXY = parseTrust(opts.trustProxy !== undefined ? opts.trustProxy : process.env.TRUST_PROXY);
  // Публичный адрес (игра через интернет): его показывает проектор и кодирует QR вместо адресов в локальной сети.
  const AUD_PER_IP = opts.audiencePerIp || AUDIENCE_PER_IP;
  const PUBLIC_URL = (opts.publicUrl !== undefined ? opts.publicUrl : process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  const tls = opts.tls || (process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null);
  const log = opts.log ? (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a.filter(x => x !== '')) : () => {};
  const packs = opts.packs || loadPacks(opts.scenariosDir || path.join(ROOT, 'scenarios'), opts.log ? log : console.error);
  if (!packs.length) throw new Error('нет ни одного валидного пака в scenarios/');
  const packById = id => packs.find(p => p.meta.id === id);

  /* ---------- Комнаты и восстановление после падения ---------- */
  const rooms = new Map(); // id → { id, pack, session, joinCode }
  function addRoom(id, pack, session, joinCode) {
    const r = { id, pack, session: session || E.createSession(pack), joinCode: joinCode || '' };
    rooms.set(id, r);
    return r;
  }
  // Сбои диска видны ведущему (баннер на пульте) и мониторингу (/readyz), а не только строкой в логе.
  const storage = { persist: null, archive: null }; // последняя ошибка: { at, code, message } или null
  const storageFail = (kind, e) => { storage[kind] = { at: new Date().toISOString(), code: e.code || 'ошибка', message: e.message }; console.error(kind === 'persist' ? 'Не удалось сохранить состояние:' : 'Не удалось записать архив партии:', e.message); };

  // Нет файла — первый запуск. Битый файл не затирается молча: он откладывается рядом для разбора.
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') {
      const aside = FILE + '.corrupt-' + Date.now();
      try { fs.renameSync(FILE, aside); } catch (e2) { /* нечитаемый файл, который нельзя и переименовать, перезапишет первое сохранение */ }
      console.error(`state.json не читается (${e.message}) — партии начаты заново, файл отложен: ${aside}`);
    }
  }
  // Формат 2.0 ({scenarioId, session}) — одна партия: становится комнатой main.
  const saved = raw && raw.rooms ? raw.rooms : raw && raw.session ? { main: raw } : {};
  for (const id of Object.keys(saved)) {
    const s = saved[id];
    if (!ROOM_RE.test(id) || !s || !s.session || !packById(s.scenarioId)) continue;
    const pack = packById(s.scenarioId);
    // Пак могли поправить между запусками, а файл — испортить руками: такая партия не должна ронять сервер
    // на каждом старте. Комната начинается заново, остальные восстанавливаются.
    const ss = s.session, obj = x => !!x && typeof x === 'object' && !Array.isArray(x);
    let ok = false;
    try {
      ok = Number.isInteger(ss.stepIndex) && ss.stepIndex >= 0 && ss.stepIndex < pack.steps.length && obj(ss.seats)
        && Array.isArray(ss.journal || []) && (ss.journal || []).every(j => pack.steps.some(st => st.id === j.stepId && st.options.some(o => o.id === j.optionId)));
    } catch (e) { ok = false; }
    if (!ok) { console.error(`Комната ${id}: сохранённая партия не сходится с паком ${pack.meta.id} — начата новая`); addRoom(id, pack, E.createSession(pack, { team: typeof ss.team === 'string' ? ss.team : undefined, seats: obj(ss.seats) ? ss.seats : undefined }), s.joinCode); continue; }
    addRoom(id, pack, Object.assign({ audience: {} }, s.session), s.joinCode);
  }
  if (!rooms.has('main')) addRoom('main', packs[0]);

  // Надёжная атомарная запись: временный файл сбрасывается на диск (fsync) и подменяет старый одним rename.
  // Обрыв питания оставляет либо прежнюю версию, либо новую, но не пустой или обрезанный файл.
  // writeFileSync по дескриптору дописывает буфер целиком (writeSync может записать часть).
  const FSYNC_UNSUPPORTED = ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EBADF'];
  function writeDurable(file, data) {
    const tmp = file + '.tmp', fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    let d = null;
    try { d = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(d); }
    catch (e) { if (!FSYNC_UNSUPPORTED.includes(e.code)) throw e; } // fsync каталога есть не везде (Windows)
    finally { if (d !== null) fs.closeSync(d); }
  }
  function persist() {
    const out = { version: 3, rooms: {} };
    for (const r of rooms.values()) out.rooms[r.id] = { scenarioId: r.pack.meta.id, session: r.session, joinCode: r.joinCode };
    try { writeDurable(FILE, JSON.stringify(out)); storage.persist = null; }
    catch (e) { storageFail('persist', e); }
  }
  persist(); // запись при старте проверяет каталог данных: /readyz честен с первой секунды

  /* ---------- Архив ---------- */
  // Имя файла выводится из старта партии: повторная запись (финал, откат, снова финал, новая партия) перезаписывает тот же файл.
  function archive(r) {
    const s = r.session;
    if (!s.startedAt || !s.journal.length) return true;
    const sum = E.summary(r.pack, s);
    const rec = { at: new Date(s.endedAt || Date.now()).toISOString(), room: r.id, scenarioId: r.pack.meta.id, title: r.pack.meta.title, team: s.team, score: sum.score, max: sum.max, grade: sum.grade.label, complete: sum.complete, metrics: sum.metrics };
    // Токены устройств в архив не попадают: по ним можно выдать себя за игрока.
    const clean = Object.assign({}, s, { seats: {}, audience: {}, history: [] });
    const name = new Date(s.startedAt).toISOString().replace(/[^\w.-]+/g, '-') + '-' + r.id + '-' + r.pack.meta.id + '.json';
    // Сбой архива (диск полон, нет прав) не останавливает игру: ошибка — в лог и на пульт, результат — false.
    try { fs.mkdirSync(ARCH, { recursive: true }); writeDurable(path.join(ARCH, name), JSON.stringify({ summary: rec, session: clean })); storage.archive = null; return true; }
    catch (e) { storageFail('archive', e); return false; }
  }
  function readArchive() {
    try {
      return fs.readdirSync(ARCH).filter(f => f.endsWith('.json'))
        .map(f => { try { return Object.assign({ file: f }, JSON.parse(fs.readFileSync(path.join(ARCH, f), 'utf8'))); } catch (e) { return null; } })
        .filter(Boolean).sort((a, b) => b.file.localeCompare(a.file));
    } catch (e) { return []; }
  }

  /* ---------- Представления и рассылка ---------- */
  const clients = new Set();
  const catalog = () => packs.map(p => ({ id: p.meta.id, title: p.meta.title, brief: p.meta.brief, difficulty: p.meta.difficulty, etaMin: p.meta.etaMin, steps: p.steps.length }));
  const roomList = () => [...rooms.values()].map(r => ({ id: r.id, title: r.pack.meta.title, team: r.session.team, phase: r.session.phase, seats: Object.values(r.session.seats).filter(Boolean).length, clients: [...clients].filter(c => c.room === r).length }));
  function viewFor(c) {
    const r = c.room;
    const v = E.view(r.pack, r.session, c.audience, { role: c.role, token: c.token, now: Date.now() });
    v.room = r.id;
    v.joinRequired = !!r.joinCode;
    if (c.audience === 'gm') { v.catalog = catalog(); v.gmPin = !!GM_PIN; v.joinCode = r.joinCode; v.rooms = roomList(); v.storage = storage; }
    return v;
  }
  // Одно сломанное представление не роняет процесс: ошибка в лог, остальные клиенты получают своё.
  // Клиент, который не читает поток (зависший телефон, медленная сеть), копит буфер в памяти сервера — его отключаем.
  // Пульт с отозванной или истёкшей сессией тоже отключается: приватные данные идут только действующему ведущему.
  function drop(c) { clients.delete(c); clearInterval(c.hb); c.res.destroy(); }
  function write(c, chunk) {
    if (c.res.writableLength > SSE_MAX_BUFFER) return drop(c);
    c.res.write(chunk);
  }
  const send = c => {
    if (c.gmSid && !sessionLive(c.gmSid)) return drop(c);
    try { write(c, 'data: ' + JSON.stringify(viewFor(c)) + '\n\n'); } catch (e) { console.error('Не удалось построить представление:', e.message); }
  };
  function broadcast(r) {
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    persist(); // сначала диск: пульт получает в этом же представлении и ошибку сохранения, если она случилась
    for (const c of clients) if (c.room === r || (c.audience === 'gm')) send(c); // пульты видят список комнат целиком
  }
  // Голоса зала приходят сотнями: рассылаем и сохраняем не чаще раза в AUDIENCE_BROADCAST_MS.
  function broadcastSoon(r) {
    if (!r.timer) { r.timer = setTimeout(() => broadcast(r), AUDIENCE_BROADCAST_MS); r.timer.unref(); }
  }

  function run(r, cmd) {
    if (cmd.type === 'reset') {
      const next = packById(cmd.scenarioId || r.pack.meta.id);
      if (!next) throw userError('Нет такого кейса');
      // Сбой архива не мешает начать новую партию при зале: ведущий видит предупреждение на пульте.
      archive(r);
      // Команда, занятые роли и настройки переходят в новую партию: люди не перезаходят.
      r.session = E.createSession(next, { team: r.session.team, seats: r.session.seats, sound: r.session.sound });
      r.pack = next;
      return;
    }
    if (cmd.type === 'joinCode') {
      const code = String(cmd.code || '').trim();
      if (code && !CODE_RE.test(code)) throw userError('Код входа — 4–12 латинских букв или цифр');
      r.joinCode = code;
      return;
    }
    if (cmd.type === 'shuffle') {
      // Случайная перестановка — здесь, движок остаётся детерминированным.
      const perm = E.ROLE_IDS.slice();
      for (let i = perm.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [perm[i], perm[j]] = [perm[j], perm[i]]; }
      cmd = { type: 'shuffle', perm };
    }
    const before = r.session.phase;
    r.session = E.apply(r.pack, r.session, cmd, Date.now());
    if (r.session.phase === 'end' && before !== 'end') archive(r);
  }

  /* ---------- Защита ---------- */
  // Неудачи считаются раздельно: PIN — по адресу, код входа — по адресу и комнате. Опечатки зала в коде
  // не запирают ведущего, а верный PIN не спасает от блокировки только при переборе самого PIN.
  const fails = new Map(); // ключ → { n, since, until }
  // За прокси адрес клиента — самый правый в X-Forwarded-For: его дописал наш прокси, левые значения задаёт клиент.
  // Заголовки прокси учитываются, только если запрос пришёл от доверенного прокси: напрямую их подделает любой.
  const fromProxy = req => {
    const peer = bareIp(req.socket.remoteAddress);
    return !!TRUST_PROXY && (TRUST_PROXY === 'private' ? privateIp(peer) : TRUST_PROXY.includes(peer));
  };
  const ipOf = req => {
    if (fromProxy(req) && req.headers['x-forwarded-for']) { const xs = String(req.headers['x-forwarded-for']).split(',').map(x => x.trim()).filter(Boolean); if (xs.length) return xs[xs.length - 1]; }
    return req.socket.remoteAddress || '?';
  };
  function blocked(key) {
    const f = fails.get(key);
    if (!f) return false;
    if (f.until) { if (Date.now() < f.until) return true; fails.delete(key); return false; }
    if (Date.now() - f.since > FAIL_WINDOW_MS) fails.delete(key);
    return false;
  }
  function failed(key) {
    const f = fails.get(key);
    if (!f || Date.now() - f.since > FAIL_WINDOW_MS) fails.set(key, { n: 1, since: Date.now(), until: 0 });
    else if (++f.n >= FAIL_MAX) f.until = Date.now() + FAIL_WINDOW_MS; // блок — полные 10 минут с последней неудачи
    // Таблица не растёт бесконечно: вытесняем самые старые записи, а не сбрасываем счётчики всем.
    while (fails.size > FAIL_TABLE_MAX) fails.delete(fails.keys().next().value);
  }
  // Частота команд: окно CMD_WINDOW_MS, ключ — адрес или клиент (устройство, сессия ведущего). Голоса зала — отдельно.
  const rate = new Map(); // ключ → { n, since }
  function tooFast(key, limit) {
    const now = Date.now(), x = rate.get(key);
    if (!x || now - x.since > CMD_WINDOW_MS) { rate.delete(key); rate.set(key, { n: 1, since: now }); }
    else if (++x.n > limit) return true;
    while (rate.size > FAIL_TABLE_MAX) rate.delete(rate.keys().next().value);
    return false;
  }
  // Сравнение за постоянное время по хешам: длины всегда равны, любые байты в заголовке не роняют сервер.
  const digest = x => crypto.createHash('sha256').update(String(x)).digest();
  const pinOk = given => !GM_PIN || (typeof given === 'string' && crypto.timingSafeEqual(digest(given), digest(GM_PIN)));

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const TOO_MANY = { error: 'Слишком много неверных попыток. Подождите 10 минут.' };

  /* ---------- Cookie: сессия ведущего и токен устройства ---------- */
  // Битое значение (%E0 и т. п.) пропускается: исключение здесь роняло бы весь процесс одним запросом.
  const decode = v => { try { return decodeURIComponent(v); } catch (e) { return null; } };
  const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x.length === 2).map(([k, v]) => [k, decode(v)]).filter(x => x[1] !== null));
  const secureReq = req => !!tls || (fromProxy(req) && req.headers['x-forwarded-proto'] === 'https');
  const cookieStr = (req, name, value, maxAgeMs, sameSite) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(maxAgeMs / 1000)}` + (secureReq(req) ? '; Secure' : '');
  const gmSessions = new Map(); // id → истекает (мс); в памяти: рестарт сервера просит PIN заново
  function sessionLive(id) {
    const exp = id && gmSessions.get(id);
    if (!exp) return false;
    if (Date.now() > exp) { gmSessions.delete(id); return false; }
    return true;
  }
  // id действующей сессии ведущего из cookie или null.
  const gmSession = req => { const id = cookies(req)[GM_COOKIE]; return sessionLive(id) ? id : null; };
  // Токен устройства — из cookie; из тела запроса — только для API-клиентов без cookie (тесты, скрипты).
  function deviceOf(req, body) {
    const c = cookies(req)[DEVICE_COOKIE];
    if (c && COOKIE_TOKEN_RE.test(c)) return c;
    return body && typeof body.token === 'string' ? body.token : null;
  }

  // Проверка ведущего: действующая сессия (cookie) или верный PIN в заголовке x-gm-pin.
  // Перебор PIN блокируется; запрос без PIN и без сессии — просто 401, это не попытка перебора.
  function gmGuard(req, res) {
    if (!GM_PIN || gmSession(req)) return true;
    const given = req.headers['x-gm-pin'];
    const key = 'pin:' + ipOf(req);
    if (given !== undefined && blocked(key)) { json(res, 429, TOO_MANY); return false; }
    if (given !== undefined && pinOk(given)) return true;
    if (given !== undefined) { failed(key); log('отказ: неверный PIN', ipOf(req)); }
    json(res, 401, { error: 'Нужен PIN ведущего' });
    return false;
  }
  function codeGuard(req, res, r, given) {
    if (!r.joinCode) return true;
    const key = 'code:' + r.id + ':' + ipOf(req);
    if (blocked(key)) { json(res, 429, TOO_MANY); return false; }
    if (given === r.joinCode) return true;
    failed(key);
    json(res, 403, { error: 'Неверный код входа' });
    return false;
  }

  // Ошибка в обработчике — ответ 500 и строка в лог, но не падение процесса со всеми комнатами.
  function internalError(res, e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Внутренняя ошибка сервера' }); else res.destroy();
  }
  function readBody(req, res, cb) {
    let b = '';
    req.on('error', () => {}); // клиент оборвал запрос — отвечать некому
    req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let o;
      try { o = JSON.parse(b || '{}'); } catch (e) { o = null; }
      try { cb(o && typeof o === 'object' && !Array.isArray(o) ? o : null); } catch (e) { internalError(res, e); }
    });
  }
  function exec(res, r, cmd, who) {
    const before = r.session.phase;
    // Команда, которая ничего не меняет (повторный захват своей роли и т. п.), не рассылается и не пишется на диск.
    const snap = cmd.type === 'audienceVote' ? null : JSON.stringify(r.session) + r.joinCode;
    try { run(r, cmd); } catch (e) {
      if (!e.userError) { console.error(e); return json(res, 500, { error: 'Внутренняя ошибка сервера' }); }
      log('отказ', r.id, who, cmd.type, e.message);
      return json(res, cmd.type === 'claim' ? 409 : 400, { error: e.message });
    }
    if (snap !== null && JSON.stringify(r.session) + r.joinCode === snap) return json(res, 200, { ok: true, role: cmd.role });
    // Журнал для разбора спорных моментов: каждая команда — одна строка в stdout.
    if (cmd.type === 'audienceVote') broadcastSoon(r);
    else { log(r.id, who, cmd.type, cmd.role || '', cmd.option || '', before !== r.session.phase ? before + ' → ' + r.session.phase : ''); broadcast(r); }
    json(res, 200, { ok: true, role: cmd.role });
  }
  function serveFile(res, file) {
    const type = TYPES[path.extname(file)];
    if (!type || !file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  // Сокеты и число запросов в работе на каждом: при остановке простаивающие закрываются сразу, занятые — как только
  // ответят. Своя бухгалтерия надёжнее closeIdleConnections, который в Node 20 пропускает часть keep-alive.
  const sockets = new Set(), busy = new Map();
  function register(sock) {
    if (sockets.has(sock)) return;
    sockets.add(sock);
    sock.once('close', () => { sockets.delete(sock); busy.delete(sock); });
  }
  function track(req, res) {
    const sock = req.socket;
    register(sock);
    busy.set(sock, (busy.get(sock) || 0) + 1);
    res.once('close', () => {
      const n = (busy.get(sock) || 1) - 1;
      if (n > 0) return busy.set(sock, n);
      busy.delete(sock);
      if (server.closing) sock.destroy();
    });
  }
  const handler = (req, res) => { track(req, res); try { route(req, res); } catch (e) { internalError(res, e); } };
  const route = (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', CSP);
    if (tls) res.setHeader('strict-transport-security', 'max-age=31536000');
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    let m;

    // Живость: процесс отвечает. Готовность: состояние пишется на диск и сервер не останавливается.
    if (p === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size, clients: clients.size, gmPin: !!GM_PIN, tls: !!tls });
    if (p === '/readyz') {
      const ready = !storage.persist && !server.closing;
      return json(res, ready ? 200 : 503, { ready, closing: !!server.closing, storage });
    }

    // Страница: корень — комната main, /r/<комната>/ — остальные. Клиент берёт комнату из адреса.
    if (p === '/' || p === '/index.html' || /^\/r\/[a-z0-9-]+\/?$/.test(p)) {
      if (p.startsWith('/r/') && !p.endsWith('/')) { res.writeHead(301, { location: p + '/' + u.search }); return res.end(); }
      return serveFile(res, path.join(ROOT, 'index.html'));
    }
    if (p === '/theme.css') return serveFile(res, path.join(ROOT, 'theme.css'));
    if ((m = p.match(/^\/(fonts|ui)\/([\w.-]+)$/))) return serveFile(res, path.join(ROOT, m[1], m[2]));

    const roomId = u.searchParams.get('room') || 'main';
    const room = rooms.get(roomId);

    if (p === '/api/auth') {
      if (!gmGuard(req, res)) return;
      // Верный PIN обменивается на cookie сессии: дальше PIN не ходит по сети и не лежит в браузере.
      if (GM_PIN && req.headers['x-gm-pin'] !== undefined) {
        const id = crypto.randomBytes(24).toString('hex');
        gmSessions.set(id, Date.now() + GM_SESSION_MS);
        res.setHeader('set-cookie', cookieStr(req, GM_COOKIE, id, GM_SESSION_MS, 'Strict'));
      }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const sid = cookies(req)[GM_COOKIE];
      gmSessions.delete(sid);
      for (const c of [...clients]) if (sid && c.gmSid === sid) drop(c);
      res.setHeader('set-cookie', cookieStr(req, GM_COOKIE, '', 0, 'Strict'));
      return json(res, 200, { ok: true });
    }
    // Токен устройства: выдаётся сервером в HttpOnly-cookie. Старый токен из localStorage телефона можно
    // перенести (body.token), чтобы занятая до обновления роль не потерялась.
    if (p === '/api/device' && req.method === 'POST') {
      return readBody(req, res, body => {
        if (cookies(req)[DEVICE_COOKIE] && COOKIE_TOKEN_RE.test(cookies(req)[DEVICE_COOKIE])) return json(res, 200, { ok: true });
        const t = body && TOKEN_RE.test(String(body.token || '')) ? body.token : crypto.randomBytes(12).toString('hex');
        res.setHeader('set-cookie', cookieStr(req, DEVICE_COOKIE, t, DEVICE_MS, 'Lax'));
        json(res, 200, { ok: true });
      });
    }

    if (p === '/api/info') {
      if (!room) return json(res, 404, { error: 'Нет такой комнаты' });
      // С PUBLIC_URL внутренние адреса не раскрываются.
      const playUrls = PUBLIC_URL ? [PUBLIC_URL + (room.id === 'main' ? '/' : '/r/' + room.id + '/') + '#play'] : lanUrls(server.address().port, tls ? 'https' : 'http', room.id);
      return json(res, 200, { room: room.id, playUrls, publicUrl: !!PUBLIC_URL, gmPin: !!GM_PIN, joinRequired: !!room.joinCode, title: room.pack.meta.title });
    }

    if (p === '/events') {
      if (!room) return json(res, 404, { error: 'Нет такой комнаты' });
      const audience = u.searchParams.get('view');
      if (!['screen', 'play', 'gm'].includes(audience)) return json(res, 400, { error: 'view: screen | play | gm' });
      if (audience === 'gm' && !gmGuard(req, res)) return;
      const ip = ipOf(req);
      if (clients.size >= SSE_TOTAL || [...clients].filter(x => x.ip === ip).length >= SSE_PER_IP) return json(res, 503, { error: 'Слишком много подключений' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      // Пульт по cookie привязан к сессии: выход или истечение сессии закрывает уже открытый поток.
      const c = { res, room, audience, ip, role: u.searchParams.get('role'), token: deviceOf(req, null), gmSid: audience === 'gm' && GM_PIN ? gmSession(req) : null };
      clients.add(c); send(c);
      c.hb = setInterval(() => write(c, ': ping\n\n'), HEARTBEAT_MS); c.hb.unref();
      res.on('close', () => { clearInterval(c.hb); clients.delete(c); });
      return;
    }

    if (req.method === 'POST' && ['/api/claim', '/api/vote', '/api/audience', '/api/cmd', '/api/rooms'].includes(p)) {
      // Защита от подделки запросов с чужих сайтов: POST принимается только со своего origin.
      const origin = req.headers.origin;
      if (origin && origin !== 'null') { let host = ''; try { host = new URL(origin).host; } catch (e) { /* битый Origin */ } if (host !== req.headers.host) return json(res, 403, { error: 'Чужой источник запроса' }); }
      if (p !== '/api/audience') {
        const ip = ipOf(req), c = cookies(req), who = gmSession(req) || (COOKIE_TOKEN_RE.test(c[DEVICE_COOKIE] || '') ? c[DEVICE_COOKIE] : null);
        if (tooFast('ip:' + ip, CMD_PER_IP) || tooFast(who ? 'c:' + who : 'ipc:' + ip, CMD_PER_CLIENT)) return json(res, 429, { error: 'Слишком много команд подряд' });
      }
      return readBody(req, res, body => {
        if (!body) return json(res, 400, { error: 'Тело запроса — JSON-объект' });
        body.token = deviceOf(req, body);
        if (p === '/api/rooms') return manageRooms(req, res, body);
        if (!room) return json(res, 404, { error: 'Нет такой комнаты' });
        const r = room;
        if (p === '/api/claim') {
          if (!codeGuard(req, res, r, body.code)) return;
          let role = body.role;
          // «Любая свободная роль» — жребий среди свободных.
          if (role === 'any') {
            const mine = E.ROLE_IDS.find(x => body.token && r.session.seats[x] === body.token);
            const free = E.ROLE_IDS.filter(x => !r.session.seats[x]);
            if (!mine && !free.length) return json(res, 409, { error: 'Все роли заняты' });
            role = mine || free[crypto.randomInt(free.length)];
          }
          return exec(res, r, { type: 'claim', role, token: body.token }, 'телефон');
        }
        if (p === '/api/vote') {
          if (!body.token || r.session.seats[body.role] !== body.token) return json(res, 403, { error: 'Роль занята другим устройством' });
          return exec(res, r, { type: 'vote', role: body.role, option: body.option }, body.role);
        }
        if (p === '/api/audience') {
          if (!codeGuard(req, res, r, body.code)) return;
          // Счётчик голосов зала с адреса — на текущий шаг (ключ: шаг и начало голосования).
          const stepKey = r.session.stepIndex + ':' + r.session.phaseAt;
          if (r.audienceKey !== stepKey) { r.audienceKey = stepKey; r.audienceIps = new Map(); }
          const ip = ipOf(req), n = r.audienceIps.get(ip) || 0;
          if (n >= AUD_PER_IP) return json(res, 429, { error: 'С этого адреса голосов достаточно' });
          const before = Object.keys(r.session.audience || {}).length;
          exec(res, r, { type: 'audienceVote', token: body.token, option: body.option }, 'зал');
          if (Object.keys(r.session.audience || {}).length > before) r.audienceIps.set(ip, n + 1);
          return;
        }
        if (!gmGuard(req, res)) return;
        if (!GM_CMDS.includes(body.type)) return json(res, 400, { error: 'Неизвестная команда' });
        return exec(res, r, body, 'ведущий');
      });
    }

    // Только ведущему: полный пак (карточки для печати), архив, аналитика.
    if (p === '/api/pack' || p === '/api/analytics' || p === '/archive' || p.startsWith('/archive/')) {
      if (!gmGuard(req, res)) return;
      if (p === '/api/pack') return json(res, 200, packById(u.searchParams.get('id') || (room ? room.pack.meta.id : '')) || packs[0]);
      const recs = readArchive();
      if (p === '/api/analytics') return json(res, 200, aggregate(recs, packs));
      if (p === '/archive') return json(res, 200, recs.map(x => Object.assign({ file: x.file }, x.summary)));
      m = p.match(/^\/archive\/([\w.-]+\.json)$/);
      const rec = m && recs.find(x => x.file === m[1]);
      if (!rec) { res.writeHead(404); return res.end(); }
      return json(res, 200, { summary: rec.summary, session: rec.session });
    }

    res.writeHead(404); res.end();
  };

  function manageRooms(req, res, body) {
    if (!gmGuard(req, res)) return;
    const id = String(body.id || '').trim().toLowerCase();
    if (body.action === 'create') {
      if (!ROOM_RE.test(id)) return json(res, 400, { error: 'Имя комнаты — латиница, цифры и дефис, до 32 символов' });
      if (rooms.has(id)) return json(res, 409, { error: 'Такая комната уже есть' });
      if (rooms.size >= MAX_ROOMS) return json(res, 400, { error: 'Комнат не больше ' + MAX_ROOMS });
      const pack = packById(body.scenarioId) || packs[0];
      addRoom(id, pack);
      log(id, 'ведущий', 'комната создана', pack.meta.id);
    } else if (body.action === 'delete') {
      const r = rooms.get(id);
      if (!r) return json(res, 404, { error: 'Нет такой комнаты' });
      if (id === 'main') return json(res, 400, { error: 'Основную комнату удалить нельзя' });
      // Без записанного архива комната не удаляется: иначе сыгранная партия пропадёт насовсем.
      if (!archive(r)) return json(res, 503, { error: 'Не удалось записать архив партии — комната не удалена. Проверьте место на диске.' });
      for (const c of [...clients]) if (c.room === r) { c.res.end(); clients.delete(c); }
      rooms.delete(id);
      log(id, 'ведущий', 'комната удалена');
    } else return json(res, 400, { error: 'action: create | delete' });
    persist();
    for (const c of clients) if (c.audience === 'gm') send(c);
    json(res, 200, { ok: true, id });
  }

  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.tlsEnabled = !!tls;
  server.on(tls ? 'secureConnection' : 'connection', register); // и соединения, по которым запроса ещё не было

  // Истёкшие сессии ведущего удаляются и закрывают свои потоки, даже если в комнате ничего не происходит.
  const sweep = setInterval(() => {
    for (const id of [...gmSessions.keys()]) sessionLive(id);
    for (const c of [...clients]) if (c.gmSid && !sessionLive(c.gmSid)) drop(c);
  }, 60000);
  sweep.unref();

  // Остановка: перестаём принимать соединения и сохраняем состояние; SSE-потоки рвём сразу (браузеры переподключатся
  // к новому процессу), простаивающие keep-alive закрываем, а начатым запросам даём SHUTDOWN_GRACE_MS доделаться.
  const close = server.close.bind(server);
  server.close = cb => {
    server.closing = true;
    clearInterval(sweep);
    for (const c of clients) { clearInterval(c.hb); c.res.destroy(); }
    clients.clear();
    // Отложенная рассылка голосов зала — сохранить сейчас и ещё раз в конце: голос мог прийти, пока доделывались запросы.
    const flush = () => { let pending = false; for (const r of rooms.values()) if (r.timer) { clearTimeout(r.timer); r.timer = null; pending = true; } if (pending) persist(); };
    flush();
    const r = close((...a) => { flush(); if (cb) cb(...a); });
    for (const sock of sockets) if (!busy.has(sock)) sock.destroy();
    const force = setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections(); }, SHUTDOWN_GRACE_MS);
    force.unref();
    server.once('close', () => clearTimeout(force));
    return r;
  };
  return server;
}

if (require.main === module) {
  const PORT = +(process.argv[2] || process.env.PORT || 8085);
  const HOST = process.env.HOST || '0.0.0.0';
  const server = makeServer({ log: true });
  const scheme = server.tlsEnabled ? 'https' : 'http';
  server.listen(PORT, HOST, () => {
    console.log('Воркшоп инцидентов запущен.');
    console.log(`  Проектор:        ${scheme}://localhost:${PORT}/#screen`);
    console.log(`  Пульт ведущего:  ${scheme}://localhost:${PORT}/#gm`);
    lanUrls(PORT, scheme).forEach(url => console.log('  Телефоны ролей:  ' + url));
    console.log('Состояние: state.json (рестарт продолжит с того же шага). Архив партий: archive/.');
    console.log(process.env.GM_PIN ? 'Пульт защищён PIN (GM_PIN).' : 'Пульт открыт всем в сети. Чтобы защитить: GM_PIN=4821 npm start');
    if (!server.tlsEnabled && process.env.HOST && process.env.HOST !== '127.0.0.1') console.log('Для доступа из интернета включите HTTPS (TLS_CERT, TLS_KEY) или поставьте сервер за прокси с HTTPS — см. docs/facilitator-guide.md.');
  });
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS + 1000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

module.exports = { makeServer, loadPacks };
