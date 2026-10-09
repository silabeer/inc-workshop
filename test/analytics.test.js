const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../workshop-engine.js');
const { aggregate } = require('../analytics.js');
const PACK = require('./fixtures/mini-pack.js');

// Партия: шаг s1 — вариант a (голоса зала — z), шаг s2 — вариант b; на шаг уходит sec секунд.
function game(a, b, sec, z) {
  let s = E.createSession(PACK), t = 0;
  s = E.apply(PACK, s, { type: 'start' }, t);
  for (const [opt, aud] of [[a, z], [b, null]]) {
    s = E.apply(PACK, s, { type: 'voting' }, t += 1000);
    if (aud) aud.forEach((o, i) => { s = E.apply(PACK, s, { type: 'audienceVote', token: 'z' + i, option: o }, t); });
    s = E.apply(PACK, s, { type: 'reveal', option: opt }, t += sec * 1000);
    s = E.apply(PACK, s, { type: 'next' }, t += 1000);
  }
  return { summary: { grade: E.summary(PACK, s).grade.label }, session: s };
}

test('аналитика: частота ловушек, доля лучших ходов, среднее время, совпадение зала с ролями', () => {
  const recs = [game('B', 'Y', 60, ['B', 'B']), game('A', 'Y', 30, ['C']), game('B', 'X', 90, null)];
  const [c] = aggregate(recs, [PACK]);
  assert.equal(c.games, 3);
  assert.equal(c.completed, 3);
  const s1 = c.steps.find(s => s.id === 's1');
  assert.equal(s1.trapRate, 0.67);
  assert.equal(s1.bestRate, 0.33);
  assert.equal(s1.avgSec, 61);
  assert.equal(s1.audienceGames, 2);
  assert.equal(s1.audienceAgreeRate, 0.5, 'в первой партии зал совпал с ролями (B), во второй — нет (C против A)');
  assert.deepEqual(c.topTraps[0], { stepId: 's1', stepTitle: 'Первый шаг', label: 'Рестартнуть всё', count: 2, rate: 0.67 });
  assert.equal(c.slowSteps[0].id, 's1');
  assert.equal(Object.values(c.grades).reduce((a, b) => a + b, 0), 3);
});

test('аналитика: средние — по доигранным партиям', () => {
  const done = game('A', 'Y', 10, null);
  const cut = { summary: {}, session: Object.assign({}, done.session, { score: -5, journal: done.session.journal.slice(0, 1) }) };
  const [c] = aggregate([done, cut], [PACK]);
  assert.equal(c.games, 2);
  assert.equal(c.completed, 1);
  assert.equal(c.avgScore, 4);
  assert.equal(c.averagesOver, 'completed');
});

test('аналитика: пустой архив и чужие кейсы не ломают сводку', () => {
  assert.deepEqual(aggregate([], [PACK]), []);
  assert.deepEqual(aggregate([{ session: { scenarioId: 'другой', journal: [{}] } }, null], [PACK]), []);
});
