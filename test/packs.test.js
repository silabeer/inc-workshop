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
  {
    file: 'disk-full.js', doc: 'disk-full-logs.md',
    facts: ['184 000', 'lsof +L1', 'kafka.authorizer.logger=INFO', 'PLAT-2291', 'storage.total_limit_size',
      'min.insync.replicas=2', 'notify.push.max_age_min', '/proc/1/fd/187', '158 ГБ', 'reset-offsets --to-latest'],
  },
  {
    file: 'dns-ttl.js', doc: 'dns-ttl-migration.md',
    facts: ['185.12.40.17', '91.208.14.62', 'TTL 41380', 'networkaddress.cache.ttl=-1', '10.20.0.17',
      '×6 112', 'Verify return code: 0', 'frontend :443 mode tcp → backend 91.208.14.62:443', '1 420 → 980', '10:00:14'],
  },
  {
    file: 'retry-cascade.js', doc: 'retry-cascade.md',
    facts: ['57 000', '19:31–19:44', '38,1 млн', 'mesh.retries.enabled: false', 'http2MaxRequests: 300',
      'price_rules_valid_to_idx', '1 600 коннектов при лимите 600', 'retryOn: 5xx,reset,connect-failure', '120 000 ₽/мин', '1 s < 2 s < 5 s'],
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

  if (c.doc) test(`${id}: ключевые факты совпадают с markdown-документом`, () => {
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

test('в scenarios/ нет паков вне списка CASES — каждый кейс проходит проверки выше', () => {
  const files = fs.readdirSync(path.join(ROOT, 'scenarios')).filter(f => f.endsWith('.js')).sort();
  assert.deepEqual(files, CASES.map(c => c.file).sort());
});

test('тексты для проектора читаются с 10 м: ситуация до 450 знаков, вариант до 90', () => {
  for (const c of CASES) {
    const pack = require(path.join(ROOT, 'scenarios', c.file));
    for (const st of pack.steps) {
      assert.ok(st.brief.length <= 450, `${pack.meta.id}/${st.id}: brief ${st.brief.length} знаков`);
      for (const o of st.options) assert.ok(o.label.length <= 90, `${pack.meta.id}/${st.id}/${o.id}: label ${o.label.length} знаков`);
    }
  }
});
