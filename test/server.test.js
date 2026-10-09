const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { makeServer } = require('../server.js');
const MINI = require('./fixtures/mini-pack.js');

const BASE = 'http://127.0.0.1';

async function start(t, opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'incw-srv-'));
  const srv = makeServer(Object.assign({ file: path.join(dir, 'state.json'), archiveDir: path.join(dir, 'archive'), packs: [MINI], gmPin: '' }, opts));
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  t.after(() => new Promise(res => srv.close(res)));
  const port = srv.address().port;
  const post = (p, body, headers = {}) => fetch(`${BASE}:${port}${p}`, {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const get = (p, headers = {}) => fetch(`${BASE}:${port}${p}`, { headers }).then(async r => ({ status: r.status, ct: r.headers.get('content-type'), body: await r.json().catch(() => null) }));
  return { dir, port, post, get, srv };
}

// Первое SSE-сообщение потока: представление, которое сервер шлёт этому клиенту.
// Секреты в адресе сервер больше не принимает: для удобства тестов `token=` и `pin=` в query
// превращаются в cookie устройства и cookie сессии ведущего (через /api/auth). raw: true — отправить как есть.
async function firstEvent(port, query, opts = {}) {
  const q = new URLSearchParams(query), headers = {};
  if (!opts.raw) {
    const jar = [];
    if (q.has('token')) { jar.push('incw_dev=' + encodeURIComponent(q.get('token'))); q.delete('token'); }
    if (q.has('pin')) {
      const a = await fetch(`${BASE}:${port}/api/auth`, { headers: { 'x-gm-pin': q.get('pin') } });
      const sc = a.headers.get('set-cookie');
      if (sc) jar.push(sc.split(';')[0]);
      q.delete('pin');
    }
    if (jar.length) headers.cookie = jar.join('; ');
  }
  const ac = new AbortController();
  const r = await fetch(`${BASE}:${port}/events?${opts.raw ? query : q}`, { signal: ac.signal, headers });
  if (r.status !== 200) { ac.abort(); return { status: r.status }; }
  const reader = r.body.getReader();
  let buf = '';
  while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  return { status: 200, view: JSON.parse(buf.slice(buf.indexOf('data: ') + 6, buf.indexOf('\n\n'))) };
}

const cmd = (s, body, pin) => s.post('/api/cmd', body, pin ? { 'x-gm-pin': pin } : {});

test('полный раунд по HTTP: роли занимают места, голосуют, ведущий раскрывает', async (t) => {
  const s = await start(t);
  for (const role of ['commander', 'scout', 'engineer']) assert.equal((await s.post('/api/claim', { role, token: 'tok-' + role })).status, 200);
  assert.equal((await cmd(s, { type: 'start' })).status, 200);
  assert.equal((await cmd(s, { type: 'voting' })).status, 200);
  assert.equal((await s.post('/api/vote', { role: 'scout', token: 'tok-scout', option: 'A' })).status, 200);
  assert.equal((await s.post('/api/vote', { role: 'engineer', token: 'tok-engineer', option: 'A' })).status, 200);
  assert.equal((await cmd(s, { type: 'reveal' })).status, 200);
  const gm = await firstEvent(s.port, 'view=gm');
  assert.equal(gm.view.phase, 'revealed');
  assert.equal(gm.view.score, 2);
  assert.equal(gm.view.journal[0].optionId, 'A');
});

test('занятую роль второе устройство не получает (409), голос с чужим токеном — 403', async (t) => {
  const s = await start(t);
  await s.post('/api/claim', { role: 'scout', token: 'aaa' });
  const r = await s.post('/api/claim', { role: 'scout', token: 'bbb' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /занята/);
  await cmd(s, { type: 'start' }); await cmd(s, { type: 'voting' });
  assert.equal((await s.post('/api/vote', { role: 'scout', token: 'bbb', option: 'A' })).status, 403);
  assert.equal((await s.post('/api/vote', { role: 'scout', token: 'aaa', option: 'A' })).status, 200);
  const twice = await s.post('/api/vote', { role: 'scout', token: 'aaa', option: 'B' });
  assert.equal(twice.status, 400);
  assert.match(twice.body.error, /уже учтён/);
});

test('недопустимая команда — 400 с понятным текстом, неизвестная — 400', async (t) => {
  const s = await start(t);
  const r = await cmd(s, { type: 'reveal' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /после голосования/);
  assert.equal((await cmd(s, { type: 'claim', role: 'scout', token: 'x' })).status, 400, 'claim не идёт через пульт');
  assert.equal((await s.post('/api/cmd', 'строка')).status, 400);
});

test('PIN ведущего: команды пульта, поток #gm и полный пак без PIN — 401', async (t) => {
  const s = await start(t, { gmPin: '4821' });
  assert.equal((await cmd(s, { type: 'start' })).status, 401);
  assert.equal((await cmd(s, { type: 'start' }, '0000')).status, 401);
  assert.equal((await cmd(s, { type: 'start' }, '4821')).status, 200);
  assert.equal((await firstEvent(s.port, 'view=gm')).status, 401);
  assert.equal((await firstEvent(s.port, 'view=gm&pin=4821')).status, 200);
  assert.equal((await s.get('/api/pack')).status, 401);
  assert.equal((await s.get('/api/pack', { 'x-gm-pin': '4821' })).body.meta.id, 'mini');
  assert.equal((await s.get('/api/auth')).status, 401);
  assert.equal((await s.get('/api/auth', { 'x-gm-pin': '4821' })).status, 200);
  // Телефоны и проектор работают без PIN.
  assert.equal((await s.post('/api/claim', { role: 'scout', token: 't' })).status, 200);
  assert.equal((await firstEvent(s.port, 'view=screen')).status, 200);
});

test('SSE: проектор и чужой телефон не получают приватку, голоса и подсказки', async (t) => {
  const s = await start(t);
  await s.post('/api/claim', { role: 'scout', token: 'tok' });
  await cmd(s, { type: 'start' }); await cmd(s, { type: 'voting' });
  await s.post('/api/vote', { role: 'scout', token: 'tok', option: 'B' });
  const screen = JSON.stringify((await firstEvent(s.port, 'view=screen')).view);
  assert.ok(!screen.includes('секрет-'));
  assert.ok(!screen.includes('Подсказка ведущему'));
  assert.ok(!screen.includes('"votes"'));
  const mine = (await firstEvent(s.port, 'view=play&role=scout&token=tok')).view;
  assert.equal(mine.private.data, 'секрет-s1-scout');
  assert.equal(mine.myVote, 'B');
  const stranger = (await firstEvent(s.port, 'view=play&role=scout&token=wrong')).view;
  assert.equal(stranger.role, null);
  assert.ok(!JSON.stringify(stranger).includes('секрет-'));
});

test('SSE: изменение рассылается подписанным клиентам', async (t) => {
  const s = await start(t);
  const ac = new AbortController();
  t.after(() => ac.abort());
  const r = await fetch(`${BASE}:${s.port}/events?view=screen`, { signal: ac.signal });
  const reader = r.body.getReader();
  const views = [];
  let buf = '';
  const pump = (async () => {
    while (views.length < 2) {
      buf += new TextDecoder().decode((await reader.read()).value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) views.push(JSON.parse(chunk.slice(6)));
      }
    }
  })();
  await new Promise(res => setTimeout(res, 50));
  await cmd(s, { type: 'start' });
  await pump;
  assert.equal(views[0].phase, 'lobby');
  assert.equal(views[1].phase, 'situation');
});

test('восстановление из state.json: рестарт продолжает с того же шага', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-srv-'));
  const s1 = await start(t, { dir });
  await s1.post('/api/claim', { role: 'domain', token: 'dd' });
  await cmd(s1, { type: 'start' }); await cmd(s1, { type: 'voting' }); await cmd(s1, { type: 'reveal', option: 'A' }); await cmd(s1, { type: 'next' });
  await new Promise(res => s1.srv.close(res));
  const s2 = await start(t, { dir });
  const v = (await firstEvent(s2.port, 'view=play&role=domain&token=dd')).view;
  assert.equal(v.stepNo, 2);
  assert.equal(v.phase, 'situation');
  assert.equal(v.role.id, 'domain', 'роль переживает рестарт');
  assert.equal(v.score, 2);
});

test('новая партия архивирует сыгранную и сохраняет команду и места', async (t) => {
  const s = await start(t);
  await s.post('/api/claim', { role: 'comms', token: 'cc' });
  await cmd(s, { type: 'team', team: 'Дежурные' });
  await cmd(s, { type: 'start' }); await cmd(s, { type: 'voting' }); await cmd(s, { type: 'reveal', option: 'A' });
  assert.equal((await cmd(s, { type: 'reset', scenarioId: 'mini' })).status, 200);
  const list = await s.get('/archive');
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].team, 'Дежурные');
  assert.equal(list.body[0].score, 2);
  const full = await s.get('/archive/' + list.body[0].file);
  assert.equal(full.body.session.journal.length, 1);
  const v = (await firstEvent(s.port, 'view=play&role=comms&token=cc')).view;
  assert.equal(v.phase, 'lobby');
  assert.equal(v.team, 'Дежурные');
  assert.equal(v.role.id, 'comms');
  assert.equal((await cmd(s, { type: 'reset', scenarioId: 'нет-такого' })).status, 400);
});

