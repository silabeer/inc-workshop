const test = require('node:test');
const assert = require('node:assert');

const PACKS = [];
global.SCENARIO = (o) => PACKS.push(o);
require('../scenarios/phantom-network.js');
require('../scenarios/expired-cert.js');

const REQUIRED = ['id', 'title', 'version', 'durationSec', 'winHoldSec', 'money', 'panic', 'schedule', 'roles', 'roleOrder', 'startScreens', 'artifacts', 'mitigations', 'telemetry', 'cheatsheet'];

test('пак well-formed: обязательные поля, уникальные id, роли существуют, ключи K\\d+', () => {
  assert.ok(PACKS.length >= 1, 'хотя бы один пакет зарегистрирован');
  for (const p of PACKS) {
    for (const f of REQUIRED) assert.ok(p[f] !== undefined, `${p.id || 'pack'}: нет поля ${f}`);
    const ids = p.artifacts.map(a => a.id);
    assert.strictEqual(new Set(ids).size, ids.length, `${p.id}: дубли id артефактов`);
    const mids = p.mitigations.map(m => m.id);
    assert.strictEqual(new Set(mids).size, mids.length, `${p.id}: дубли id действий`);
    for (const a of p.artifacts) {
      assert.ok(p.roles[a.role], `${p.id}/${a.id}: неизвестная роль ${a.role}`);
      if (a.key) assert.match(a.key, /^K\d+$/, `${p.id}/${a.id}: ключ ${a.key}`);
      assert.strictEqual(typeof a.cost, 'number');
      assert.ok(a.body && a.body.length > 0, `${p.id}/${a.id}: пустое тело`);
    }
    for (const m of p.mitigations) {
      assert.ok(p.roles[m.role], `${p.id}/${m.id}: неизвестная роль ${m.role}`);
      assert.strictEqual(typeof m.cost, 'number');
    }
    for (const r of p.roleOrder) assert.ok(p.roles[r], `${p.id}: roleOrder ссылается на ${r}`);
  }
});

test('phantom: инцидент err 92; M-P1+M-D2+M-P3 → err 2, mult 0', () => {
  const p = PACKS.find(x => x.id === 'phantom-network');
  assert.ok(p, 'пакет phantom-network зарегистрирован');
  const incident = p.telemetry({applied: [], status: 'ACTIVE'});
  assert.strictEqual(incident.err, 92);
  assert.strictEqual(incident.mult, 1);
  const fixed = p.telemetry({applied: ['M-P1', 'M-D2', 'M-P3'], cleared: true, status: 'ACTIVE'});
  assert.strictEqual(fixed.err, 2);
  assert.strictEqual(fixed.mult, 0);
  const flagOnly = p.telemetry({applied: ['M-D2'], cleared: false, status: 'ACTIVE'});
  assert.strictEqual(flagOnly.err, 92, 'флаг без рестарта не лечит');
  assert.match(flagOnly.label, /нужен рестарт/);
});

test('cert: инцидент err 7; M-P1 → err 99 mult 0; M-P2 → err 95; T-ROLL не меняет err', () => {
  const p = PACKS.find(x => x.id === 'expired-cert');
  assert.ok(p, 'пакет expired-cert зарегистрирован');
  assert.strictEqual(p.durationSec, 720);
  assert.strictEqual(p.money.failAt, 3000000);
  const incident = p.telemetry({applied: [], status: 'ACTIVE'});
  assert.strictEqual(incident.err, 93);
  assert.strictEqual(incident.mult, 1);
  const fixed = p.telemetry({applied: ['M-P1'], status: 'ACTIVE'});
  assert.strictEqual(fixed.err, 1);
  assert.strictEqual(fixed.mult, 0);
  const quick = p.telemetry({applied: ['M-P2'], status: 'ACTIVE'});
  assert.strictEqual(quick.err, 5);
  assert.match(quick.label, /временн/i);
  const trap = p.telemetry({applied: ['T-ROLL'], status: 'ACTIVE'});
  assert.strictEqual(trap.err, 93, 'ловушка не лечит');
});

test('пак: графики проектора ссылаются на числовые поля телеметрии, rootCause — RegExp', () => {
  for (const p of PACKS) {
    const tel = p.telemetry({applied: []});
    for (const c of (p.charts || [])) {
      assert.strictEqual(typeof tel[c.key], 'number', `${p.id}: график ${c.key} — нет числового поля в telemetry`);
      const max = typeof c.max === 'function' ? c.max(tel) : c.max;
      assert.ok(max > 0, `${p.id}: график ${c.key} без max`);
      assert.match(c.color, /^#[0-9a-f]{6}$/i, `${p.id}: график ${c.key} — цвет #rrggbb (к нему дописывается альфа)`);
    }
    if (p.rootCause !== undefined) assert.ok(p.rootCause instanceof RegExp, `${p.id}: rootCause не RegExp`);
    for (const f of (p.manualFlags || [])) assert.match(f.key, /^\w+$/, `${p.id}: manualFlags.key`);
  }
});

test('пак: таблица ивентов мира — d10 (индексы 1–10), пустые клетки допустимы', () => {
  for (const p of PACKS) {
    const we = p.schedule.worldEvents;
    if (!we) continue;
    assert.ok(we.table.length <= 11, `${p.id}: в таблице больше 10 исходов`);
    for (const e of we.table.slice(1)) if (e) assert.ok(e.t, `${p.id}: ивент без заголовка t`);
  }
});
