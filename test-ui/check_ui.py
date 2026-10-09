"""UI-проверки обоих режимов в настоящем браузере (Playwright, headless Chromium).

Запуск: npm run test:ui  (поднимает сервер на :8099 с временным DATA_DIR).
Скриншоты всех экранов складываются в test-ui/out/ — их стоит просмотреть глазами:
проверки ловят регрессии, но не заменяют взгляд.

Что проверяется — правила из .claude/skills/inc-workshop-ui/SKILL.md:
  - контраст текста ≥ 4.5:1 (крупный ≥ 3:1) на всех экранах, обе темы холла;
  - проектор war-room: кегль стены и ленты читается из зала;
  - телефон: ничего не режется по горизонтали, кнопки ≥ 44 px;
  - холл 1280×720: все варианты помещаются без прокрутки;
  - главная war-room не меняет выбор ведущего;
  - интерфейс на русском: без ACTIVE/pending/refuted;
  - «Сбросить всё» не стоит рядом с «Resolved»/«Failed»;
  - в консоли нет ошибок.
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get('UI_BASE', 'http://localhost:8099')
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


def seed_game(page):
    """Партия с данными: улики, предложения, статус, гипотезы, игроки."""
    page.evaluate("""async () => {
      window.confirm = () => true;
      await startIncident('phantom-network', 'standard');
      const now = Date.now();
      await setDoc('players', 'scout', {name: 'Аня', claimedAt: now, received: [{id: 'S1', at: now, t: 20}]});
      await setDoc('players', 'platform', {name: 'Борис', claimedAt: now, inFlight: {id: 'P6', startedAt: now, readyAt: now + 40000, cost: 40}});
      await setDoc('players', 'commander', {name: 'Вика', claimedAt: now});
      await setDoc('players', 'comms', {name: 'Гоша', claimedAt: now});
      await setDoc('wall', 'w1', {role: 'scout', artifactId: 'S1', summary: 'Пользователей ×1,02, запросов на пользователя ×4 — шторм ретраев, не DDoS', t: 40});
      await setDoc('wall', 'w2', {role: 'platform', artifactId: 'P5', summary: 'cl_waiting 70, maxwait 29 с — коннекты кто-то держит', t: 70, key: 'K1'});
      await setDoc('proposals', 'pr1', {mitId: 'T-POOL', role: 'platform', cards: ['w2'], t: 80, status: 'pending'});
      await setDoc('proposals', 'pr2', {mitId: 'M-D1', role: 'domain', cards: [], t: 90, status: 'pending'});
      await setDoc('hypotheses', 'h1', {text: 'Это DDoS', status: 'refuted', cards: [], t: 30});
      await setDoc('statuses', 's1', {text: 'Оплата картой недоступна, СБП работает. Следующее обновление через 5 минут.', role: 'comms', t: 100});
    }""")


ENGLISH = r'\b(ACTIVE|PAUSED|LOBBY|RESOLVED|FAILED|pending|refuted|confirmed|rejected|done|go)\b'


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        errors = []

        def new_page(w, h):
            pg = browser.new_page(viewport={'width': w, 'height': h})
            pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'favicon' not in m.text else None)
            pg.on('pageerror', lambda e: errors.append(str(e)))
            return pg

        # ---------- War-room: главная ----------
        print('War-room: главная')
        pg = new_page(1440, 900)
        pg.goto(BASE + '/')
        pg.wait_for_selector('.landing')
        shot(pg, 'wr-home', full=True)
        before = pg.evaluate("async () => (await (await fetch('/state')).json()).rev")
        cards = pg.locator('.landing .rolecard, .landing [data-pack]')
        if cards.count() > 1:
            cards.nth(1).click()
            pg.wait_for_timeout(300)
        after = pg.evaluate("async () => (await (await fetch('/state')).json()).rev")
        check(before == after, 'главная: клик по кейсу меняет общее состояние (выбор — только на пульте)')
        contrast(pg, 'главная')

        # ---------- War-room: пульт ----------
        print('War-room: пульт')
        pg.goto(BASE + '/#gm')
        pg.wait_for_selector('.bar')
        seed_game(pg)
        pg.wait_for_timeout(500)
        shot(pg, 'wr-gm', full=True)
        contrast(pg, 'пульт')
        txt = pg.inner_text('body')
        import re
        eng = sorted(set(re.findall(ENGLISH, txt)))
        check(not eng, f'пульт: английские статусы в интерфейсе: {eng}')
        gap = pg.evaluate("""() => {
          const by = t => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(t));
          const r = by('Сбросить'), ok = by('Resolved') || by('Закрыть инцидент');
          if (!r || !ok) return 9999;
          const a = r.getBoundingClientRect(), b = ok.getBoundingClientRect();
          return Math.hypot(a.x - b.x, a.y - b.y);
        }""")
        check(gap > 200, f'пульт: «Сбросить всё» в {gap:.0f}px от кнопки закрытия инцидента (нужно > 200)')

        # ---------- War-room: проектор ----------
        print('War-room: проектор')
        pg2 = new_page(1920, 1080)
        pg2.goto(BASE + '/#projector')
        pg2.wait_for_selector('.proj')
        pg2.wait_for_timeout(2500)
        shot(pg2, 'wr-projector')
        sizes = pg2.evaluate("""() => {
          const fs = s => { const e = document.querySelector(s); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; };
          return {wall: fs('.proj .wallcard'), feed: fs('.proj .feed div'), label: fs('.proj .eyebrow, .proj h2')};
        }""")
        check(sizes['wall'] >= 22, f"проектор: текст стены {sizes['wall']}px (нужно ≥ 22 на 1080p)")
        check(sizes['feed'] >= 18, f"проектор: лента {sizes['feed']}px (нужно ≥ 18 на 1080p)")
        contrast(pg2, 'проектор')
        eng = sorted(set(re.findall(ENGLISH, pg2.inner_text('body'))))
        check(not eng, f'проектор: английские статусы: {eng}')
        pg2.close()

        # ---------- War-room: телефон ----------
        print('War-room: телефон')
        ph = new_page(390, 844)
        for role, tab in [('scout', 'Данные'), ('comms', 'Статус'), ('commander', 'Доска')]:
            ph.goto(BASE + '/?r=' + role + '#play/' + role)
            ph.wait_for_selector('.tabs')
            ph.locator('.tabs button', has_text=tab).click()
            ph.wait_for_timeout(200)
            shot(ph, f'wr-phone-{role}', full=True)
            no_hscroll(ph, f'телефон/{role}')
            small = ph.evaluate("""() => [...document.querySelectorAll('.wrap button:not([disabled]), .tabs button')]
              .filter(b => b.offsetParent && b.getBoundingClientRect().height < 44).map(b => b.textContent.trim().slice(0, 20))""")
            check(not small, f'телефон/{role}: кнопки ниже 44px: {small[:6]}')
            contrast(ph, f'телефон/{role}')
        ph.close()

        # ---------- Холл ----------
        print('Холл')
        for theme in ['light', 'dark']:
            h = new_page(1280, 720)
            h.goto(BASE + '/hall.html')
            h.wait_for_selector('#cases .case')
            if theme == 'dark':
                h.keyboard.press('t')
            shot(h, f'hall-{theme}-lobby')
            contrast(h, f'холл/{theme}/лобби')
            h.keyboard.press('Enter')
            h.wait_for_selector('#playView:not(.hidden)')
            bottom = h.evaluate("() => Math.max(...[...document.querySelectorAll('.choice')].map(c => c.getBoundingClientRect().bottom))")
            check(bottom <= 720, f'холл/{theme}: варианты уходят под сгиб на 1280×720 ({bottom:.0f}px)')
            shot(h, f'hall-{theme}-play')
            contrast(h, f'холл/{theme}/шаг')
            h.keyboard.press('3')
            h.wait_for_selector('#outcomeView:not(.hidden)')
            shot(h, f'hall-{theme}-outcome')
            contrast(h, f'холл/{theme}/последствия')
            for _ in range(12):
                if h.locator('#final.on').count():
                    break
                h.keyboard.press('Enter')
                h.wait_for_timeout(50)
                if h.locator('#playView:not(.hidden)').count():
                    h.keyboard.press('1')
                    h.wait_for_timeout(50)
            shot(h, f'hall-{theme}-final', full=True)
            contrast(h, f'холл/{theme}/финал')
            h.close()

        check(not errors, f'ошибки в консоли: {errors[:5]}')
        browser.close()


if __name__ == '__main__':
    run()
    print()
    if failures:
        print(f'UI: {len(failures)} проблем(ы). Скриншоты: {OUT}')
        sys.exit(1)
    print(f'UI: всё чисто. Скриншоты: {OUT}')