test('новая партия без сыгранных шагов архив не пишет', async (t) => {
  const s = await start(t);
  await cmd(s, { type: 'reset' });
  assert.equal(fs.existsSync(path.join(s.dir, 'archive')), false);
});

test('статика: страница, тема, шрифты, ui-скрипты; паки и движок наружу не отдаются', async (t) => {
  const s = await start(t);
  const ct = async p => { const r = await fetch(`${BASE}:${s.port}${p}`); await r.arrayBuffer(); return [r.status, r.headers.get('content-type')]; };
  assert.deepEqual(await ct('/'), [200, 'text/html; charset=utf-8']);
  assert.deepEqual(await ct('/theme.css'), [200, 'text/css; charset=utf-8']);
  assert.equal((await ct('/fonts/fonts.css'))[0], 200);
  const font = fs.readdirSync(path.join(__dirname, '..', 'fonts')).find(f => f.endsWith('.woff2'));
  assert.deepEqual(await ct('/fonts/' + font), [200, 'font/woff2']);
  assert.deepEqual(await ct('/ui/app.js'), [200, 'text/javascript; charset=utf-8']);
  assert.equal((await ct('/scenarios/phantom-network.js'))[0], 404, 'пак с приваткой не раздаётся');
  assert.equal((await ct('/state.json'))[0], 404);
  assert.equal((await ct('/ui/..%2Fserver.js'))[0], 404);
  assert.equal((await ct('/nope'))[0], 404);
});

