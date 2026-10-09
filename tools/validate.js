#!/usr/bin/env node
// Проверка пака без запуска всего набора тестов: node tools/validate.js scenarios/x.js [ещё.js …]
// Без аргументов проверяет все паки в scenarios/. Код выхода 1, если есть ошибки.
const fs = require('fs'), path = require('path');
const E = require('../workshop-engine.js');

const dir = path.join(__dirname, '..', 'scenarios');
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));

let bad = 0;
for (const f of files) {
  let errs;
  try { errs = E.validate(require(path.resolve(f))); } catch (e) { errs = ['не загружается: ' + e.message]; }
  if (errs.length) {
    bad++;
    console.log(`✗ ${f}`);
    errs.forEach(e => console.log('    ' + e));
  } else {
    const p = require(path.resolve(f));
    console.log(`✓ ${f} — ${p.steps.length} шагов, очки ${E.minScore(p)}…${E.maxScore(p)}`);
  }
}
process.exit(bad ? 1 : 0);
