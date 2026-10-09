const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../workshop-engine.js');
const PACK = require('./fixtures/mini-pack.js');

const fresh = () => JSON.parse(JSON.stringify(PACK));
const run = (state, ...cmds) => cmds.reduce((s, c, i) => E.apply(PACK, s, c, 1000 * (i + 1)), state);
const voting = () => run(E.createSession(PACK), { type: 'start' }, { type: 'voting' });
const votes = (state, map) => Object.entries(map).reduce((s, [role, option]) => E.apply(PACK, s, { type: 'vote', role, option }, 5000), state);

test('валидный пак: validate без ошибок, очки min…max', () => {
  assert.deepEqual(E.validate(PACK), []);
  assert.equal(E.maxScore(PACK), 4);
  assert.equal(E.minScore(PACK), 0);
});

test('validate: не пять ролей, нет приватки роли, пустые поля', () => {
  const p = fresh(); delete p.roles.comms;
  assert.ok(E.validate(p).some(e => e.includes('пять ролей')));
  const q = fresh(); delete q.steps[0].private.scout;
  assert.ok(E.validate(q).some(e => e.includes('приватного блока роли scout')));
  const r = fresh(); r.steps[1].private.domain.deliver = ' ';
  assert.ok(E.validate(r).some(e => e.includes('domain: пустое deliver')));
});

test('validate: 2–4 варианта, числовые effects, revealText и debrief', () => {
  const p = fresh(); p.steps[1].options.pop();
  assert.ok(E.validate(p).some(e => e.includes('2–4 варианта')));
  const q = fresh(); q.steps[0].options[0].effects.money = '100';
  assert.ok(E.validate(q).some(e => e.includes('числами')));
  const r = fresh(); r.steps[0].options[2].revealText = '';
  assert.ok(E.validate(r).some(e => e.includes('revealText')));
});

test('validate: ровно один лучший вариант, и он не ловушка', () => {
  const p = fresh(); p.steps[1].options[0].score = 2;
  assert.ok(E.validate(p).some(e => e.includes('ровно один лучший')));
  const q = fresh(); q.steps[1].options[1].trap = true;
  assert.ok(E.validate(q).some(e => e.includes('ровно один лучший')));
});

test('validate: debrief «Ловушка…» без trap:true — ошибка', () => {
  const p = fresh(); delete p.steps[0].options[1].trap;
  assert.ok(E.validate(p).some(e => e.includes('trap не true')));
});

test('validate: шкала оценок без дыры внизу и без недостижимых порогов', () => {
  const p = fresh(); p.end.grades[2].min = 1;
  assert.ok(E.validate(p).some(e => e.includes('дыра внизу')));
  const q = fresh(); q.end.grades[0].min = 10;
  assert.ok(E.validate(q).some(e => e.includes('недостижим')));
});

test('validate: focus и state ссылаются на компоненты диаграммы', () => {
  const p = fresh(); p.steps[0].focus = ['zzz']; p.steps[0].state = { a: 'purple' };
  const errs = E.validate(p);
  assert.ok(errs.some(e => e.includes('focus → несуществующий компонент zzz')));
  assert.ok(errs.some(e => e.includes('цвет purple')));
});

test('фазы: лобби → ситуация → обсуждение → голосование → раскрытие → следующий шаг → финал', () => {
  let s = E.createSession(PACK);
  assert.equal(s.phase, 'lobby');
  s = run(s, { type: 'start' }, { type: 'discussion' }, { type: 'voting' });
  assert.equal(s.phase, 'voting');
  s = votes(s, { commander: 'A', scout: 'A', engineer: 'B' });
  s = E.apply(PACK, s, { type: 'reveal' }, 9000);
  assert.equal(s.phase, 'revealed');
  assert.equal(s.revealed, 'A');
  s = E.apply(PACK, s, { type: 'next' }, 10000);
  assert.equal(s.phase, 'situation');
  assert.equal(s.stepIndex, 1);
  assert.deepEqual(s.votes, {});
  s = run(s, { type: 'voting' }, { type: 'vote', role: 'scout', option: 'Y' }, { type: 'reveal' }, { type: 'next' });
  assert.equal(s.phase, 'end');
});

test('недопустимые переходы бросают понятную ошибку и не меняют состояние', () => {
  const s = E.createSession(PACK);
  assert.throws(() => E.apply(PACK, s, { type: 'reveal' }, 1), /после голосования/);
  assert.throws(() => E.apply(PACK, s, { type: 'vote', role: 'scout', option: 'A' }, 1), /закрыто/);
  assert.throws(() => E.apply(PACK, s, { type: 'nope' }, 1), /Неизвестная команда/);
  assert.equal(s.phase, 'lobby');
});

