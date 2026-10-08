const test = require('node:test');
const assert = require('node:assert/strict');

const HALL_ENGINE = require('../hall-engine.js');

const ROLES = {
  commander: { name: 'Командир инцидента', short: 'Командир', desc: 'Ведёт доску гипотез.' },
  scout: { name: 'Скаут наблюдаемости', short: 'Скаут', desc: 'Метрики и дашборды.' },
  platform: { name: 'Инженер платформы', short: 'Платформа', desc: 'Kubernetes и сеть.' },
  domain: { name: 'Доменный специалист', short: 'Домен', desc: 'Код и ранбуки.' },
  comms: { name: 'Связной', short: 'Связной', desc: 'Тикеты и статус-страница.' },
};

const DIAGRAM = {
  nodes: [
    { id: 'edge', label: 'edge', x: 10, y: 20, color: 'red', note: '5xx' },
    { id: 'app', label: 'app', x: 300, y: 20, color: 'green' },
    { id: 'db', label: 'db', x: 500, y: 100, color: 'yellow' },
  ],
  edges: [
    { from: 'edge', to: 'app' },
    { from: 'app', to: 'db', label: 'SQL' },
  ],
};

function makeFix() {
  return {
    id: 'fix', title: 'Фикстура', brief: 'тест', start: 'n1',
    roles: JSON.parse(JSON.stringify(ROLES)),
    diagram: JSON.parse(JSON.stringify(DIAGRAM)),
    nodes: {
      n1: {
        id: 'n1', title: 'Узел 1', text: 'ситуация', role: 'commander', roleTask: 'Заведите доску.',
        choices: [
          { id: 'n1a', label: 'хорошо', score: 2, tension: -10, outcome: 'ок', hint: 'подсказка', goto: 'n2' },
          { id: 'n1b', label: 'катастрофа', score: -1, tension: 25, outcome: 'плохо', hint: 'подсказка', goto: 'n2' },
        ],
      },
      n2: {
        id: 'n2', title: 'Узел 2', text: 'ситуация', role: 'scout', roleTask: 'Снимите срез.',
        choices: [
          { id: 'n2a', label: 'вверх', score: 1, tension: -100, outcome: 'ок', hint: 'подсказка', goto: 'nEnd' },
          { id: 'n2b', label: 'вниз', score: 0, tension: 200, outcome: 'так себе', hint: 'подсказка', goto: 'nEnd' },
        ],
      },
      nEnd: { id: 'nEnd', end: true, title: 'Финал', text: 'концовка' },
    },
  };
}

test('validate: валидная фикстура → пустой список ошибок', () => {
  assert.deepEqual(HALL_ENGINE.validate(makeFix()), []);
});

test('validate: битый goto ловит', () => {
  const bad = makeFix();
  bad.nodes.n1.choices[0].goto = 'nope';
  const errs = HALL_ENGINE.validate(bad);
  assert.ok(errs.some(e => /nope/.test(e)), `got: ${errs}`);
});

test('validate: отсутствующий start ловит', () => {
  const bad = makeFix();
  bad.start = 'ghost';
  assert.ok(HALL_ENGINE.validate(bad).length > 0);
});

test('validate: узел с одним вариантом ловит', () => {
  const bad = makeFix();
  bad.nodes.n2.choices = [bad.nodes.n2.choices[0]];
  assert.ok(HALL_ENGINE.validate(bad).some(e => /вариант/.test(e)));
});

test('validate: недостижимый end ловит', () => {
  const bad = makeFix();
  bad.nodes.nLoop = {
    id: 'nLoop', title: 'Петля', text: 't', role: 'scout', roleTask: 'x',
    choices: [{ id: 'l1', label: 'x', score: 0, tension: 0, outcome: 'o', hint: 'h', goto: 'nLoop' }],
  };
  assert.ok(HALL_ENGINE.validate(bad).some(e => /end/i.test(e)));
});

test('validate: нет блока roles ловит', () => {
  const bad = makeFix();
  delete bad.roles;
  assert.ok(HALL_ENGINE.validate(bad).some(e => /roles/.test(e)), `got: ${HALL_ENGINE.validate(bad)}`);
});

test('validate: пустой блок roles ловит', () => {
  const bad = makeFix();
  bad.roles = {};
  assert.ok(HALL_ENGINE.validate(bad).some(e => /roles/.test(e)));
});

test('validate: неизвестная роль в узле ловит', () => {
  const bad = makeFix();
  bad.nodes.n1.role = 'wizard';
  assert.ok(HALL_ENGINE.validate(bad).some(e => /wizard/.test(e)), `got: ${HALL_ENGINE.validate(bad)}`);
});

test('validate: отсутствующая роль в узле ловит', () => {
  const bad = makeFix();
  delete bad.nodes.n1.role;
  assert.ok(HALL_ENGINE.validate(bad).some(e => /роль/.test(e)), `got: ${HALL_ENGINE.validate(bad)}`);
});

test('validate: пустой roleTask ловит', () => {
  const bad = makeFix();
  bad.nodes.n1.roleTask = '';
  assert.ok(HALL_ENGINE.validate(bad).some(e => /roleTask/.test(e)), `got: ${HALL_ENGINE.validate(bad)}`);
});

