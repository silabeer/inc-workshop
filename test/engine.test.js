const test = require('node:test');
const assert = require('node:assert');
const ENGINE = require('../engine.js');

// Стуб пакета для экономики (спек §3: money/panic/telemetry)
const tiers = [
  {min:0,max:4,name:'a',mult:1,cost:1},
  {min:5,max:9,name:'b',mult:2,cost:1.5},
  {min:10,max:14,name:'c',mult:4,cost:1.5},
  {min:15,max:18,name:'d',mult:4,cost:1.5},
  {min:19,max:20,name:'e',mult:4,cost:1.5},
];
const pack = {
  money:{basePerMin:150000},
  panic:{tiers},
  telemetry:(g)=>({mult: g&&g.applied&&g.applied.includes('FIX')?0:1.0}),
};

test('gameSec: ACTIVE отдаёт игровые секунды', () => {
  const g = {status:'ACTIVE', startedAt:1000, pausedTotal:0};
  assert.strictEqual(ENGINE.gameSec(g, 61000), 60);
});

test('gameSec: PAUSED замораживает время', () => {
  const g = {status:'PAUSED', startedAt:1000, pausedAt:31000, pausedTotal:0};
  assert.strictEqual(ENGINE.gameSec(g, 999000), 30);
});

test('gameSec: ended отдаёт endedSec вне зависимости от now', () => {
  const g = {status:'RESOLVED', startedAt:1000, endedSec:77};
  assert.strictEqual(ENGINE.gameSec(g, 500000), 77);
});

test('burned: интегрирует сегменты ставки по игровому времени', () => {
  const g = {status:'ACTIVE', startedAt:1000, pausedTotal:0,
             rateSegments:[{t:0,rate:150000},{t:60,rate:300000}]};
  assert.strictEqual(ENGINE.burned(g, 121000), 450000);
});

test('tierOf: границы тиров', () => {
  const at = (p) => ENGINE.tierOf(p, tiers).name;
  assert.strictEqual(at(0), 'a');  assert.strictEqual(at(4), 'a');
  assert.strictEqual(at(5), 'b');  assert.strictEqual(at(9), 'b');
  assert.strictEqual(at(10), 'c'); assert.strictEqual(at(14), 'c');
  assert.strictEqual(at(15), 'd'); assert.strictEqual(at(18), 'd');
  assert.strictEqual(at(19), 'e'); assert.strictEqual(at(20), 'e');
});

test('currentRate: множители паники и телеметрии', () => {
  const g = {status:'ACTIVE', startedAt:0, pausedTotal:0, panic:12};
  assert.strictEqual(ENGINE.currentRate(g, pack, 1000), 600000); // 150k × 1.0 × 4
});

test('currentRate: шторм саппорта +20%', () => {
  const g = {status:'ACTIVE', startedAt:0, pausedTotal:0, panic:12, storm:true};
  assert.strictEqual(ENGINE.currentRate(g, pack, 1000), 720000);
});

test('currentRate: нулевой mult телеметрии обнуляет ставку', () => {
  const g = {status:'ACTIVE', startedAt:0, pausedTotal:0, panic:0, applied:['FIX']};
  assert.strictEqual(ENGINE.currentRate(g, pack, 1000), 0);
});

test('currentRate: LOBBY/RESOLVED/FAILED дают ноль', () => {
  for (const status of ['LOBBY','RESOLVED','FAILED']) {
    const g = {status, startedAt:0, pausedTotal:0, panic:12};
    assert.strictEqual(ENGINE.currentRate(g, pack, 1000), 0, status);
  }
});

