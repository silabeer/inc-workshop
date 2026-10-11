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

test('ничья: решает голос Координатора, если он среди лидеров', () => {
  const s = votes(voting(), { commander: 'B', scout: 'A', engineer: 'A', domain: 'B' });
  const t = E.tally(PACK, s);
  assert.equal(t.tie, true);
  assert.equal(t.winner, 'B');
  assert.equal(t.decidedBy, 'commander');
  const r = E.apply(PACK, s, { type: 'reveal' }, 9000);
  assert.equal(r.revealed, 'B');
  assert.equal(r.journal[0].decidedBy, 'commander');
});

test('ничья без голоса Координатора среди лидеров — ведущий выбирает вариант', () => {
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

test('заметки ведущего: по шагам, переживают откат, попадают в отчёт и только в пульт', () => {
  let s = run(E.createSession(PACK), { type: 'start' }, { type: 'voting' });
  s = E.apply(PACK, s, { type: 'note', stepId: 's1', text: 'SRE не прочитал S4 — зал проголосовал за рестарт' }, 3);
  s = E.apply(PACK, s, { type: 'reveal', option: 'B' }, 4);
  s = E.apply(PACK, s, { type: 'undo' }, 5);
  assert.equal(s.notes.s1, 'SRE не прочитал S4 — зал проголосовал за рестарт');
  assert.throws(() => E.apply(PACK, s, { type: 'note', stepId: 'nope', text: 'x' }, 6), /Нет такого шага/);
  assert.equal(E.view(PACK, s, 'gm', { now: 1 }).notes.s1.startsWith('SRE'), true);
  assert.ok(!JSON.stringify(E.view(PACK, s, 'screen', { now: 1 })).includes('SRE не прочитал'), 'заметки не на проекторе');
  s = E.apply(PACK, s, { type: 'reveal', option: 'A' }, 7);
  assert.match(E.report(PACK, s), /## Заметки ведущего\n\n- \*\*Первый шаг:\*\* SRE не прочитал S4/);
  s = E.apply(PACK, s, { type: 'note', stepId: 's1', text: '  ' }, 8);
  assert.equal(s.notes.s1, undefined, 'пустая заметка удаляет');
});

test('reflowData: колонка «label — значение» переносится по колонке значения', () => {
  const out = E.reflowData('  ошибки         100% — TLS handshake failure (все новые подключения приложения)');
  assert.deepEqual(out.split('\n'), [
    '  ошибки         100% — TLS handshake',
    '                 failure (все новые',
    '                 подключения',
    '                 приложения)',
  ]);
});

test('reflowData: обычный текст переносится с отступом исходной строки', () => {
  const out = E.reflowData('Ставка потерь при полной остановке уведомлений — 60 000 ₽/мин');
  assert.deepEqual(out.split('\n'), [
    'Ставка потерь при полной остановке',
    'уведомлений — 60 000 ₽/мин',
  ]);
});

test('reflowData: короткие строки и пустые не трогаются', () => {
  assert.equal(E.reflowData('короткая строка'), 'короткая строка');
  assert.equal(E.reflowData('a\n\nb'), 'a\n\nb');
});

test('reflowData: слово после широкого пробельного захода продолжает по своей колонке', () => {
  // «ephemeral-storage.» стоит дальше 16-й колонки, но до неё строка рвётся раньше —
  // продолжение идёт с отступом исходной строки (пробелы до слова одиночные).
  const out = E.reflowData('  Message: The node was low on resource: ephemeral-storage.');
  assert.deepEqual(out.split('\n'), [
    '  Message: The node was low on',
    '  resource: ephemeral-storage.',
  ]);
});

test('view(play): приватка приходит переформатированной, пак и пульт — нет', () => {
  const long = 'x'.repeat(50) + ' и ещё достаточно длинный хвост строки для переноса';
  const p = fresh();
  p.steps[0].private.scout.data = 'колонка        ' + long;
  const s = run(E.apply(p, E.createSession(p), { type: 'claim', role: 'scout', token: 'tok' }, 1), { type: 'start' });
  const phone = E.view(p, s, 'play', { token: 'tok', now: 1 });
  // ≤ 45: уложенные строки; одиночный неразрывный токен (xxx… 50 шт.) может выступать — его режет word-break
  assert.ok(phone.private.data.split('\n').every(l => l.length <= 45 || /^x+$/.test(l.trim())), 'строки телефона уложены');
  assert.equal(p.steps[0].private.scout.data, 'колонка        ' + long, 'пак не меняется');
  const gm = E.view(p, s, 'gm', { now: 1 });
  assert.equal(gm.step.private.scout.data, 'колонка        ' + long, 'пульт видит оригинал');
});

/* ---------- Вбросы ---------- */

test('validate: вбросы — виды, поля, адресат лички, ровно один звонок', () => {
  const p = fresh(); delete p.distractions;
  assert.ok(E.validate(p).some(e => e.includes('хотя бы один вброс')));
  const q = fresh(); q.distractions[2].kind = 'gossip';
  assert.ok(E.validate(q).some(e => e.includes('kind gossip')));
  const r = fresh(); r.distractions[1].role = 'boss';
  assert.ok(E.validate(r).some(e => e.includes('role boss')));
  const w = fresh(); w.distractions[0].win = '';
  assert.ok(E.validate(w).some(e => e.includes('пустое поле win')));
  const c = fresh(); c.distractions[2].kind = 'call';
  assert.ok(E.validate(c).some(e => e.includes('ровно один звонок')));
  const n = fresh(); n.distractions = n.distractions.filter(d => d.kind !== 'call');
  assert.ok(E.validate(n).some(e => e.includes('ровно один звонок')));
  const d = fresh(); d.distractions[1].id = 'cto';
  assert.ok(E.validate(d).some(e => e.includes('повторный id')));
});

test('вброс: только во время шага, по одному, каждый — раз за партию', () => {
  assert.throws(() => run(E.createSession(PACK), { type: 'interrupt', id: 'cto' }), /только во время шага/);
  const s = run(E.createSession(PACK), { type: 'start' }, { type: 'interrupt', id: 'cto' });
  assert.deepEqual(s.interrupt, { id: 'cto', stepId: 's1', at: 2000, takenBy: null, dismissed: false });
  assert.throws(() => E.apply(PACK, s, { type: 'interrupt', id: 'bk' }, 3000), /Сначала закройте/);
  assert.throws(() => run(E.createSession(PACK), { type: 'start' }, { type: 'interrupt', id: 'nope' }), /Нет такого вброса/);
  const done = E.apply(PACK, s, { type: 'resolve', outcome: 'held' }, 3000);
  assert.throws(() => E.apply(PACK, done, { type: 'interrupt', id: 'cto' }, 4000), /уже был/);
});

test('вброс: до закрытия нельзя дальше и к итогам', () => {
  const s = run(E.createSession(PACK), { type: 'start' }, { type: 'voting' }, { type: 'reveal', option: 'A' }, { type: 'interrupt', id: 'bk' });
  assert.throws(() => E.apply(PACK, s, { type: 'next' }, 9000), /закройте вброс/);
  assert.throws(() => E.apply(PACK, s, { type: 'finish' }, 9000), /закройте вброс/);
  const n = E.apply(PACK, E.apply(PACK, s, { type: 'resolve', outcome: 'lost' }, 9000), { type: 'next' }, 9500);
  assert.equal(n.stepIndex, 1);
});

test('звонок: берут Координатор или Коммуникации, один раз; на звонке Координатор не голосует', () => {
  let s = run(E.createSession(PACK), { type: 'start' }, { type: 'voting' }, { type: 'interrupt', id: 'cto' });
  assert.throws(() => E.apply(PACK, s, { type: 'takeCall', role: 'scout' }, 4000), /Координатор или Коммуникации/);
  s = E.apply(PACK, s, { type: 'takeCall', role: 'commander' }, 4000);
  assert.throws(() => E.apply(PACK, s, { type: 'takeCall', role: 'comms' }, 4000), /уже взяли/);
  assert.throws(() => E.apply(PACK, s, { type: 'vote', role: 'commander', option: 'A' }, 4000), /на звонке/);
  s = E.apply(PACK, s, { type: 'vote', role: 'scout', option: 'A' }, 4000); // остальные голосуют
  assert.equal(E.view(PACK, s, 'play', { token: 'x' }).voteBlocked, null);
  // Коммуникации на звонке голос не теряют
  let m = run(E.createSession(PACK), { type: 'start' }, { type: 'voting' }, { type: 'interrupt', id: 'cto' });
  m = E.apply(PACK, E.apply(PACK, m, { type: 'takeCall', role: 'comms' }, 4000), { type: 'vote', role: 'comms', option: 'A' }, 4100);
  assert.equal(m.votes.comms, 'A');
  // голос, поданный до звонка, остаётся
  let t = run(E.createSession(PACK), { type: 'start' }, { type: 'voting' });
  t = E.apply(PACK, t, { type: 'vote', role: 'commander', option: 'C' }, 3000);
  t = E.apply(PACK, E.apply(PACK, t, { type: 'interrupt', id: 'cto' }, 3500), { type: 'takeCall', role: 'commander' }, 3600);
  assert.equal(t.votes.commander, 'C');
});

test('личка: закрывает только адресат; resolve двигает шкалы, но не очки, и пишет журнал', () => {
  let s = run(E.createSession(PACK), { type: 'start' }, { type: 'interrupt', id: 'pm' });
  assert.throws(() => E.apply(PACK, s, { type: 'dismiss', role: 'comms' }, 3000), /никто не пишет/);
  s = E.apply(PACK, s, { type: 'dismiss', role: 'scout' }, 3000);
  assert.equal(s.interrupt.dismissed, true);
  assert.throws(() => E.apply(PACK, s, { type: 'resolve', outcome: 'meh' }, 3000), /held \| lost/);
  const r = E.apply(PACK, s, { type: 'resolve', outcome: 'lost' }, 12000);
  assert.equal(r.score, 0);
  assert.deepEqual(r.metrics, { tension: E.START_TENSION + 5, money: 0, ttrMin: 2 });
  assert.deepEqual(r.interrupts, [{ id: 'pm', kind: 'ping', stepId: 's1', sec: 10, takenBy: null, outcome: 'lost' }]);
  assert.equal(r.interrupt, null);
  const h = E.apply(PACK, E.apply(PACK, r, { type: 'interrupt', id: 'bk' }, 13000), { type: 'resolve', outcome: 'held' }, 14000);
  assert.equal(h.metrics.tension, E.START_TENSION + 5 - 3);
});

test('вброс: откат запуска и закрытия; старые снимки без полей вбросов', () => {
  const s = run(E.createSession(PACK), { type: 'start' }, { type: 'interrupt', id: 'cto' }, { type: 'resolve', outcome: 'lost' });
  const u1 = E.apply(PACK, s, { type: 'undo' }, 9000);
  assert.equal(u1.interrupt.id, 'cto');
  assert.equal(u1.metrics.tension, E.START_TENSION);
  assert.deepEqual(u1.interrupts, []);
  const u2 = E.apply(PACK, u1, { type: 'undo' }, 9000);
  assert.equal(u2.interrupt, null);
  // партия, сохранённая до вбросов: в снимке истории нет interrupt/interrupts
  const old = run(E.createSession(PACK), { type: 'start' }, { type: 'discussion' });
  for (const h of old.history) { delete h.interrupt; delete h.interrupts; }
  delete old.interrupt; delete old.interrupts;
  const back = E.apply(PACK, old, { type: 'undo' }, 9000);
  assert.equal(back.interrupt, null);
  assert.deepEqual(back.interrupts, []);
  assert.equal(E.view(PACK, old, 'screen').interrupt, null);
  assert.deepEqual(E.view(PACK, old, 'gm').interrupts, []);
});

test('вброс: проектор видит звонок и алерт, но не текст лички и не критерий; телефон — только участник', () => {
  const call = run(E.createSession(PACK, { seats: { commander: 't-c', comms: 't-m', scout: 't-s' } }), { type: 'start' }, { type: 'interrupt', id: 'cto' });
  const sc = E.view(PACK, call, 'screen').interrupt;
  assert.deepEqual(sc, { kind: 'call', title: 'Звонок CTO', from: 'CTO', text: '«Координатора — в звонок»', roleName: null, at: 2000, takenByName: null, dismissed: false });
  assert.equal(E.view(PACK, call, 'play', { token: 't-c' }).interrupt.kind, 'call');
  assert.equal(E.view(PACK, call, 'play', { token: 't-m' }).interrupt.kind, 'call');
  assert.equal(E.view(PACK, call, 'play', { token: 't-s' }).interrupt, null);
  const taken = E.apply(PACK, call, { type: 'takeCall', role: 'comms' }, 3000);
  assert.equal(E.view(PACK, taken, 'screen').interrupt.takenByName, 'Коммуникации');

  const ping = run(E.createSession(PACK, { seats: { scout: 't-s', comms: 't-m' } }), { type: 'start' }, { type: 'interrupt', id: 'pm' });
  const json = JSON.stringify(E.view(PACK, ping, 'screen'));
  assert.ok(!json.includes('секрет-лички') && !json.includes('Отложил'), 'текст лички и критерий не на проекторе');
  assert.equal(E.view(PACK, ping, 'screen').interrupt.title, 'Личка: SRE');
  assert.equal(E.view(PACK, ping, 'play', { token: 't-s' }).interrupt.text, 'секрет-лички');
  assert.equal(E.view(PACK, ping, 'play', { token: 't-m' }).interrupt, null);
  assert.ok(!JSON.stringify(E.view(PACK, ping, 'play', { token: 't-m' })).includes('секрет-лички'));
  const gm = E.view(PACK, ping, 'gm');
  assert.equal(gm.interrupt.title, 'Личка SRE: PM');
  assert.equal(gm.distractions.find(d => d.id === 'pm').win, 'Отложил');
});

test('вбросы в итогах и отчёте', () => {
  let s = run(E.createSession(PACK), { type: 'start' }, { type: 'interrupt', id: 'cto' });
  s = E.apply(PACK, s, { type: 'takeCall', role: 'comms' }, 3000);
  s = run(s, { type: 'resolve', outcome: 'held' }, { type: 'interrupt', id: 'bk' }, { type: 'resolve', outcome: 'lost' });
  s = run(s, { type: 'finish' });
  assert.deepEqual(E.summary(PACK, s).interrupts, { total: 2, held: 1 });
  const md = E.report(PACK, s);
  assert.match(md, /## Вбросы: отбили 1 из 2/);
  assert.match(md, /Звонок CTO \(Первый шаг, .*\): отбили, трубку взял\(и\): Коммуникации/);
  assert.match(md, /Алерт: \[WARNING\] backup-job \(Первый шаг, .*\): сбило/);
});

test('validate: отказ инструмента адресован роли с данными, handover без роли', () => {
  const p = fresh(); delete p.distractions.find(d => d.kind === 'outage').role;
  assert.ok(E.validate(p).some(e => e.includes('role undefined')));
  const q = fresh(); q.distractions.find(d => d.kind === 'outage').role = 'commander';
  assert.ok(E.validate(q).some(e => e.includes('у Координатора нет данных')));
});

test('отказ инструмента: у адресата нет данных шага, у остальных есть; проектор знает, кто без данных', () => {
  const seats = { scout: 't-s', engineer: 't-e' };
  const s = run(E.createSession(PACK, { seats }), { type: 'start' }, { type: 'interrupt', id: 'graf' });
  const mine = E.view(PACK, s, 'play', { token: 't-s' });
  assert.deepEqual(mine.private, { hidden: true });
  assert.ok(!JSON.stringify(mine).includes('секрет-s1-scout'));
  assert.equal(mine.interrupt.kind, 'outage');
  assert.equal(E.view(PACK, s, 'play', { token: 't-e' }).private.data, 'секрет-s1-engineer');
  assert.equal(E.view(PACK, s, 'play', { token: 't-e' }).interrupt, null);
  const sc = E.view(PACK, s, 'screen').interrupt;
  assert.equal(sc.title, 'Отказ: Grafana');
  assert.equal(sc.roleName, 'SRE');
  const back = E.apply(PACK, s, { type: 'resolve', outcome: 'held' }, 5000);
  assert.equal(E.view(PACK, back, 'play', { token: 't-s' }).private.data, 'секрет-s1-scout');
});

test('выбыл Координатор: не голосует и без данных, командование берёт другая роль и решает ничью', () => {
  const seats = { commander: 't-c', scout: 't-s' };
  let s = run(E.createSession(PACK, { seats }), { type: 'start' }, { type: 'voting' }, { type: 'interrupt', id: 'out' });
  assert.throws(() => E.apply(PACK, s, { type: 'vote', role: 'commander', option: 'A' }, 4000), /выбыли/);
  const cmd = E.view(PACK, s, 'play', { token: 't-c' });
  assert.deepEqual(cmd.private, { hidden: true });
  assert.equal(cmd.interrupt.out, true);
  assert.equal(cmd.voteBlocked, 'Вы выбыли — командует другая роль');
  assert.equal(E.view(PACK, s, 'play', { token: 't-s' }).interrupt.out, false);
  assert.throws(() => E.apply(PACK, s, { type: 'takeCommand', role: 'commander' }, 4000), /остальных ролей/);
  // ничья до того, как кто-то взял командование, — решает ведущий
  s = votes(s, { scout: 'A', engineer: 'C' });
  assert.equal(E.tally(PACK, s).winner, null);
  assert.equal(E.tally(PACK, s).namer, null);
  assert.throws(() => E.apply(PACK, s, { type: 'reveal' }, 4400), /решающего голоса нет/);
  s = E.apply(PACK, s, { type: 'takeCommand', role: 'engineer' }, 4500);
  assert.throws(() => E.apply(PACK, s, { type: 'takeCommand', role: 'scout' }, 4600), /уже взяли/);
  const t = E.tally(PACK, s);
  assert.equal(t.winner, 'C');
  assert.equal(t.decidedBy, 'acting');
  const r = E.apply(PACK, s, { type: 'reveal' }, 5000);
  assert.equal(r.journal[0].decidedBy, 'acting');
  assert.equal(E.view(PACK, r, 'screen').revealed.decidedBy, 'acting');
  assert.equal(E.view(PACK, s, 'screen').interrupt.takenByName, 'Platform Engineer');
  // после возвращения ничью снова решает Координатор
  const back = E.apply(PACK, r, { type: 'resolve', outcome: 'held' }, 6000);
  assert.equal(back.interrupts[0].takenBy, 'engineer');
  assert.equal(E.view(PACK, back, 'play', { token: 't-c' }).voteBlocked, null);
  assert.match(E.report(PACK, E.apply(PACK, back, { type: 'finish' }, 7000)), /Координатор выбыл .*командовал\(и\): Platform Engineer/);
});

test('новый человек на бридже: только проектор; подписи пульта различают вбросы одного вида', () => {
  const s = run(E.createSession(PACK, { seats: { comms: 't-m' } }), { type: 'start' }, { type: 'interrupt', id: 'mkt' });
  assert.equal(E.view(PACK, s, 'screen').interrupt.title, 'Новые люди на бридже');
  assert.equal(E.view(PACK, s, 'screen').interrupt.from, 'Маркетинг');
  assert.equal(E.view(PACK, s, 'play', { token: 't-m' }).interrupt, null);
  const labels = E.view(PACK, s, 'gm').distractions.map(d => d.label);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.includes('Личка SRE: PM'));
});