test('/healthz и /api/info', async (t) => {
  const s = await start(t, { gmPin: '1' });
  const h = await s.get('/healthz');
  assert.deepEqual(Object.keys(h.body).sort(), ['clients', 'gmPin', 'ok', 'rooms', 'tls']);
  assert.equal(h.body.gmPin, true);
  const i = await s.get('/api/info');
  assert.ok(Array.isArray(i.body.playUrls));
  assert.ok(i.body.playUrls.every(u => u.endsWith('/#play')));
});

test('реальные паки из scenarios/ загружаются сервером', () => {
  const { loadPacks } = require('../server.js');
  const errors = [];
  const packs = loadPacks(path.join(__dirname, '..', 'scenarios'), m => errors.push(m));
  assert.deepEqual(errors, []);
  const ids = packs.map(p => p.meta.id);
  for (const id of ['expired-cert', 'phantom-network']) assert.ok(ids.includes(id), id);
});

const cmdIn = (s, room, body, pin) => s.post('/api/cmd?room=' + room, body, pin ? { 'x-gm-pin': pin } : {});

test('комнаты: создать, партии независимы, удалить с архивом; основную удалить нельзя', async (t) => {
  const s = await start(t);
  assert.equal((await s.post('/api/rooms', { action: 'create', id: 'Stol-2' })).status, 200, 'имя приводится к нижнему регистру');
  assert.equal((await s.post('/api/rooms', { action: 'create', id: 'stol-2' })).status, 409);
  assert.equal((await s.post('/api/rooms', { action: 'create', id: 'плохое имя' })).status, 400);
  await cmdIn(s, 'stol-2', { type: 'start' });
  assert.equal((await firstEvent(s.port, 'room=stol-2&view=screen')).view.phase, 'situation');
  assert.equal((await firstEvent(s.port, 'view=screen')).view.phase, 'lobby', 'main не тронута');
  const gm = (await firstEvent(s.port, 'view=gm')).view;
  assert.deepEqual(gm.rooms.map(r => r.id).sort(), ['main', 'stol-2']);
  await cmdIn(s, 'stol-2', { type: 'voting' }); await cmdIn(s, 'stol-2', { type: 'reveal', option: 'A' });
  assert.equal((await s.post('/api/rooms', { action: 'delete', id: 'stol-2' })).status, 200);
  assert.equal((await firstEvent(s.port, 'room=stol-2&view=screen')).status, 404);
  assert.equal((await s.get('/archive')).body[0].room, 'stol-2');
  assert.equal((await s.post('/api/rooms', { action: 'delete', id: 'main' })).status, 400);
  assert.equal((await s.post('/api/cmd?room=nope', { type: 'start' })).status, 404);
});

