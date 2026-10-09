// Запускатель UI-проверок: свои серверы на свободных портах с временными DATA_DIR → проверки → остановка.
// Порт выбирается автоматически: тесты засевают данные и не должны попасть в чужую живую игру.
// Три сервера: без PIN (основной сценарий), с PIN (вход ведущего, сессия в cookie) и со сломанным диском
// (предупреждение ведущему о несохраняемом состоянии).
// Нужен Python Playwright: python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
//                         && .venv/bin/playwright install chromium
const {spawn} = require('child_process');
const fs = require('fs'), net = require('net'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PY = [path.join(ROOT, '.venv', 'bin', 'python'), 'python3'].find(p => p === 'python3' || fs.existsSync(p));

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().once('error', rej).listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => res(port)); });
});

async function startServer(pin, prepare) {
  const port = await freePort(), data = fs.mkdtempSync(path.join(os.tmpdir(), 'incw-ui-'));
  if (prepare) prepare(data);
  let exited = false;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, GM_PIN: pin, PUBLIC_URL: ''},
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  proc.on('exit', () => { exited = true; });
  const stop = () => { proc.kill(); fs.rmSync(data, {recursive: true, force: true}); };
  for (let i = 0; i < 50 && !exited; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return {base: `http://127.0.0.1:${port}`, stop}; } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  stop();
  return null;
}

(async () => {
  const open = await startServer(''), locked = await startServer('4821');
  // Каталог на месте временного файла: запись state.json падает при первой же команде.
  const broken = await startServer('', data => fs.mkdirSync(path.join(data, 'state.json.tmp')));
  const stopAll = code => { [open, locked, broken].forEach(x => x && x.stop()); process.exit(code); };
  if (!open || !locked || !broken) { console.error('Тестовый сервер не запустился — UI-проверки не выполнены.'); return stopAll(1); }

  // Сначала QR-кодер (декодер читает каждый код), потом сценарии в браузере.
  const py = (script, env) => new Promise(res => spawn(PY, ['-I', path.join(__dirname, script)], {env: {...process.env, ...env}, stdio: 'inherit'}).on('exit', c => res(c || 0)));
  const qr = await py('check_qr.py', {});
  const ui = await py('check_ui.py', {UI_BASE: open.base, UI_BASE_PIN: locked.base, UI_PIN: '4821', UI_BASE_BROKEN: broken.base});
  stopAll(qr || ui);
})();
