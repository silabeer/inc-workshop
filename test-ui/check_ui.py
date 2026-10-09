"""UI-проверки трёх экранов в настоящем браузере (Playwright, headless Chromium).

Запуск: npm run test:ui  (поднимает свой сервер на свободном порту с временным DATA_DIR).
Скриншоты всех экранов складываются в test-ui/out/ — их стоит просмотреть глазами:
проверки ловят регрессии, но не заменяют взгляд.

Сценарий: пульт, проектор и пять телефонов проходят целую партию. Проверяются правила
из .claude/skills/inc-workshop-ui/SKILL.md:
  - контраст текста ≥ 4.5:1 (крупный ≥ 3:1) на всех экранах, обе темы проектора;
  - проектор 1080p: текст для зала ≥ 22 px; 1280×720: варианты помещаются без прокрутки;
  - телефон: ничего не режется по горизонтали, кнопки ≥ 44 px;
  - интерфейс на русском;
  - «Новая партия» далеко от «Раскрыть последствия»;
  - проектор и телефоны не показывают приватку чужих ролей;
  - в консоли нет ошибок.
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ['UI_BASE']  # задаёт run.js: свой сервер на свободном порту
OUT = os.path.join(os.path.dirname(__file__), 'out')
os.makedirs(OUT, exist_ok=True)
failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print('  ✖', msg)


def shot(page, name, full=False):
    page.screenshot(path=os.path.join(OUT, name + '.png'), full_page=full)


# Контраст всех видимых текстов: цвет текста против фактического фона (с учётом
# полупрозрачности и opacity предков). SVG/canvas и disabled-элементы пропускаются.
CONTRAST_JS = r"""
() => {
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(',').map(Number); return {r:p[0], g:p[1], b:p[2], a:p.length > 3 ? p[3] : 1}; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const mix = (top, bot) => ({r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1});
  const bgOf = el => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = {r: 255, g: 255, b: 255, a: 1};
    for (let i = layers.length - 1; i >= 0; i--) bg = mix(layers[i], bg);
    return bg;
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode; const el = t.parentElement;
    if (!el || seen.has(el) || !t.textContent.trim()) continue;
    seen.add(el);
    if (el.closest('svg, canvas, [disabled], .hidden, option, select')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight * 3) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
    if (op < 0.05) continue;
    const bg = bgOf(el); let fg = parse(cs.color); fg = mix({...fg, a: fg.a * op}, bg);
    const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
    const large = px >= 24 || (bold && px >= 18.66);
    const need = large ? 3 : 4.5;
    if (ratio < need) out.push(`${ratio.toFixed(2)} < ${need}: «${t.textContent.trim().slice(0, 40)}» (${el.tagName.toLowerCase()}.${el.className})`);
  }
  return out;
}
"""


def contrast(page, where):
    bad = page.evaluate(CONTRAST_JS)
    check(not bad, f'{where}: контраст ниже нормы у {len(bad)} текстов: ' + '; '.join(bad[:6]))


def no_hscroll(page, where):
    bad = page.evaluate("""() => [...document.querySelectorAll('pre, .tabs, .wrap, .card, .item')]
      .filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX !== 'visible')
      .map(e => e.tagName.toLowerCase() + '.' + e.className + ' ' + e.scrollWidth + '>' + e.clientWidth)""")
    check(not bad, f'{where}: содержимое режется по горизонтали: ' + '; '.join(bad[:5]))
    check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{where}: горизонтальная прокрутка страницы')


ENGLISH = r'\b(ACTIVE|PAUSED|LOBBY|RESOLVED|FAILED|pending|refuted|confirmed|rejected|done|voting|revealed|situation)\b'
ROLES = ['commander', 'scout', 'engineer', 'domain', 'comms']


def api(page, path, body):
    return page.evaluate("""async ([p, b]) => { const r = await fetch(p, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)}); return r.status; }""", [path, body])


def english(page, where):
    import re
    eng = sorted(set(re.findall(ENGLISH, page.inner_text('body'))))
    check(not eng, f'{where}: английские слова в интерфейсе: {eng}')


def phone_checks(ph, where):
    no_hscroll(ph, where)
    small = ph.evaluate("""() => [...document.querySelectorAll('#play button:not([disabled])')]
      .filter(b => b.offsetParent && b.getBoundingClientRect().height < 44).map(b => b.textContent.trim().slice(0, 20))""")
    check(not small, f'{where}: кнопки ниже 44px: {small[:6]}')
    contrast(ph, where)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        errors = []

        def new_page(w, h):
            # browser.new_page — отдельный контекст: у каждого «телефона» свой localStorage и токен.
            pg = browser.new_page(viewport={'width': w, 'height': h})
            pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'favicon' not in m.text else None)
            pg.on('pageerror', lambda e: errors.append(str(e)))
            return pg

        def wait_text(pg, text):
            pg.wait_for_function('t => document.body.innerText.includes(t)', arg=text, timeout=5000)

        # ---------- Лобби ----------
        print('Лобби')
        gm = new_page(1440, 900)
        gm.goto(BASE + '/#gm')
        gm.wait_for_selector('.g-cases')
        gm.evaluate('window.confirm = () => true')
        proj = new_page(1920, 1080)
        proj.goto(BASE + '/#screen')
        proj.wait_for_selector('.s-lobby')

        phones = {}
        for role in ['scout', 'comms']:
            ph = new_page(390, 844)
            ph.goto(BASE + '/#play')
            ph.wait_for_selector('.p-roles')
            if role == 'scout':
                shot(ph, 'phone-picker', full=True)
                phone_checks(ph, 'телефон/выбор роли')
            ph.locator('.p-roles button:not([disabled])', has_text={'scout': 'Скаут', 'comms': 'Связной'}[role]).click()
            wait_text(ph, 'Ваша миссия')
            phones[role] = ph
        shot(phones['scout'], 'phone-lobby', full=True)
        for role in ['commander', 'engineer', 'domain']:
            check(api(gm, '/api/claim', {'role': role, 'token': 'tok-' + role}) == 200, f'claim {role}')
        wait_text(proj, '5 из 5')
        shot(proj, 'screen-lobby')
        contrast(proj, 'проектор/лобби')
        shot(gm, 'gm-lobby', full=True)
        contrast(gm, 'пульт/лобби')

        # ---------- Шаг: ситуация, обсуждение, голосование ----------
        print('Раунд')
        gm.get_by_role('button', name='Начать игру').click()
        proj.wait_for_selector('.s-options')
        shot(proj, 'screen-situation')
        sizes = proj.evaluate("""() => { const fs = s => parseFloat(getComputedStyle(document.querySelector(s)).fontSize);
          return {brief: fs('.s-brief'), opt: fs('.s-options li'), title: fs('.s-title')}; }""")
        check(sizes['brief'] >= 22, f"проектор: текст ситуации {sizes['brief']}px (нужно ≥ 22 на 1080p)")
        check(sizes['opt'] >= 22, f"проектор: варианты {sizes['opt']}px (нужно ≥ 22 на 1080p)")
        contrast(proj, 'проектор/ситуация')
        english(proj, 'проектор')
        gm.get_by_role('button', name='Открыть обсуждение').click()
        gm.get_by_role('button', name='Открыть голосование').click()
        wait_text(phones['scout'], 'Голосование открыто')
        shot(phones['scout'], 'phone-voting', full=True)
        phone_checks(phones['scout'], 'телефон/голосование')
        priv = phones['scout'].inner_text('body')
        check('Должен донести' not in priv, 'телефон видит приватку других ролей')
        phones['scout'].locator('.p-vote button').first.click()
        wait_text(phones['scout'], 'Голос учтён')
        # Ещё два голоса — через API (вторым вариантом шага): на проекторе виден счётчик, на пульте — подсчёт.
        opt2 = gm.evaluate("async () => (await (await fetch('/api/pack')).json()).steps[0].options[1].id")
        for role in ['commander', 'engineer']:
            check(api(gm, '/api/vote', {'role': role, 'token': 'tok-' + role, 'option': opt2}) == 200, f'голос {role}')
        wait_text(proj, 'Проголосовали 3 из 5')
        shot(proj, 'screen-voting')
        contrast(proj, 'проектор/голосование')
        shot(gm, 'gm-voting', full=True)
        contrast(gm, 'пульт/голосование')
        english(gm, 'пульт')
        gap = gm.evaluate("""() => {
          const by = t => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(t));
          const r = by('Новая партия'), ok = by('Раскрыть последствия');
          if (!r || !ok) return 9999;
          const a = r.getBoundingClientRect(), b = ok.getBoundingClientRect();
          return Math.hypot(a.x - b.x, a.y - b.y);
        }""")
        check(gap > 200, f'пульт: «Новая партия» в {gap:.0f}px от «Раскрыть последствия» (нужно > 200)')
        gm.get_by_role('button', name='Раскрыть последствия').click()
        proj.wait_for_selector('.s-reveal')
        proj.wait_for_timeout(1000)
        shot(proj, 'screen-reveal')
        contrast(proj, 'проектор/последствия')
        wait_text(phones['comms'], 'Команда выбрала')
        shot(phones['comms'], 'phone-reveal', full=True)
        phone_checks(phones['comms'], 'телефон/последствия')
        shot(gm, 'gm-reveal', full=True)

        # ---------- Проектор 1280×720, обе темы ----------
        print('Проектор 720p')
        gm.get_by_role('button', name='Дальше: шаг 2').click()
        for theme in ['light', 'dark']:
            small = new_page(1280, 720)
            small.goto(BASE + '/#screen')
            small.wait_for_selector('.s-options')
            if theme == 'dark':
                small.keyboard.press('t')
            bottom = small.evaluate("() => Math.max(...[...document.querySelectorAll('.s-options li')].map(c => c.getBoundingClientRect().bottom))")
            check(bottom <= 720, f'проектор/{theme}: варианты уходят под сгиб на 1280×720 ({bottom:.0f}px)')
            shot(small, f'screen-720-{theme}')
            contrast(small, f'проектор 720p/{theme}')
            small.close()

        # ---------- Остальные шаги — командами пульта ----------
        print('До финала')
        for _ in range(80):
            phase = gm.evaluate("async () => (await (await fetch('/healthz')).json()).phase")
            if phase == 'end':
                break
            if phase == 'situation':
                api(gm, '/api/cmd', {'type': 'voting'})
            elif phase == 'voting':
                gm.wait_for_selector('.g-opt')
                gm.locator('.g-opt button', has_text='Раскрыть этот вариант').first.click()
            elif phase == 'revealed':
                api(gm, '/api/cmd', {'type': 'next'})
            gm.wait_for_timeout(150)
        proj.wait_for_selector('.recap')
        shot(proj, 'screen-final')
        contrast(proj, 'проектор/итоги')
        gm.wait_for_selector('.g-final')
        shot(gm, 'gm-final', full=True)
        contrast(gm, 'пульт/итоги')
        wait_text(phones['scout'], 'Очки команды')
        shot(phones['scout'], 'phone-final', full=True)

        # ---------- Карточки ----------
        cards = new_page(1000, 1200)
        cards.goto(BASE + '/#cards')
        cards.wait_for_selector('.card')
        shot(cards, 'cards')
        contrast(cards, 'карточки')

        check(not errors, f'ошибки в консоли: {errors[:5]}')
        browser.close()


if __name__ == '__main__':
    run()
    print()
    if failures:
        print(f'UI: {len(failures)} проблем(ы). Скриншоты: {OUT}')
        sys.exit(1)
    print(f'UI: всё чисто. Скриншоты: {OUT}')
