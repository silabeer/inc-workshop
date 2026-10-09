// Запускатель UI-проверок: сервер на :8099 с временным DATA_DIR → check_ui.py → остановка.
// Нужен Python Playwright: python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
//                         && .venv/bin/playwright install chromium
const {spawn} = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8099;
const PY = [path.join(ROOT, '.venv', 'bin', 'python'), 'python3'].find(p => p === 'python3' || fs.existsSync(p));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-ui-'));

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: {...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: data, GM_PIN: ''},
  stdio: 'ignore',
});
const stop = code => { server.kill(); fs.rmSync(data, {recursive: true, force: true}); process.exit(code); };

(async () => {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  const ui = spawn(PY, ['-I', path.join(__dirname, 'check_ui.py')], {
    env: {...process.env, UI_BASE: `http://127.0.0.1:${PORT}`}, stdio: 'inherit',
  });
  ui.on('exit', code => stop(code || 0));
})();
