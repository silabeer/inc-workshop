const test = require('node:test');
const assert = require('node:assert/strict');

const HALL_ENGINE = require('../hall-engine.js');

const PACKS = [];
global.HALL_SCENARIO = (o) => PACKS.push(o);
require('../scenarios/hall-phantom-network.js');
require('../scenarios/hall-expired-cert.js');

function playFirstChoice(pack) {
  let st = HALL_ENGINE.createGame(pack);
  let guard = 0;
  while (st.status !== 'ENDED' && guard++ < 100) {
    const node = pack.nodes[st.nodeId];
    st = HALL_ENGINE.choose(st, node.choices[0].id).state;
  }
  return st;
}

test('hall-пакеты well-formed: validate без ошибок', () => {
  assert.ok(PACKS.length >= 1, 'хотя бы один пакет зарегистрирован');
  for (const p of PACKS) {
    assert.deepEqual(HALL_ENGINE.validate(p), [], `${p.id}: ${JSON.stringify(HALL_ENGINE.validate(p))}`);
  }
});

test('каждый пакет: все роли ведут шаги', () => {
  for (const p of PACKS) {
    const used = new Set(Object.values(p.nodes).filter(n => !n.end).map(n => n.role));
    const declared = new Set(Object.keys(p.roles));
    assert.deepEqual(used, declared, `${p.id}: не все роли в деле (used=${[...used]}, declared=${[...declared]})`);
  }
});

test('phantom: прохождение первым вариантом до end → ENDED, сумма log == score', () => {
  const p = PACKS.find(x => x.id === 'hall-phantom-network');
  assert.ok(p, 'пакет hall-phantom-network зарегистрирован');
  const st = playFirstChoice(p);
  assert.equal(st.status, 'ENDED');
  const sum = st.log.reduce((s, e) => s + e.gained, 0);
  assert.equal(sum, st.score);
});

test('cert: прохождение первым вариантом до end → ENDED, сумма log == score', () => {
  const p = PACKS.find(x => x.id === 'hall-expired-cert');
  assert.ok(p, 'пакет hall-expired-cert зарегистрирован');
  const st = playFirstChoice(p);
  assert.equal(st.status, 'ENDED');
  const sum = st.log.reduce((s, e) => s + e.gained, 0);
  assert.equal(sum, st.score);
});

test('ловушки: hint, начинающийся с «Ловушк», обязан иметь trap:true', () => {
  for (const p of PACKS) {
    for (const n of Object.values(p.nodes)) {
      if (n.end) continue;
      for (const c of n.choices) {
        assert.ok(
          !/^ловушк/i.test(c.hint || '') || c.trap === true,
          `${p.id}/${n.id}/${c.id}: hint прямо называет ловушкой, но trap не выставлен`
        );
      }
    }
  }
});

test('phantom: после решения о срезе ретраев тексты не снова поднимают RPS до 8 500', () => {
  const p = PACKS.find(x => x.id === 'hall-phantom-network');
  const later = ['p8', 'p9', 'p10'].map(id => p.nodes[id].text).join(' ');
  assert.ok(!/8 500/.test(later), 'узлы после среза ретраев снова рисуют RPS 8 500');
});

test('cert: c4 не утверждает, что фикс уже ставится; c7 признаёт применение фикса', () => {
  const p = PACKS.find(x => x.id === 'hall-expired-cert');
  assert.ok(!/ставится/i.test(p.nodes.c4.text), 'c4 рисует фикс в работе даже после отказа от действий');
  assert.ok(/фикс в итоге встал/i.test(p.nodes.c7.text), 'c7 должен признавать, что фикс применён');
});