test('комнаты: страница /r/<комната>/ и переживают рестарт; старый state.json становится комнатой main', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-srv-'));
  const session = require('../workshop-engine.js').createSession(MINI, { team: 'Старая' });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ scenarioId: 'mini', session }));
  const s1 = await start(t, { dir });
  assert.equal((await firstEvent(s1.port, 'view=screen')).view.team, 'Старая');
  await s1.post('/api/rooms', { action: 'create', id: 'b' });
  await cmdIn(s1, 'b', { type: 'team', team: 'Вторые' });
  const page = await fetch(`${BASE}:${s1.port}/r/b/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<!DOCTYPE html>/);
  const redirect = await fetch(`${BASE}:${s1.port}/r/b`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  await new Promise(res => s1.srv.close(res));
  const s2 = await start(t, { dir });
  assert.equal((await firstEvent(s2.port, 'room=b&view=screen')).view.team, 'Вторые');
});

test('код входа: роль и голос зала только с кодом; ведущий видит код, проектор — только факт', async (t) => {
  const s = await start(t);
  assert.equal((await cmd(s, { type: 'joinCode', code: 'ab' })).status, 400);
  await cmd(s, { type: 'joinCode', code: 'K7Q2' });
  assert.equal((await s.post('/api/claim', { role: 'scout', token: 't' })).status, 403);
  assert.equal((await s.post('/api/claim', { role: 'scout', token: 't', code: 'K7Q2' })).status, 200);
  assert.equal((await firstEvent(s.port, 'view=gm')).view.joinCode, 'K7Q2');
  const screen = (await firstEvent(s.port, 'view=screen')).view;
  assert.equal(screen.joinRequired, true);
  assert.ok(!JSON.stringify(screen).includes('K7Q2'));
  await cmd(s, { type: 'start' }); await cmd(s, { type: 'voting' });
  assert.equal((await s.post('/api/audience', { token: 'z', option: 'A' })).status, 403);
  assert.equal((await s.post('/api/audience', { token: 'z', option: 'A', code: 'K7Q2' })).status, 200);
});

test('перебор PIN: после 10 неудач адрес получает 429 даже с верным PIN', async (t) => {
  const s = await start(t, { gmPin: '4821' });
  for (let i = 0; i < 10; i++) assert.equal((await s.get('/api/auth', { 'x-gm-pin': String(i) })).status, 401);
  assert.equal((await s.get('/api/auth', { 'x-gm-pin': '4821' })).status, 429);
  assert.equal((await cmd(s, { type: 'start' }, '4821')).status, 429);
});

test('«любая свободная роль»: жребий среди свободных, повтор возвращает ту же роль', async (t) => {
  const s = await start(t);
  for (const r of ['commander', 'scout', 'engineer', 'domain']) await s.post('/api/claim', { role: r, token: 'tok-' + r });
  const a = await s.post('/api/claim', { role: 'any', token: 'new' });
  assert.equal(a.status, 200);
  assert.equal(a.body.role, 'comms');
  assert.equal((await s.post('/api/claim', { role: 'any', token: 'new' })).body.role, 'comms');
  const full = await s.post('/api/claim', { role: 'any', token: 'other' });
  assert.equal(full.status, 409);
});

test('жребий ведущего: занятые устройства остаются занятыми, роли перемешаны, телефон видит новую роль', async (t) => {
  const s = await start(t);
  for (const r of ['commander', 'scout']) await s.post('/api/claim', { role: r, token: 'tok-' + r });
  assert.equal((await cmd(s, { type: 'shuffle' })).status, 200);
  const seen = [];
  for (const tok of ['tok-commander', 'tok-scout']) {
    // Телефон переподключается со старой ролью в адресе — сервер находит место по токену.
    const v = (await firstEvent(s.port, `view=play&role=${tok.slice(4)}&token=${tok}`)).view;
    assert.ok(v.role, 'после жребия телефон не теряет роль');
    seen.push(v.role.id);
  }
  assert.equal(new Set(seen).size, 2);
});

test('одно устройство — одна роль: новая роль освобождает прежнюю', async (t) => {
  const s = await start(t);
  await s.post('/api/claim', { role: 'scout', token: 'a' });
  await s.post('/api/claim', { role: 'engineer', token: 'a' });
  const v = (await firstEvent(s.port, 'view=screen')).view;
  assert.deepEqual(v.seats.filter(x => x.taken).map(x => x.id), ['engineer']);
});

test('PIN с не-ASCII байтами не роняет сервер', async (t) => {
  const s = await start(t, { gmPin: '1234' });
  assert.equal((await firstEvent(s.port, 'view=gm&pin=%C3%BF%C3%BF%C3%BF%C3%BF')).status, 401);
  const r = await new Promise((res, rej) => require('http').get({ host: '127.0.0.1', port: s.port, path: '/api/auth', headers: { 'x-gm-pin': Buffer.from([0xff, 0xfe, 0x80, 0x81]).toString('latin1') } }, res).on('error', rej));
  r.resume();
  assert.equal(r.statusCode, 401);
  assert.equal((await s.get('/healthz')).status, 200, 'сервер жив');
});

test('за прокси блокировка по самому правому адресу: подделанный X-Forwarded-For не помогает', async (t) => {
  const s = await start(t, { gmPin: '4821', trustProxy: true });
  for (let i = 0; i < 10; i++) await s.get('/api/auth', { 'x-gm-pin': 'x', 'x-forwarded-for': `10.0.0.${i}, 7.7.7.7` });
  assert.equal((await s.get('/api/auth', { 'x-gm-pin': 'x', 'x-forwarded-for': '10.9.9.9, 7.7.7.7' })).status, 429);
  assert.equal((await s.get('/api/auth', { 'x-gm-pin': '4821', 'x-forwarded-for': '8.8.8.8' })).status, 200, 'другой клиент не заблокирован');
});

test('опечатки зала в коде входа не запирают ведущего', async (t) => {
  const s = await start(t, { gmPin: '4821' });
  await cmd(s, { type: 'joinCode', code: 'K7Q2' }, '4821');
  for (let i = 0; i < 12; i++) await s.post('/api/claim', { role: 'scout', token: 't', code: 'oops' + i });
  assert.equal((await s.post('/api/claim', { role: 'scout', token: 't', code: 'K7Q2' })).status, 429, 'перебор кода блокируется');
  assert.equal((await s.get('/api/auth', { 'x-gm-pin': '4821' })).status, 200, 'пульт при этом работает');
});

test('голоса зала: лимит с одного адреса за шаг (по умолчанию 250, настраивается)', async (t) => {
  const s = await start(t, { audiencePerIp: 50 });
  await cmd(s, { type: 'start' }); await cmd(s, { type: 'voting' });
  for (let i = 0; i < 50; i++) assert.equal((await s.post('/api/audience', { token: 'z' + i, option: 'A' })).status, 200);
  assert.equal((await s.post('/api/audience', { token: 'z-лишний', option: 'A' })).status, 429);
  await cmd(s, { type: 'revote' });
  assert.equal((await s.post('/api/audience', { token: 'z-новый', option: 'B' })).status, 200, 'новое голосование — новый счётчик');
});

test('state.json, не сходящийся с паком, не роняет сервер', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-srv-'));
  const E = require('../workshop-engine.js');
  let session = E.createSession(MINI, { team: 'Сломанная' });
  session = E.apply(MINI, E.apply(MINI, E.apply(MINI, session, { type: 'start' }, 1), { type: 'voting' }, 2), { type: 'reveal', option: 'A' }, 3);
  session.journal[0].stepId = 'исчез';
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 3, rooms: { main: { scenarioId: 'mini', session } } }));
  const s = await start(t, { dir });
  const v = (await firstEvent(s.port, 'view=gm')).view;
  assert.equal(v.phase, 'lobby');
  assert.equal(v.team, 'Сломанная');
});

test('PUBLIC_URL: проектор получает публичный адрес, внутренние адреса не раскрываются', async (t) => {
  const s = await start(t, { publicUrl: 'https://incident.example.org/' });
  await s.post('/api/rooms', { action: 'create', id: 'b' });
  assert.deepEqual((await s.get('/api/info')).body.playUrls, ['https://incident.example.org/#play']);
  assert.deepEqual((await s.get('/api/info?room=b')).body.playUrls, ['https://incident.example.org/r/b/#play']);
});

test('голос зала через API и звук в представлении проектора', async (t) => {
  const s = await start(t);
  await cmd(s, { type: 'sound', on: true });
  await cmd(s, { type: 'start' }); await cmd(s, { type: 'voting' });
  assert.equal((await s.post('/api/audience', { token: 'z1', option: 'B' })).status, 200);
  assert.equal((await s.post('/api/audience', { token: 'z1', option: 'C' })).status, 400);
  const v = (await firstEvent(s.port, 'view=screen')).view;
  assert.equal(v.audienceCount, 1);
  assert.equal(v.sound, true);
  assert.equal((await firstEvent(s.port, 'view=play&token=z1')).view.audienceVote, 'B');
});

test('финал пишет архив сам, без токенов устройств; архив и аналитика — только ведущему', async (t) => {
  const s = await start(t, { gmPin: '1' });
  await s.post('/api/claim', { role: 'scout', token: 'секретный-токен' });
  for (const c of [{ type: 'start' }, { type: 'voting' }, { type: 'reveal', option: 'B' }, { type: 'next' }, { type: 'voting' }, { type: 'reveal', option: 'Y' }, { type: 'next' }]) {
    assert.equal((await cmd(s, c, '1')).status, 200, c.type);
  }
  const files = fs.readdirSync(path.join(s.dir, 'archive'));
  assert.equal(files.length, 1);
  assert.ok(!fs.readFileSync(path.join(s.dir, 'archive', files[0]), 'utf8').includes('секретный-токен'));
  // Откат и повторный финал перезаписывают тот же файл, а не плодят копии.
  await cmd(s, { type: 'undo' }, '1'); await cmd(s, { type: 'next' }, '1');
  assert.equal(fs.readdirSync(path.join(s.dir, 'archive')).length, 1);
  assert.equal((await s.get('/archive')).status, 401);
  assert.equal((await s.get('/api/analytics')).status, 401);
  const a = await s.get('/api/analytics', { 'x-gm-pin': '1' });
  assert.equal(a.body[0].scenarioId, 'mini');
  assert.equal(a.body[0].games, 1);
  assert.equal(a.body[0].topTraps[0].label, 'Рестартнуть всё');
});

test('заголовки безопасности на всех ответах', async (t) => {
  const s = await start(t);
  for (const p of ['/', '/healthz', '/nope']) {
    const r = await fetch(`${BASE}:${s.port}${p}`); await r.arrayBuffer();
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/, p);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
  }
});

test('HTTPS: с сертификатом сервер отдаёт страницу по TLS и ставит HSTS', async (t) => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  } catch (e) { t.skip('нет openssl'); return; }
  const s = await start(t, { dir, tls: { cert: fs.readFileSync(path.join(dir, 'cert.pem')), key: fs.readFileSync(path.join(dir, 'key.pem')) } });
  const https = require('https');
  const r = await new Promise((res, rej) => https.get({ host: '127.0.0.1', port: s.port, path: '/healthz', rejectUnauthorized: false }, res).on('error', rej));
  let body = ''; for await (const ch of r) body += ch;
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(body).tls, true);
  assert.match(r.headers['strict-transport-security'], /max-age/);
});

test('секреты не в адресе: PIN и токен в query игнорируются, работают только cookie', async (t) => {
  const s = await start(t, { gmPin: '4821' });
  await s.post('/api/claim', { role: 'scout', token: 'tok-scout-1' });
  assert.equal((await firstEvent(s.port, 'view=gm&pin=4821', { raw: true })).status, 401, 'PIN в адресе не принимается');
  const v = (await firstEvent(s.port, 'view=play&token=tok-scout-1', { raw: true })).view;
  assert.equal(v.role, null, 'токен в адресе не принимается');
  assert.equal((await firstEvent(s.port, 'view=play&token=tok-scout-1')).view.role.id, 'scout', 'тот же токен в cookie — роль видна');
});

test('сессия ведущего: PIN обменивается на HttpOnly-cookie, выход её отзывает', async (t) => {
  const s = await start(t, { gmPin: '4821' });
  const a = await fetch(`${BASE}:${s.port}/api/auth`, { headers: { 'x-gm-pin': '4821' } });
  const sc = a.headers.get('set-cookie');
  assert.match(sc, /^incw_gm=[0-9a-f]{48};/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  const cookie = sc.split(';')[0];
  assert.equal((await s.post('/api/cmd', { type: 'start' }, { cookie })).status, 200);
  assert.equal((await s.get('/api/pack', { cookie })).status, 200);
  assert.equal((await s.post('/api/logout', {}, { cookie })).status, 200);
  assert.equal((await s.post('/api/cmd', { type: 'next' }, { cookie })).status, 401);
  assert.equal((await s.get('/api/auth')).status, 401, 'без PIN и сессии — 401');
  for (let i = 0; i < 15; i++) await s.get('/api/auth');
  assert.equal((await s.get('/api/auth', { 'x-gm-pin': '4821' })).status, 200, 'запросы без PIN не считаются перебором');
});

test('токен устройства: сервер выдаёт HttpOnly-cookie и переносит старый токен телефона', async (t) => {
  const s = await start(t);
  await s.post('/api/claim', { role: 'domain', token: 'old-token-123' });
  const r = await fetch(`${BASE}:${s.port}/api/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'old-token-123' }) });
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /^incw_dev=old-token-123;/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  const cookie = sc.split(';')[0];
  assert.equal((await firstEvent(s.port, 'view=play', { raw: true, headers: {} })).view.role, null);
  const ac = new AbortController();
  const ev = await fetch(`${BASE}:${s.port}/events?view=play`, { headers: { cookie }, signal: ac.signal });
  const chunk = new TextDecoder().decode((await ev.body.getReader().read()).value);
  ac.abort();
  assert.equal(JSON.parse(chunk.slice(6)).role.id, 'domain', 'роль, занятая до обновления, сохранилась');
  const fresh = await fetch(`${BASE}:${s.port}/api/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.match(fresh.headers.get('set-cookie'), /^incw_dev=[0-9a-f]{24};/);
});

test('запрос с чужого сайта отклоняется (Origin)', async (t) => {
  const s = await start(t);
  assert.equal((await s.post('/api/cmd', { type: 'start' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await s.post('/api/cmd', { type: 'start' }, { origin: `http://127.0.0.1:${s.port}` })).status, 200);
});

