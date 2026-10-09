const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const E = require('../workshop-engine.js');

const ROOT = path.join(__dirname, '..');
const CASES = [
  {
    file: 'phantom-network.js', doc: 'phantom-network-asymmetric.md',
    facts: ['×1,02', '76%', 'cl_waiting 70', 'idle in transaction', 'payments.card.fallback_acquirer=true', 'лимит 300 TPS',
      'x-client-retry-count ≥ 1', 'Exit Code: 137', 'с 14:00 до 16:00', 'nofile 4096'],
  },
  {
    file: 'expired-cert.js', doc: 'expired-certificate-training.md',
    facts: ['12:00:00', 'SSL_do_handshake() failed', '/etc/nginx/tls/old.pem', 'jackson 2.15 → 2.16', '68% трафика',
      'ACME-секрет не найден после миграции', 'дежурный отключил cron «до разборки»', '7,4%', 'v1.9.2', 'renew-certs.sh'],
  },
];

// Проходит кейс, выбирая вариант функцией pick(step); ведущий раскрывает выбор явно.
function play(pack, pick) {
  let s = E.createSession(pack), t = 0;
  s = E.apply(pack, s, { type: 'start' }, t);
  while (s.phase !== 'end') {
    s = E.apply(pack, s, { type: 'voting' }, t += 1000);
    s = E.apply(pack, s, { type: 'reveal', option: pick(pack.steps[s.stepIndex]).id }, t += 60000);
    s = E.apply(pack, s, { type: 'next' }, t += 1000);
  }
  return s;
}
const best = st => E.bestOption(st);
const worst = st => st.options.reduce((a, o) => (o.score < a.score ? o : a));
// Пробелы-разделители в паке неразрывные, в markdown — обычные: сравниваем без разницы.
const norm = s => s.replace(/[  ]/g, ' ');

for (const c of CASES) {
  const pack = require(path.join(ROOT, 'scenarios', c.file));
  const id = pack.meta.id;

  test(`${id}: пак проходит валидатор`, () => {
    assert.deepEqual(E.validate(pack), []);
  });

  test(`${id}: лучший путь — высшая оценка и потери в пределах лимита`, () => {
    const s = play(pack, best);
    const sum = E.summary(pack, s);
    assert.equal(sum.score, E.maxScore(pack));
    assert.equal(sum.grade.label, pack.end.grades.slice().sort((a, b) => b.min - a.min)[0].label);
    assert.ok(s.metrics.money <= pack.meta.moneyLimit, `потери ${s.metrics.money} > лимита ${pack.meta.moneyLimit}`);
  });

  test(`${id}: худший путь — низшая оценка и потери сверх лимита`, () => {
    const s = play(pack, worst);
    assert.equal(s.score, E.minScore(pack));
    assert.equal(E.summary(pack, s).grade.label, pack.end.grades.slice().sort((a, b) => a.min - b.min)[0].label);
    assert.ok(s.metrics.money > pack.meta.moneyLimit, 'плохая игра должна пробивать лимит потерь');
  });

  test(`${id}: ключевые факты совпадают с markdown-документом`, () => {
    const packText = norm(fs.readFileSync(path.join(ROOT, 'scenarios', c.file), 'utf8'));
    const docText = norm(fs.readFileSync(path.join(ROOT, c.doc), 'utf8'));
    for (const f of c.facts) {
      assert.ok(packText.includes(f), `«${f}» нет в паке`);
      assert.ok(docText.includes(f), `«${f}» нет в ${c.doc}`);
    }
  });

  test(`${id}: проектор не подсказывает ответ — тексты для зала без «ловушка» и «правильн»`, () => {
    for (const st of pack.steps) {
      for (const t of [st.brief, st.question || ''].concat(st.options.map(o => o.label))) {
        assert.ok(!/ловушк|правильн|лучший ход/i.test(t), `шаг ${st.id}: «${t.slice(0, 60)}»`);
      }
    }
  });
}
