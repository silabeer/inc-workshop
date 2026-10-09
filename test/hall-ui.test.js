const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('hall.html', 'utf8');

test('hall.html: все инлайн-скрипты парсятся', () => {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, count = 0;
  while ((m = re.exec(html)) !== null) {
    count++;
    assert.doesNotThrow(() => new Function(m[1]), `инлайн-скрипт #${count} не парсится`);
  }
  assert.ok(count >= 1, 'найден хотя бы один инлайн-скрипт');
});

test('hall.html: подключает движок и оба сценария относительными путями', () => {
  for (const src of ['hall-engine.js', 'scenarios/hall-phantom-network.js', 'scenarios/hall-expired-cert.js']) {
    assert.ok(html.includes(`src="${src}"`), `нет <script src="${src}">`);
  }
});

test('hall.html: file://-безопасность — нет сети, хранилищ и ES-модулей', () => {
  assert.ok(!/fetch\s*\(/.test(html), 'fetch() в html');
  assert.ok(!/XMLHttpRequest/.test(html), 'XMLHttpRequest в html');
  assert.ok(!/localStorage/.test(html), 'localStorage в html');
  assert.ok(!/type="module"/.test(html), 'ES-модуль в html');
});

test('hall.html: клавиша R не срабатывает в полях ввода (кириллическая раскладка)', () => {
  assert.ok(
    html.includes("'INPUT'") && html.includes('e.target'),
    'keydown-обработчик должен игнорировать события из INPUT/TEXTAREA'
  );
});

test('hall.html: диаграмма архитектуры рендерится через SVG', () => {
  assert.ok(html.includes('createElementNS'), 'нет SVG-рендера (createElementNS)');
  assert.ok(html.includes('.diagram'), 'код не читает данные диаграммы из пакета');
});

test('hall.html: дуэльная механика убрана — одна команда, без победителя', () => {
  assert.ok(!html.includes('nameB'), 'второе поле команды (nameB) осталось');
  assert.ok(!html.includes("'winner'"), 'вердикт победителя (winner) остался');
});

test('hall.html: горячие клавиши по e.code — работают в русской раскладке', () => {
  assert.ok(html.includes("'KeyR'") && /Digit\|Numpad/.test(html), 'keydown должен опираться на e.code');
});

test('hall.html: контент сценария не вставляется через innerHTML', () => {
  assert.ok(!/innerHTML\s*=[^;]*\.(label|outcome|text|title|hint|brief)\b/.test(html), 'текст сценария через innerHTML — XSS-риск');
});

test('hall.html: финал строится из HALL_ENGINE.summary, есть отмена выбора и защита R от случайного сброса', () => {
  assert.ok(html.includes('E.summary('), 'финал не использует summary движка');
  assert.ok(html.includes('function undo'), 'нет отмены выбора');
  assert.ok(html.includes('armedReset'), 'R сбрасывает игру с одного нажатия');
});

test('hall.html: сценарии валидируются при загрузке', () => {
  assert.ok(html.includes('E.validate('), 'битый кейс должен отсекаться в лобби');
});