test('голос дважды — нельзя; несуществующий вариант или роль — нельзя', () => {
  const s = votes(voting(), { scout: 'A' });
  assert.throws(() => E.apply(PACK, s, { type: 'vote', role: 'scout', option: 'B' }, 1), /уже учтён/);
  assert.throws(() => E.apply(PACK, s, { type: 'vote', role: 'scout2', option: 'B' }, 1), /Нет такой роли/);
  assert.throws(() => E.apply(PACK, s, { type: 'vote', role: 'comms', option: 'Z' }, 1), /Нет такого варианта/);
});

test('повторное голосование очищает голоса', () => {
  let s = votes(voting(), { scout: 'A', comms: 'B' });
  s = E.apply(PACK, s, { type: 'revote' }, 1);
  assert.deepEqual(s.votes, {});
  s = E.apply(PACK, s, { type: 'vote', role: 'scout', option: 'C' }, 2);
  assert.equal(s.votes.scout, 'C');
});

test('подсчёт: большинство побеждает, кворум — все пять', () => {
  const s = votes(voting(), { commander: 'B', scout: 'A', engineer: 'A', domain: 'C', comms: 'A' });
  const t = E.tally(PACK, s);
  assert.equal(t.winner, 'A');
  assert.equal(t.decidedBy, 'votes');
  assert.equal(t.allVoted, true);
  assert.deepEqual(t.counts, { A: 3, B: 1, C: 1 });
});

test('ничья: решает голос Командира, если он среди лидеров', () => {
  const s = votes(voting(), { commander: 'B', scout: 'A', engineer: 'A', domain: 'B' });
  const t = E.tally(PACK, s);
  assert.equal(t.tie, true);
  assert.equal(t.winner, 'B');
  assert.equal(t.decidedBy, 'commander');
  const r = E.apply(PACK, s, { type: 'reveal' }, 9000);
  assert.equal(r.revealed, 'B');
  assert.equal(r.journal[0].decidedBy, 'commander');
});

test('ничья без голоса Командира среди лидеров — ведущий выбирает вариант', () => {
  const s = votes(voting(), { commander: 'C', scout: 'A', engineer: 'A', domain: 'B', comms: 'B' });
  assert.equal(E.tally(PACK, s).winner, null);
  assert.throws(() => E.apply(PACK, s, { type: 'reveal' }, 1), /Ничья/);
  const r = E.apply(PACK, s, { type: 'reveal', option: 'A' }, 1);
  assert.equal(r.revealed, 'A');
  assert.equal(r.journal[0].decidedBy, 'gm');
});

test('без голосов раскрыть можно только явным вариантом (бумажный режим)', () => {
  assert.throws(() => E.apply(PACK, voting(), { type: 'reveal' }, 1), /Нет голосов/);
  assert.equal(E.apply(PACK, voting(), { type: 'reveal', option: 'C' }, 1).revealed, 'C');
});

test('раскрытие считает очки, метрики и время шага', () => {
  let s = run(E.createSession(PACK), { type: 'start' }, { type: 'voting' }); // start в 1000
  s = E.apply(PACK, votes(s, { scout: 'B' }), { type: 'reveal' }, 61000);
  assert.equal(s.score, -1);
  assert.deepEqual(s.metrics, { tension: 65, money: 400000, ttrMin: 8 });
  assert.equal(s.journal[0].sec, 60);
  assert.equal(s.journal[0].trap, true);
});

test('напряжение в пределах 0–100', () => {
  const p = fresh(); p.steps[0].options[1].effects.tension = 500;
  let s = E.apply(p, E.apply(p, E.apply(p, E.createSession(p), { type: 'start' }, 1), { type: 'voting' }, 2), { type: 'reveal', option: 'B' }, 3);
  assert.equal(s.metrics.tension, 100);
});

test('откат возвращает очки, метрики, журнал и голоса; места не трогает', () => {
  let s = votes(voting(), { scout: 'B', comms: 'B' });
  s = E.apply(PACK, s, { type: 'claim', role: 'domain', token: 't1' }, 1);
  const r = E.apply(PACK, s, { type: 'reveal' }, 9000);
  const released = E.apply(PACK, r, { type: 'release', role: 'domain' }, 9500);
  const u = E.apply(PACK, released, { type: 'undo' }, 10000);
  assert.equal(u.phase, 'voting');
  assert.equal(u.score, 0);
  assert.deepEqual(u.metrics, s.metrics);
  assert.deepEqual(u.journal, []);
  assert.deepEqual(u.votes, { scout: 'B', comms: 'B' });
  assert.equal(u.seats.domain, null, 'освобождённая роль не возвращается откатом');
  assert.throws(() => E.apply(PACK, E.createSession(PACK), { type: 'undo' }, 1), /нечего/);
});