/* ---------- planAutopilot (Task 3) ---------- */
const apPack = {
  durationSec: 720, winHoldSec: 60, winErrPct: 5,
  money: {basePerMin: 150000, failAt: 3000000, stabilizeAtMult: 0.3},
  panic: {tiers, autoEverySec: 180, silenceAfterSec: 240, meltdownAt: 20, meltdownHoldSec: 90},
  schedule: {
    cioCall: {atSec: 120, durationSec: 90, panicEverySec: 45, caller: 'CIO', lines: []},
    worldEvents: {rollsAt: [360], table: [null,
      {t: 'Шторм', fx: 'storm'}, {t: 'Паника+1', fx: 'panic1'},
      {t: 'Скаут x2', fx: 'scout-x2'}, {t: 'Облегчение', fx: 'transient', transientSec: 30}]},
  },
  telemetry: (g) => ({err: g && g.applied && g.applied.includes('M-FIX') ? 2 : 92, mult: g && g.applied && g.applied.includes('M-FIX') ? 0 : 1.0}),
  mitigations: [
    {id: 'M-FIX', role: 'platform', title: 'Починить', cost: 90, review: true, trap: false},
    {id: 'T-TRAP', role: 'platform', title: 'Ловушка', cost: 60, review: false, trap: true},
    {id: 'M-HOOK', role: 'domain', title: 'Хук', cost: 30, review: false,
     apply: (A) => A.has('GATE') ? {add: ['M-HOOK'], set: {cleared: true}} : {add: ['M-HOOK'], transientSec: 30}},
  ],
};
const mkGame = (over) => Object.assign({status: 'ACTIVE', startedAt: 1000, pausedTotal: 0, panic: 0, applied: [], rateSegments: [], events: [], fired: {}, lastAutoPanic: 0, lastStatusAt: 0, silenceFlagAt: 0}, over);
const mkState = (game, proposals = {}) => ({rev: 0, game, players: {}, wall: {}, hypotheses: {}, proposals, statuses: {}});
const run = (st, T, rng) => ENGINE.planAutopilot(st, apPack, 1000 + T * 1000, rng || (() => 0.99));
function applyPlan(st, plan) {
  if (!plan) return st;
  st.game = Object.assign({}, st.game, plan.patch);
  for (const p of (plan.props || [])) st.proposals[p.id] = p.doc;
  return st;
}
const noCall = {call: 1}; // подавить авто-звонок в тестах действий

test('автопилот: пауза — планировщик молчит', () => {
  const st = mkState(mkGame({status: 'PAUSED', pausedAt: 2000}));
  assert.strictEqual(run(st, 500), null);
});

test('автопилот: авто-паника каждые 180с, тишина после 240с', () => {
  let st = mkState(mkGame());
  let plan = run(st, 179); assert.ok(!plan || !plan.patch.panic);
  plan = run(st, 180); assert.strictEqual(plan.patch.panic, 1);
  st = applyPlan(st, plan);
  plan = run(st, 240); assert.strictEqual(plan.patch.panic, 2); // вторая авто-паника
  st = applyPlan(st, plan);
  plan = run(st, 241); assert.strictEqual(plan.patch.panic, 3); // штраф тишины
  assert.match(plan.patch.panicLog.at(-1).why, /статус/);
  st = applyPlan(st, plan);
  plan = run(st, 280);
  assert.ok(!plan || !plan.patch.panic); // тишина не повторяется до нового апдейта; тик звонка ещё не наступил
});

test('автопилот: звонок стартует в atSec один раз', () => {
  let st = mkState(mkGame());
  assert.strictEqual(run(st, 119), null);
  let plan = run(st, 120);
  assert.strictEqual(plan.patch.call.active, true);
  st = applyPlan(st, plan);
  plan = run(st, 121);
  assert.ok(!plan || !plan.patch.call);
});

test('автопилот: звонок +1 на 45с без ответа, таймаут на 90с', () => {
  let st = mkState(mkGame({call: {active: true, caller: 'CIO', startedAt: 120, ticks: 0}}));
  let plan = run(st, 165);
  assert.strictEqual(plan.patch.call.ticks, 1);
  assert.strictEqual(plan.patch.panic, 1);
  st = applyPlan(st, plan);
  plan = run(st, 210);
  assert.strictEqual(plan.patch.call.active, false);
  assert.strictEqual(plan.patch.call.result, 'timeout');
});

test('автопилот: ивент один раз, fx применяются', () => {
  let st = mkState(mkGame());
  let plan = run(st, 360, () => 0.04); // d10=1 → storm
  assert.strictEqual(plan.patch.storm, true);
  assert.ok(plan.events.some(e => /d10=1/.test(e.msg)));
  st = applyPlan(st, plan);
  plan = run(st, 361, () => 0.99);
  assert.ok(!plan || !plan.patch.storm);
  // слот ивента уже сработал: другой rng не перебрасывает
  plan = run(st, 362, () => 0.14);
  assert.ok(!plan || plan.patch.storm !== true);
  // fx panic1 на слоте, который ещё не бросался
  st = mkState(mkGame({fired: {}, lastAutoPanic: 10000, lastStatusAt: 400}));
  plan = run(st, 400, () => 0.14); // d10=2 → panic1
  assert.strictEqual(plan.patch.panic, 1);
});