test('битая cookie не роняет сервер: поток и выдача токена работают, значение пропускается', async (t) => {
  const s = await start(t);
  const ev = await fetch(`${BASE}:${s.port}/events?view=play`, { headers: { cookie: 'incw_dev=%E0; incw_gm=%' } });
  assert.equal(ev.status, 200);
  await ev.body.cancel();
  const d = await s.post('/api/device', {}, { cookie: 'incw_dev=%E0' });
  assert.equal(d.status, 200);
  assert.equal((await s.post('/api/claim', { role: 'scout' }, { cookie: 'incw_dev=%E0' })).status, 409, 'без токена роль не выдаётся');
  assert.equal((await s.get('/healthz')).status, 200, 'сервер жив');
});

test('сбой записи архива: игра идёт, ведущий видит предупреждение, комната без архива не удаляется', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-srv-'));
  fs.writeFileSync(path.join(dir, 'archive'), 'не каталог'); // mkdir архива упадёт
  const s = await start(t, { dir, archiveDir: path.join(dir, 'archive') });
  await s.post('/api/rooms', { action: 'create', id: 'stol-2' });
  const room = c => s.post('/api/cmd?room=stol-2', c);
  for (const c of [{ type: 'start' }, { type: 'voting' }, { type: 'reveal', option: 'A' }, { type: 'next' }, { type: 'voting' }, { type: 'reveal', option: 'Y' }, { type: 'next' }]) {
    assert.equal((await room(c)).status, 200, c.type);
  }
  assert.equal((await firstEvent(s.port, 'room=stol-2&view=screen')).view.phase, 'end', 'итоги разосланы, несмотря на сбой архива');
  const gm = (await firstEvent(s.port, 'room=stol-2&view=gm')).view;
  assert.ok(gm.storage.archive && gm.storage.archive.message, 'пульт знает о сбое архива');
  const del = await s.post('/api/rooms', { action: 'delete', id: 'stol-2' });
  assert.equal(del.status, 503);
  assert.match(del.body.error, /архив/);
  assert.equal((await firstEvent(s.port, 'room=stol-2&view=screen')).status, 200, 'комната на месте');
  assert.equal((await room({ type: 'reset' })).status, 200, 'новая партия начинается и без архива');
  assert.equal((await s.get('/readyz')).status, 200, 'состояние пишется — сервер готов');
});