test('validate: отсутствующая диаграмма ловит', () => {
  const bad = makeFix();
  delete bad.diagram;
  assert.ok(HALL_ENGINE.validate(bad).some(e => /диаграмм/.test(e)), `got: ${HALL_ENGINE.validate(bad)}`);
});

test('validate: пустые nodes диаграммы ловит', () => {
  const bad = makeFix();
  bad.diagram.nodes = [];
  assert.ok(HALL_ENGINE.validate(bad).some(e => /диаграмм/.test(e)));
});

test('validate: дубли id в диаграмме ловит', () => {
  const bad = makeFix();
  bad.diagram.nodes.push({ id: 'edge', label: 'дубль', x: 1, y: 1, color: 'gray' });
  assert.ok(HALL_ENGINE.validate(bad).some(e => /дубль|unique|унік/i.test(e) || /edge/.test(e)), `got: ${HALL_ENGINE.validate(bad)}`);
});

test('validate: ребро диаграммы в никуда ловит', () => {
  const bad = makeFix();
  bad.diagram.edges.push({ from: 'app', to: 'ghost' });
  assert.ok(HALL_ENGINE.validate(bad).some(e => /ghost/.test(e)), `got: ${HALL_ENGINE.validate(bad)}`);
});

test('validate: нечисловые координаты диаграммы ловит', () => {
  const bad = makeFix();
  bad.diagram.nodes[0].x = 'abc';
  assert.ok(HALL_ENGINE.validate(bad).some(e => /x|координ/i.test(e)), `got: ${HALL_ENGINE.validate(bad)}`);
});

test('createGame: дефолты', () => {
  const st = HALL_ENGINE.createGame(makeFix());
  assert.equal(st.scenarioId, 'fix');
  assert.equal(st.nodeId, 'n1');
  assert.equal(st.team, 'Команда зала');
  assert.equal(st.score, 0);
  assert.equal(st.tension, 50);
  assert.deepEqual(st.log, []);
  assert.equal(st.status, 'ACTIVE');
});

test('createGame: своё имя команды', () => {
  const st = HALL_ENGINE.createGame(makeFix(), { team: 'Синее крыло' });
  assert.equal(st.team, 'Синее крыло');
});

test('choose: очки в один командный счёт, tension двигается', () => {
  let r = HALL_ENGINE.choose(HALL_ENGINE.createGame(makeFix()), 'n1a');
  assert.equal(r.result.gained, 2);
  assert.equal(r.result.tension, 40);
  assert.equal(r.state.score, 2);
  assert.equal(r.state.nodeId, 'n2');
  assert.equal(r.state.status, 'ACTIVE');
  r = HALL_ENGINE.choose(r.state, 'n2a');
  assert.equal(r.state.score, 3);
});

test('choose: не мутирует входной state', () => {
  const st = HALL_ENGINE.createGame(makeFix());
  const snapshot = JSON.parse(JSON.stringify(st));
  HALL_ENGINE.choose(st, 'n1a');
  assert.deepEqual(st, snapshot);
});

test('choose: неизвестный choiceId → исключение', () => {
  assert.throws(() => HALL_ENGINE.choose(HALL_ENGINE.createGame(makeFix()), 'nope'));
});

test('choose: после ENDED → исключение', () => {
  let st = HALL_ENGINE.createGame(makeFix());
  st = HALL_ENGINE.choose(st, 'n1a').state;
  st = HALL_ENGINE.choose(st, 'n2a').state;
  assert.equal(st.status, 'ENDED');
  assert.throws(() => HALL_ENGINE.choose(st, 'n2a'));
});

test('choose: tension клампится 0–100', () => {
  let st = HALL_ENGINE.createGame(makeFix());
  st = HALL_ENGINE.choose(st, 'n1b').state; // 50+25=75
  assert.equal(st.tension, 75);
  assert.equal(HALL_ENGINE.choose(st, 'n2a').state.tension, 0);

  let st2 = HALL_ENGINE.createGame(makeFix());
  st2 = HALL_ENGINE.choose(st2, 'n1a').state; // 40
  assert.equal(HALL_ENGINE.choose(st2, 'n2b').state.tension, 100);
});

test('choose: переход в end → ENDED, без поля winner', () => {
  let st = HALL_ENGINE.createGame(makeFix());
  st = HALL_ENGINE.choose(st, 'n1a').state;
  const { state } = HALL_ENGINE.choose(st, 'n2b');
  assert.equal(state.status, 'ENDED');
  assert.equal(state.score, 2);
  assert.ok(!('winner' in state), 'winner не должен существовать в v1.1');
  assert.equal(state.log.length, 2);
});

test('choose: лог фиксирует флаг ловушки выбранного варианта', () => {
  const fix = makeFix();
  fix.nodes.n1.choices[1].trap = true;
  const { state } = HALL_ENGINE.choose(HALL_ENGINE.createGame(fix), 'n1b');
  assert.equal(state.log[0].trap, true, 'trap:true должно попасть в лог');
  const r2 = HALL_ENGINE.choose(state, 'n2a');
  assert.equal(r2.state.log[1].trap, false, 'у обычного варианта trap:false');
});