test('автопилот: действие done ровно в goAt+cost, эффект в applied', () => {
  const st = mkState(mkGame({fired: noCall, lastAutoPanic: 10000}), {p1: {id: 'p1', mitId: 'M-FIX', role: 'platform', cards: ['w1'], status: 'go', goAt: 100, t: 50}});
  assert.strictEqual(run(st, 189), null);
  const plan = run(st, 190);
  assert.strictEqual(plan.patch.applied.includes('M-FIX'), true);
  assert.strictEqual(plan.props[0].doc.status, 'done');
  assert.match(plan.events[0].msg, /Выполнено M-FIX/);
});

test('автопилот: ревью добавляет 30с', () => {
  const base = {id: 'p1', mitId: 'M-FIX', role: 'platform', cards: ['w1'], status: 'go', goAt: 100, t: 50, reviewedBy: 'domain'};
  const st = mkState(mkGame({fired: noCall, lastAutoPanic: 10000}), {p1: base});
  assert.strictEqual(run(st, 219), null);
  const plan = run(st, 220);
  assert.strictEqual(plan.props[0].doc.status, 'done');
});

test('автопилот: ловушка +2, вслепую +2, ловушка вслепую +4', () => {
  let st = mkState(mkGame(), {p1: {id: 'p1', mitId: 'T-TRAP', role: 'platform', cards: ['w1'], status: 'go', goAt: 0, t: 0}});
  let plan = run(st, 60);
  assert.strictEqual(plan.patch.panic, 2);
  st = mkState(mkGame(), {p1: {id: 'p1', mitId: 'T-TRAP', role: 'platform', cards: [], status: 'go', goAt: 0, t: 0}});
  plan = run(st, 60);
  assert.strictEqual(plan.patch.panic, 4);
  st = mkState(mkGame({lastAutoPanic: 10000}), {p1: {id: 'p1', mitId: 'M-FIX', role: 'platform', cards: [], status: 'go', goAt: 0, t: 0}});
  plan = run(st, 90);
  assert.strictEqual(plan.patch.panic, 0); // +2 вслепую и −3 стабилизация, кламп в 0
  const whys = plan.patch.panicLog.map(x => x.why).join(' | ');
  assert.match(whys, /вслепую/);
  assert.match(whys, /стабилизация/);
});

test('автопилот: стабилизация −3 один раз', () => {
  let st = mkState(mkGame({fired: noCall, lastAutoPanic: 10000}), {p1: {id: 'p1', mitId: 'M-FIX', role: 'platform', cards: ['w1'], status: 'go', goAt: 0, t: 0}});
  let plan = run(st, 90);
  assert.strictEqual(plan.patch.panic, 0); // 0 + (−3 кламп)
  assert.strictEqual(plan.patch.fired.stab, 1);
  st = applyPlan(st, plan);
  plan = run(st, 200);
  assert.ok(!plan || !plan.patch.panicLog); // повторного −3 нет (звонок в этом плане неважен)
});

test('автопилот: d10 ревью-риска — ошибка на 1–2', () => {
  const p = {id: 'p1', mitId: 'M-FIX', role: 'platform', cards: ['w1'], status: 'go', goAt: 0, t: 0};
  let plan = run(mkState(mkGame({fired: noCall, lastAutoPanic: 10000}), {p1: p}), 90, () => 0.05); // d=1
  assert.match(plan.events[0].msg, /d10=1/);
  assert.match(plan.events[0].msg, /ОШИБКА/);
  plan = run(mkState(mkGame({fired: noCall, lastAutoPanic: 10000}), {p1: p}), 90, () => 0.99); // d=10
  assert.match(plan.events[0].msg, /d10=10/);
  assert.doesNotMatch(plan.events[0].msg, /ОШИБКА/);
});

test('автопилот: apply-хук (cleared vs transient)', () => {
  let st = mkState(mkGame({applied: ['GATE'], fired: noCall}), {p1: {id: 'p1', mitId: 'M-HOOK', role: 'domain', cards: ['w1'], status: 'go', goAt: 0, t: 0}});
  let plan = run(st, 30);
  assert.strictEqual(plan.patch.cleared, true);
  assert.strictEqual(plan.patch.transientUntil, undefined);
  st = mkState(mkGame({fired: noCall, lastAutoPanic: 10000}), {p1: {id: 'p1', mitId: 'M-HOOK', role: 'domain', cards: ['w1'], status: 'go', goAt: 0, t: 0}});
  plan = run(st, 30);
  assert.strictEqual(plan.patch.transientUntil, 1000 + 30 * 1000 + 30000);
  assert.strictEqual(plan.patch.cleared, undefined);
});