test('сбой сохранения состояния: /readyz отвечает 503, пульт видит ошибку; после починки — снова 200', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-srv-'));
  const s = await start(t, { dir });
  assert.equal((await s.get('/readyz')).status, 200);
  fs.mkdirSync(path.join(dir, 'state.json.tmp')); // временный файл не создаётся
  await cmd(s, { type: 'start' });
  const r = await s.get('/readyz');
  assert.equal(r.status, 503);
  assert.equal(r.body.ready, false);
  assert.ok(r.body.storage.persist.message);
  assert.ok((await firstEvent(s.port, 'view=gm')).view.storage.persist, 'пульт знает');
  assert.equal((await s.get('/healthz')).status, 200, 'живость не зависит от диска');
  fs.rmdirSync(path.join(dir, 'state.json.tmp'));
  await cmd(s, { type: 'discussion' });
  assert.equal((await s.get('/readyz')).status, 200);
});

test('битый state.json откладывается рядом, сервер стартует с чистого листа', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-srv-'));
  fs.writeFileSync(path.join(dir, 'state.json'), '{"rooms": {обрыв');
  const errs = [];
  const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  let s;
  try { s = await start(t, { dir }); } finally { console.error = orig; }
  assert.equal((await firstEvent(s.port, 'view=screen')).view.phase, 'lobby');
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('state.json.corrupt-')), 'битый файл сохранён для разбора');
  assert.ok(errs.some(e => /не читается/.test(e)));
});

