"""Проверка QR-кодера ui/qr.js настоящим декодером (zxing-cpp): каждая маска и автовыбор читаются в исходный текст.

segno не годится для побайтового сравнения: после терминатора он дописывает лишний нулевой байт —
оба кода валидны, но матрицы различаются. Поэтому сверяем результат декодирования, а не матрицу.
Запуск: из npm run test:ui (или .venv/bin/python test-ui/check_qr.py). Зависимости — requirements-dev.txt.
"""
import json
import os
import subprocess
import sys

import zxingcpp
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXTS = [
    'http://192.168.1.105:8085/#play',
    'https://incident.example.org/r/stol-2/#play',
    'A',
    'Привет, зал! Код: K7Q2',
    'http://10.0.0.1:8085/r/' + 'x' * 120 + '/#play',  # версия ≥ 7: блок информации о версии
]

JS = """
const QR = require(process.argv[1]);
const out = [];
for (const t of JSON.parse(process.argv[2])) for (let mask = 0; mask < 8; mask++) {
  const q = QR.encode(t, {mask});
  out.push({t, mask, version: q.version, rows: q.modules.map(r => r.map(Number).join(''))});
}
for (const t of JSON.parse(process.argv[2])) { const q = QR.encode(t); out.push({t, mask: 'авто', version: q.version, rows: q.modules.map(r => r.map(Number).join(''))}); }
console.log(JSON.stringify(out));
"""


def main():
    res = subprocess.run(['node', '-e', JS, os.path.join(ROOT, 'ui', 'qr.js'), json.dumps(TEXTS)], capture_output=True, text=True, check=True)
    fails = 0
    for r in json.loads(res.stdout):
        rows, scale, quiet = r['rows'], 8, 4
        n = len(rows)
        img = Image.new('L', ((n + 2 * quiet) * scale,) * 2, 255)
        px = img.load()
        for y, row in enumerate(rows):
            for x, c in enumerate(row):
                if c == '1':
                    for dy in range(scale):
                        for dx in range(scale):
                            px[(x + quiet) * scale + dx, (y + quiet) * scale + dy] = 0
        got = zxingcpp.read_barcodes(img)
        text = got[0].text if got else None
        if text != r['t']:
            fails += 1
            print(f"  ✖ QR: «{r['t'][:30]}» версия {r['version']} маска {r['mask']}: прочитано {text!r}")
    if fails:
        sys.exit(1)
    print(f'QR: декодер читает все коды ({len(TEXTS)} текстов × 8 масок + автовыбор)')


if __name__ == '__main__':
    main()