test('автопилот: FAILED по времени, мелтдауну и деньгам; win защищает от FAILED', () => {
  let st = mkState(mkGame({fired: {stab: 1}, applied: ['M-FIX']}));
  let plan = run(st, 60);
  assert.strictEqual(plan.patch.fired.winSince, 60);
  st = applyPlan(st, plan);
  plan = run(st, 120);
  assert.strictEqual(plan.patch.fired.win, 1);
  st = applyPlan(st, plan);
  plan = run(st, 720);
  assert.ok(!plan || plan.patch.status !== 'FAILED');
  // без win — FAILED по durationSec
  st = mkState(mkGame());
  plan = run(st, 720);
  assert.strictEqual(plan.patch.status, 'FAILED');
  assert.strictEqual(plan.patch.endedSec, 720);
  // мелтдаун: паника 20 держится 90с
  st = mkState(mkGame({panic: 20}));
  plan = run(st, 100);
  assert.ok(!plan || plan.patch.status !== 'FAILED');
  st = applyPlan(st, plan);
  plan = run(st, 190);
  assert.strictEqual(plan.patch.status, 'FAILED');
  // деньги: 3 млн за минуту
  st = mkState(mkGame({rateSegments: [{t: 0, rate: 3000000}]}));
  plan = run(st, 60);
  assert.strictEqual(plan.patch.status, 'FAILED');
});

test('автопилот: два действия в один тик не затирают друг друга в applied', () => {
  const st = mkState(mkGame({fired: noCall, lastAutoPanic: 10000}), {
    p1: {id: 'p1', mitId: 'M-FIX', role: 'platform', cards: ['w1'], status: 'go', goAt: 0, t: 0},
    p2: {id: 'p2', mitId: 'M-HOOK', role: 'domain', cards: ['w1'], status: 'go', goAt: 0, t: 0},
  });
  const plan = run(st, 90); // оба doneAt ≤ 90
  assert.strictEqual(plan.props.length, 2);
  assert.ok(plan.patch.applied.includes('M-FIX'), 'M-FIX в applied');
  assert.ok(plan.patch.applied.includes('M-HOOK'), 'M-HOOK в applied');
});

test('автопилот: FAILED во время звонка CIO закрывает звонок', () => {
  const st = mkState(mkGame({call: {active: true, caller: 'CIO', startedAt: 700, ticks: 0, dur: 90}, fired: {call: 1}}));
  const plan = run(st, 720);
  assert.strictEqual(plan.patch.status, 'FAILED');
  assert.strictEqual(plan.patch.call.active, false);
});

test('eventPatch: эффекты ивента мира — общие для автопилота и ручного броска', () => {
  const now = 50000;
  assert.deepStrictEqual(ENGINE.eventPatch({fx: 'storm'}, now), {patch: {storm: true}, panic: 0});
  assert.deepStrictEqual(ENGINE.eventPatch({fx: 'panic1'}, now), {patch: {}, panic: 1});
  assert.deepStrictEqual(ENGINE.eventPatch({fx: 'scout-x2'}, now), {patch: {scoutX2: true}, panic: 0});
  assert.deepStrictEqual(ENGINE.eventPatch({fx: 'transient', transientSec: 10}, now), {patch: {transientUntil: 60000}, panic: 0});
  assert.deepStrictEqual(ENGINE.eventPatch({fx: 'transient'}, now), {patch: {transientUntil: 80000}, panic: 0});
  assert.deepStrictEqual(ENGINE.eventPatch(null, now), {patch: {}, panic: 0});
});

test('автопилот: обратимое действие (reversible) без улик не штрафуется «вслепую»', () => {
  const pk = Object.assign({}, apPack, {mitigations: apPack.mitigations.concat([{id: 'M-FLAG', role: 'domain', title: 'Флаг', cost: 30, review: false, reversible: true}])});
  const st = mkState(mkGame({fired: noCall}), {p1: {mitId: 'M-FLAG', status: 'go', goAt: 0, cards: []}});
  const plan = ENGINE.planAutopilot(st, pk, 1000 + 30 * 1000, () => 0.99);
  assert.ok(!plan.patch.panic, 'паника не должна вырасти');
});

test('автопилот: стабилизация фиксирует mitigatedSec (TTM)', () => {
  const st = mkState(mkGame({fired: noCall}), {p1: {mitId: 'M-FIX', status: 'go', goAt: 10, cards: ['w1'], reviewedBy: 'scout'}});
  const plan = run(st, 130);
  assert.strictEqual(plan.patch.mitigatedSec, 130);
});
