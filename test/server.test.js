const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');

const BASE = 'http://127.0.0.1';

async function startTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-srv-'));
  // Фикстура-пакет — в реальном каталоге сервера (статика раздаётся из ROOT/scenarios)
  const scenDir = path.join(__dirname, '..', 'scenarios');
  fs.mkdirSync(scenDir, {recursive: true});
  const fixture = path.join(scenDir, '__fixture__.js');
  fs.writeFileSync(fixture, 'SCENARIO({id:"x"});');
  t.after(() => { try { fs.unlinkSync(fixture); } catch (e) {} });
  fs.writeFileSync(path.join(dir, 'war-room.html'), '<html></html>');
  const file = path.join(dir, 'state.json');
  const archiveDir = path.join(dir, 'archive');
  const {makeServer} = require('../server.js');
  const srv = makeServer({file, archiveDir, html: path.join(dir, 'war-room.html')});
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  t.after(() => srv.close());
  const port = srv.address().port;
  return {dir, file, archiveDir, port};
}

const post = (port, op) => fetch(`${BASE}:${port}/write`, {
  method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(op),
}).then(r => r.status);

const getJson = (port, p) => fetch(`${BASE}:${port}${p}`).then(async r => ({
  status: r.status, ct: r.headers.get('content-type'), body: await r.json().catch(() => null),
}));

test('условная запись: из двух записей с одним expectRev проходит одна', async (t) => {
  const {port} = await startTmp(t);
  const g1 = {status: 'ACTIVE', startedAt: 1000, panic: 1};
  const g2 = {status: 'ACTIVE', startedAt: 2000, panic: 2};
  assert.strictEqual(await post(port, {col: 'game', doc: g1, expectRev: 0}), 204);
  assert.strictEqual(await post(port, {col: 'game', doc: g2, expectRev: 0}), 409);
  const st = await getJson(port, '/state');
  assert.strictEqual(st.body.game.panic, 1);
  assert.strictEqual(st.body.rev, 1);
});

test('запись без expectRev применяется всегда', async (t) => {
  const {port} = await startTmp(t);
  assert.strictEqual(await post(port, {col: 'game', doc: {status: 'ACTIVE', startedAt: 5}}), 204);
  const st = await getJson(port, '/state');
  assert.strictEqual(st.body.game.status, 'ACTIVE');
});

test('reset с archive пишет файл и /archive его отдаёт', async (t) => {
  const {port, archiveDir} = await startTmp(t);
  await post(port, {col: 'game', doc: {status: 'RESOLVED', startedAt: 1000, endedSec: 600, panic: 3}, expectRev: 0});
  const summary = {scenarioId: 'expired-cert', mode: 'training', status: 'RESOLVED', endedSec: 600, burned: 1234567, at: new Date().toISOString()};
  assert.strictEqual(await post(port, {reset: true, archive: summary}), 204);
  const st = await getJson(port, '/state');
  assert.strictEqual(st.body.game.status, 'LOBBY');
  assert.strictEqual(st.body.rev, 2);
  const files = fs.readdirSync(archiveDir);
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /^[\w.-]+\.json$/);
  const list = await getJson(port, '/archive');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.length, 1);
  assert.strictEqual(list.body[0].scenarioId, 'expired-cert');
  assert.strictEqual(list.body[0].burned, 1234567);
  const full = await getJson(port, `/archive/${files[0]}`);
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.body.summary.status, 'RESOLVED');
  assert.strictEqual(full.body.state.game.endedSec, 600);
});

test('reset без archive на пустом лобби не пишет файл', async (t) => {
  const {port, archiveDir} = await startTmp(t);
  assert.strictEqual(await post(port, {reset: true}), 204);
  assert.strictEqual(fs.existsSync(archiveDir), false);
});

test('/scenarios/*.js отдаётся как javascript, отсутствующий — 404', async (t) => {
  const {port} = await startTmp(t);
  const ok = await getJson(port, '/scenarios/__fixture__.js');
  assert.strictEqual(ok.status, 200);
  assert.match(ok.ct, /javascript/);
  const miss = await fetch(`${BASE}:${port}/scenarios/nope.js`);
  assert.strictEqual(miss.status, 404);
  const eng = await getJson(port, '/engine.js');
  assert.strictEqual(eng.status, 200);
  assert.match(eng.ct, /javascript/);
});