test('места: первый занял — второму закрыто; тот же токен входит снова; ведущий освобождает', () => {
  let s = E.apply(PACK, E.createSession(PACK), { type: 'claim', role: 'scout', token: 'aaa' }, 1);
  assert.throws(() => E.apply(PACK, s, { type: 'claim', role: 'scout', token: 'bbb' }, 2), /занята/);
  s = E.apply(PACK, s, { type: 'claim', role: 'scout', token: 'aaa' }, 3);
  s = E.apply(PACK, s, { type: 'release', role: 'scout' }, 4);
  assert.equal(E.apply(PACK, s, { type: 'claim', role: 'scout', token: 'bbb' }, 5).seats.scout, 'bbb');
});

test('оценка по end.grades и итоги: лучший путь — высшая оценка', () => {
  let s = run(E.createSession(PACK), { type: 'start' }, { type: 'voting' }, { type: 'reveal', option: 'A' }, { type: 'next' },
    { type: 'voting' }, { type: 'reveal', option: 'Y' }, { type: 'next' });
  const sum = E.summary(PACK, s);
  assert.equal(sum.score, 4);
  assert.equal(sum.grade.label, 'Образцово');
  assert.equal(sum.best, 2);
  assert.equal(sum.complete, true);
  assert.equal(E.grade(PACK, -1).label, 'Тяжело');
  assert.equal(E.grade(PACK, 3).label, 'Уверенно');
  const md = E.report(PACK, s);
  assert.match(md, /# Мини-кейс — итоги/);
  assert.match(md, /Дольше всего думали/);
  assert.match(md, /Причина мини-кейса/);
});

test('досрочный финал', () => {
  const s = E.apply(PACK, voting(), { type: 'finish' }, 1);
  assert.equal(s.phase, 'end');
  assert.equal(E.summary(PACK, s).complete, false);
});

test('проектор не видит приватку, голоса по ролям и флаги вариантов', () => {
  const s = votes(voting(), { scout: 'B' });
  const v = E.view(PACK, s, 'screen', { now: 1 });
  const json = JSON.stringify(v);
  assert.ok(!json.includes('секрет-'), 'приватка в представлении проектора');
  assert.ok(!json.includes('Подсказка ведущему'), 'hint в представлении проектора');
  assert.ok(!json.includes('Ловушка: симптом'), 'debrief в представлении проектора');
  assert.ok(!/"trap"|"score":-?\d+,"trap/.test(JSON.stringify(v.step)), 'флаги вариантов на проекторе');
  assert.equal(v.votedCount, 1);
  assert.equal(v.votes, undefined);
});

test('телефон видит только свою приватку и только со своим токеном', () => {
  let s = E.apply(PACK, E.createSession(PACK), { type: 'claim', role: 'scout', token: 'tok' }, 1);
  s = run(s, { type: 'start' }, { type: 'voting' });
  s = votes(s, { engineer: 'C' });
  const v = E.view(PACK, s, 'play', { role: 'scout', token: 'tok', now: 1 });
  assert.equal(v.role.id, 'scout');
  assert.equal(v.private.data, 'секрет-s1-scout');
  const json = JSON.stringify(v);
  assert.ok(!json.includes('секрет-s1-engineer'));
  assert.equal(v.votes, undefined, 'чужие голоса видны телефону');
  assert.equal(v.myVote, null);
  const stranger = E.view(PACK, s, 'play', { role: 'scout', token: 'чужой', now: 1 });
  assert.equal(stranger.role, null);
  assert.equal(stranger.private, null);
});

test('ведущий видит всё: приватку всех ролей, голоса, подсчёт, hint и debrief', () => {
  const s = votes(voting(), { scout: 'B', comms: 'A' });
  const v = E.view(PACK, s, 'gm', { now: 1 });
  assert.equal(v.step.private.engineer.data, 'секрет-s1-engineer');
  assert.deepEqual(v.votes, { scout: 'B', comms: 'A' });
  assert.equal(v.tally.total, 2);
  assert.equal(v.step.hint, 'Подсказка ведущему s1');
  assert.equal(v.step.options.find(o => o.id === 'B').verdict.label, 'Ловушка');
  assert.equal(v.step.options.find(o => o.id === 'A').best, true);
});

test('после раскрытия проектор показывает вердикт и последствия', () => {
  const s = E.apply(PACK, votes(voting(), { scout: 'B' }), { type: 'reveal' }, 9000);
  const v = E.view(PACK, s, 'screen', { now: 9000 });
  assert.equal(v.revealed.verdict.label, 'Ловушка');
  assert.equal(v.revealed.revealText, 'Стало хуже');
  assert.equal(v.revealed.debrief, undefined);
});

test('голос зала: один на устройство, только во время голосования, на решение не влияет', () => {
  let s = votes(voting(), { scout: 'A', engineer: 'A' });
  s = E.apply(PACK, s, { type: 'audienceVote', token: 'z1', option: 'B' }, 1);
  s = E.apply(PACK, s, { type: 'audienceVote', token: 'z2', option: 'B' }, 1);
  s = E.apply(PACK, s, { type: 'audienceVote', token: 'z3', option: 'C' }, 1);
  assert.throws(() => E.apply(PACK, s, { type: 'audienceVote', token: 'z1', option: 'C' }, 1), /уже учтён/);
  assert.deepEqual(E.tallyAudience(PACK, s), { counts: { A: 0, B: 2, C: 1 }, total: 3, leader: 'B' });
  const r = E.apply(PACK, s, { type: 'reveal' }, 9000);
  assert.equal(r.revealed, 'A', 'зал не решает');
  assert.deepEqual(r.journal[0].audience, { counts: { A: 0, B: 2, C: 1 }, total: 3, leader: 'B' });
  assert.throws(() => E.apply(PACK, r, { type: 'audienceVote', token: 'z9', option: 'A' }, 1), /закрыто/);
  const next = E.apply(PACK, r, { type: 'next' }, 10000);
  assert.deepEqual(next.audience, {}, 'голоса зала обнуляются на новом шаге');
});

test('голос зала: устройство с ролью голосует как роль, а не как зал', () => {
  let s = E.apply(PACK, E.createSession(PACK), { type: 'claim', role: 'scout', token: 'tok' }, 1);
  s = run(s, { type: 'start' }, { type: 'voting' });
  assert.throws(() => E.apply(PACK, s, { type: 'audienceVote', token: 'tok', option: 'A' }, 1), /голосуйте как роль/);
});

test('голос зала в итогах, отчёте и представлениях', () => {
  let s = votes(voting(), { scout: 'A' });
  s = E.apply(PACK, s, { type: 'audienceVote', token: 'z1', option: 'C' }, 1);
  const screenVoting = E.view(PACK, s, 'screen', { now: 1 });
  assert.equal(screenVoting.audienceCount, 1);
  assert.equal(JSON.stringify(screenVoting).includes('"C":1'), false, 'до раскрытия проектор не показывает, за что голосует зал');
  assert.equal(E.view(PACK, s, 'play', { token: 'z1', now: 1 }).audienceVote, 'C');
  assert.equal(E.view(PACK, s, 'gm', { now: 1 }).audience.counts.C, 1);
  s = E.apply(PACK, s, { type: 'reveal' }, 2);
  assert.equal(E.view(PACK, s, 'screen', { now: 2 }).revealed.audience.counts.C, 1);
  const sum = E.summary(PACK, s);
  assert.equal(sum.steps[0].audience.leaderLabel, 'Подождать');
  assert.equal(sum.steps[0].audience.agree, false);
  assert.equal(sum.audienceSplit, 1);
  assert.match(E.report(PACK, s), /Зал \(1\) выбрал бы: Подождать/);
});

test('жребий: перестановка мест только в лобби и только корректная', () => {
  let s = E.createSession(PACK);
  s = E.apply(PACK, s, { type: 'claim', role: 'commander', token: 'a' }, 1);
  s = E.apply(PACK, s, { type: 'claim', role: 'scout', token: 'b' }, 1);
  const perm = ['scout', 'commander', 'engineer', 'domain', 'comms'];
  const r = E.apply(PACK, s, { type: 'shuffle', perm }, 2);
  assert.equal(r.seats.commander, 'b');
  assert.equal(r.seats.scout, 'a');
  assert.throws(() => E.apply(PACK, s, { type: 'shuffle', perm: ['scout', 'scout', 'engineer', 'domain', 'comms'] }, 2), /перестановка/);
  const started = E.apply(PACK, s, { type: 'start' }, 3);
  assert.throws(() => E.apply(PACK, started, { type: 'shuffle', perm }, 4), /только в лобби/);
});

test('звук: настройка переживает откат', () => {
  let s = E.apply(PACK, E.createSession(PACK), { type: 'start' }, 1);
  s = E.apply(PACK, s, { type: 'sound', on: true }, 2);
  assert.equal(E.view(PACK, s, 'screen', { now: 2 }).sound, true);
  s = E.apply(PACK, s, { type: 'undo' }, 3);
  assert.equal(s.phase, 'lobby');
  assert.equal(s.sound, true);
});
