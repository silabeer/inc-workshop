// Запускатель UI-проверок: свой сервер на свободном порту с временным DATA_DIR → check_ui.py → остановка.
// Порт выбирается автоматически: тесты засевают данные и не должны попасть в чужую живую игру.
// Нужен Python Playwright: python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
//                         && .venv/bin/playwright install chromium
const {spawn} = require('child_process');
const fs = require('fs'), net = require('net'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PY = [path.join(ROOT, '.venv', 'bin', 'python'), 'python3'].find(p => p === 'python3' || fs.existsSync(p));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-ui-'));

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().once('error', rej).listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => res(port)); });
});

(async () => {
  const PORT = await freePort();
  let exited = false;
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: data, GM_PIN: ''},
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  server.on('exit', () => { exited = true; });
  const stop = code => { server.kill(); fs.rmSync(data, {recursive: true, force: true}); process.exit(code); };

  let ready = false;
  for (let i = 0; i < 50 && !exited; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch (e) {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready || exited) { console.error('Тестовый сервер не запустился — UI-проверки не выполнены.'); return stop(1); }

  const ui = spawn(PY, ['-I', path.join(__dirname, 'check_ui.py')], {
    env: {...process.env, UI_BASE: `http://127.0.0.1:${PORT}`}, stdio: 'inherit',
  });
  ui.on('exit', code => stop(code || 0));
})();