test('выход с пульта закрывает уже открытый поток ведущего', async (t) => {
  const s = await start(t, { gmPin: '4821' });
  const a = await fetch(`${BASE}:${s.port}/api/auth`, { headers: { 'x-gm-pin': '4821' } });
  const cookie = a.headers.get('set-cookie').split(';')[0];
  const ev = await fetch(`${BASE}:${s.port}/events?view=gm`, { headers: { cookie } });
  assert.equal(ev.status, 200);
  const reader = ev.body.getReader();
  await reader.read(); // первое представление
  await s.post('/api/logout', {}, { cookie });
  let done = false;
  const deadline = Date.now() + 2000;
  while (!done && Date.now() < deadline) {
    try { done = (await reader.read()).done; } catch (e) { done = true; }
  }
  assert.ok(done, 'поток закрыт сервером');
});

test('доверие прокси: X-Forwarded-For от адреса не из списка игнорируется', async (t) => {
  const s = await start(t, { gmPin: '4821', trustProxy: '10.1.1.1' });
  for (let i = 0; i < 10; i++) await s.get('/api/auth', { 'x-gm-pin': 'x', 'x-forwarded-for': `10.0.0.${i}` });
  assert.equal((await s.get('/api/auth', { 'x-gm-pin': '4821', 'x-forwarded-for': '8.8.8.8' })).status, 429, 'подменой заголовка блокировку не обойти');
});

