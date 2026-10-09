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
async function firstEvent(port, query) {
  const ac = new AbortController();
  const r = await fetch(`${BASE}:${port}/events?${query}`, { signal: ac.signal });
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
  const h = await s.get('/healthz');
  assert.equal(h.body.phase, 'revealed');
  const gm = await firstEvent(s.port, 'view=gm');
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
  assert.deepEqual(Object.keys(h.body).sort(), ['clients', 'gmPin', 'ok', 'phase', 'scenarioId']);
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
  assert.deepEqual(packs.map(p => p.meta.id).sort(), ['expired-cert', 'phantom-network']);
});