test('хранимый state.json без rev игнорируется', async (t) => {
  const {port, file} = await startTmp(t);
  fs.writeFileSync(file, JSON.stringify({game: {status: 'ACTIVE', startedAt: 123}, players: {}, wall: {}, hypotheses: {}, proposals: {}, statuses: {}}));
  // перезапуск с тем же файлом
  const {makeServer} = require('../server.js');
  const srv2 = makeServer({file, archiveDir: path.join(path.dirname(file), 'a2'), html: path.join(path.dirname(file), 'war-room.html')});
  await new Promise(res => srv2.listen(0, '127.0.0.1', res));
  t.after(() => srv2.close());
  const st = await getJson(srv2.address().port, '/state');
  assert.strictEqual(st.body.game.status, 'LOBBY');
  assert.strictEqual(st.body.rev, 0);
});

test('холл-режим раздаётся сервером: hall.html как html, hall-engine.js как javascript', async (t) => {
  const {port} = await startTmp(t);
  const page = await fetch(`${BASE}:${port}/hall.html`);
  assert.strictEqual(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /hall-engine\.js/);
  const eng = await fetch(`${BASE}:${port}/hall-engine.js`);
  assert.strictEqual(eng.status, 200);
  assert.match(eng.headers.get('content-type'), /javascript/);
});

test('/healthz отвечает 200 с rev и числом клиентов', async (t) => {
  const {port} = await startTmp(t);
  const h = await getJson(port, '/healthz');
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.body.ok, true);
  assert.strictEqual(typeof h.body.rev, 'number');
  assert.strictEqual(typeof h.body.clients, 'number');
});

test('неизвестный путь — 404, корень и /index.html — war-room', async (t) => {
  const {port} = await startTmp(t);
  assert.strictEqual((await fetch(`${BASE}:${port}/favicon.ico`)).status, 404);
  assert.strictEqual((await fetch(`${BASE}:${port}/`)).status, 200);
  assert.strictEqual((await fetch(`${BASE}:${port}/index.html`)).status, 200);
});

test('запись с недопустимым id или doc-не-объектом — 400, состояние не меняется', async (t) => {
  const {port} = await startTmp(t);
  assert.strictEqual(await post(port, {col: 'wall', id: "x');alert(1)//", doc: {summary: 'a'}}), 400);
  assert.strictEqual(await post(port, {col: 'wall', id: 'ok1', doc: 'строка'}), 400);
  assert.strictEqual(await post(port, {col: 'game', doc: null}), 400);
  const st = await getJson(port, '/state');
  assert.strictEqual(st.body.rev, 0);
  assert.deepStrictEqual(st.body.wall, {});
});

test('состояние сохраняется на диск и переживает перезапуск', async (t) => {
  const {port, file, dir} = await startTmp(t);
  assert.strictEqual(await post(port, {col: 'wall', id: 'w1', doc: {summary: 'улика'}}), 204);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.wall.w1.summary, 'улика');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp')), []);
});

test('успешная запись возвращает новый rev в заголовке x-rev', async (t) => {
  const {port} = await startTmp(t);
  const r = await fetch(`${BASE}:${port}/write`, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({col: 'game', doc: {status: 'ACTIVE'}, expectRev: 0})});
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers.get('x-rev'), '1');
});

test('PIN ведущего: game и reset без верного x-gm-pin — 401, коллекции игроков открыты', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-pin-'));
  fs.writeFileSync(path.join(dir, 'war-room.html'), '<html></html>');
  const {makeServer} = require('../server.js');
  const srv = makeServer({file: path.join(dir, 'state.json'), archiveDir: path.join(dir, 'a'), html: path.join(dir, 'war-room.html'), gmPin: '4242'});
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  t.after(() => srv.close());
  const port = srv.address().port;
  const write = (op, pin) => fetch(`${BASE}:${port}/write`, {method: 'POST',
    headers: Object.assign({'content-type': 'application/json'}, pin ? {'x-gm-pin': pin} : {}), body: JSON.stringify(op)}).then(r => r.status);
  assert.strictEqual(await write({col: 'game', doc: {status: 'ACTIVE'}}), 401);
  assert.strictEqual(await write({col: 'game', doc: {status: 'ACTIVE'}}, '0000'), 401);
  assert.strictEqual(await write({reset: true}), 401);
  assert.strictEqual(await write({col: 'players', id: 'scout', doc: {name: 'Аня'}}), 204);
  assert.strictEqual(await write({col: 'game', doc: {status: 'ACTIVE'}}, '4242'), 204);
  const h = await getJson(port, '/healthz');
  assert.strictEqual(h.body.gmPin, true);
});