test('частота команд с адреса ограничена; повтор без изменений не пишет состояние', async (t) => {
  const s = await start(t);
  assert.equal((await s.post('/api/claim', { role: 'scout', token: 'tok-1' })).status, 200);
  const file = path.join(s.dir, 'state.json');
  const before = fs.statSync(file).mtimeMs;
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await s.post('/api/claim', { role: 'scout', token: 'tok-1' })).status, 200);
  assert.equal(fs.statSync(file).mtimeMs, before, 'повторный захват своей роли не трогает диск');
  const codes = await Promise.all(Array.from({ length: 30 }, () => s.post('/api/claim', { role: 'scout', token: 'tok-1' }).then(r => r.status)));
  assert.ok(codes.includes(429), 'поток команд упирается в лимит');
});

test('/readyz: готов при исправном диске', async (t) => {
  const s = await start(t);
  const r = await s.get('/readyz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ready: true, closing: false, storage: { persist: null, archive: null } });
});

test('остановка дожидается начатого запроса и отвечает на него', async (t) => {
  const s = await start(t);
  const http = require('http');
  const body = JSON.stringify({ type: 'team', team: 'Остановка' });
  const reply = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/cmd', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(body.slice(0, 5)); // запрос начат, тело ещё идёт
    setTimeout(() => { s.srv.close(); setTimeout(() => req.end(body.slice(5)), 100); }, 50);
  });
  assert.equal(await reply, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8')).rooms.main.session.team, 'Остановка', 'состояние записано');
});

test('структурно битая комната в state.json не роняет старт: она начинается заново, остальные восстанавливаются', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-srv-'));
  const E = require('../workshop-engine.js');
  const good = E.createSession(MINI, { team: 'Целая' });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 3, rooms: {
    main: { scenarioId: 'mini', session: good },
    'stol-2': { scenarioId: 'mini', session: { stepIndex: 0, journal: {}, seats: 'мусор', team: 7 } },
  } }));
  const errs = [];
  const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  let s;
  try { s = await start(t, { dir }); } finally { console.error = orig; }
  assert.equal((await firstEvent(s.port, 'view=screen')).view.team, 'Целая');
  assert.equal((await firstEvent(s.port, 'room=stol-2&view=screen')).view.phase, 'lobby');
  assert.ok(errs.some(e => /stol-2/.test(e)));
});

test('каталог данных недоступен с самого старта — /readyz сразу 503', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-srv-'));
  fs.mkdirSync(path.join(dir, 'state.json.tmp'));
  const orig = console.error; console.error = () => {};
  let s;
  try { s = await start(t, { dir }); } finally { console.error = orig; }
  assert.equal((await s.get('/readyz')).status, 503);
});

test('лимит команд — на устройство: соседи за одним адресом друг другу не мешают', async (t) => {
  const s = await start(t);
  const burst = token => Promise.all(Array.from({ length: 20 }, () => s.post('/api/claim', { role: 'any' }, { cookie: 'incw_dev=' + token }).then(r => r.status)));
  const [a, b] = await Promise.all([burst('dev-a'), burst('dev-b')]);
  assert.ok(a.every(x => x === 200) && b.every(x => x === 200), `${a} / ${b}`);
  const more = await Promise.all(Array.from({ length: 5 }, () => s.post('/api/claim', { role: 'any' }, { cookie: 'incw_dev=dev-a' }).then(r => r.status)));
  assert.ok(more.includes(429), 'устройство упирается в свою квоту');
});

test('голос зала, пришедший перед остановкой, сохраняется', async (t) => {
  const s = await start(t);
  await cmd(s, { type: 'start' }); await cmd(s, { type: 'voting' });
  assert.equal((await s.post('/api/audience', { token: 'zritel-1', option: 'A' })).status, 200);
  await new Promise(res => s.srv.close(res));
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8'));
  assert.equal(saved.rooms.main.session.audience['zritel-1'], 'A');
});
