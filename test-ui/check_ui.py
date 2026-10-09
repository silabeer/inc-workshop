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
  - QR-код в лобби читается декодером и ведёт на адрес для телефонов;
  - ничья (с голосом Командира и без), бумажный режим (голоса вписывает ведущий), голос зала;
  - комнаты, код входа, звук, аналитика по архиву;
  - вход ведущего по PIN: сессия в cookie, PIN и токены не попадают в адреса запросов и в localStorage;
  - сбой диска сервера: пульт показывает предупреждение;
  - в консоли нет ошибок.
"""
import os
import sys

from playwright.sync_api import sync_playwright
import io
import zxingcpp
from PIL import Image

BASE = os.environ['UI_BASE']  # задаёт run.js: свой сервер на свободном порту
BASE_PIN, PIN = os.environ['UI_BASE_PIN'], os.environ['UI_PIN']  # второй сервер — с PIN ведущего
BASE_BROKEN = os.environ['UI_BASE_BROKEN']  # третий — диск не принимает state.json
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
            pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'favicon' not in m.text and '403' not in m.text else None)
            pg.on('pageerror', lambda e: errors.append(str(e)))
            return pg

        def wait_text(pg, text):
            pg.wait_for_function('t => document.body.innerText.includes(t)', arg=text, timeout=5000)

        def gm_view(pg):
            # Текущее представление пульта — из потока SSE (первое сообщение).
            return pg.evaluate("""async () => {
              const ac = new AbortController(); const r = await fetch('/events?view=gm', {signal: ac.signal});
              const rd = r.body.getReader(); let b = '';
              while (!b.includes('\\n\\n')) b += new TextDecoder().decode((await rd.read()).value);
              ac.abort(); return JSON.parse(b.slice(b.indexOf('data: ') + 6, b.indexOf('\\n\\n')));
            }""")

        def opt(pg, i):
            return gm_view(pg)['step']['options'][i]['id']

        # ---------- Лобби ----------
        print('Лобби')
        gm = new_page(1440, 900)
        gm.goto(BASE + '/#gm')
        gm.wait_for_selector('.g-cases')
        gm.evaluate('window.confirm = () => true')
        proj = new_page(1920, 1080)
        proj.goto(BASE + '/#screen')
        proj.wait_for_selector('.s-lobby svg.qr')
        proj.wait_for_timeout(300)
        png = proj.locator('svg.qr').screenshot()
        got = zxingcpp.read_barcodes(Image.open(io.BytesIO(png)))
        url = proj.locator('.s-join .url').inner_text()
        check(got and got[0].text == url, f'QR в лобби не читается или ведёт не туда: {got[0].text if got else None!r} ≠ {url!r}')
        check(url.endswith('/#play'), f'адрес для телефонов: {url}')

        names = {'Командир инцидента': 'commander', 'Скаут наблюдаемости': 'scout', 'Инженер платформы': 'engineer', 'Доменный специалист': 'domain', 'Связной с бизнесом': 'comms'}
        phones = {}
        ph = new_page(390, 844)
        ph.goto(BASE + '/#play')
        ph.wait_for_selector('.p-roles')
        shot(ph, 'phone-picker', full=True)
        phone_checks(ph, 'телефон/выбор роли')
        ph.locator('.p-roles button', has_text='Скаут').click()
        wait_text(ph, 'Ваша миссия')
        phones['scout'] = ph
        ph = new_page(390, 844)
        ph.goto(BASE + '/#play')
        ph.wait_for_selector('.p-roles')
        ph.get_by_role('button', name='Мне любую свободную роль').click()
        wait_text(ph, 'Ваша миссия')
        anyrole = names.get(ph.locator('.p-head .who').inner_text().strip())
        check(anyrole and anyrole != 'scout', f'жребий выдал роль: {anyrole}')
        phones[anyrole] = ph
        shot(ph, 'phone-lobby', full=True)
        api_roles = [r for r in ROLES if r not in phones]
        for role in api_roles:
            check(api(gm, '/api/claim', {'role': role, 'token': 'tok-' + role}) == 200, f'claim {role}')
        spec = new_page(390, 844)
        spec.goto(BASE + '/#play')
        spec.wait_for_selector('.p-roles')
        spec.get_by_role('button', name='Я в зале — голосовать как зритель').click()
        wait_text(spec, 'Ждём старта')
        wait_text(proj, '5 из 5')
        shot(proj, 'screen-lobby')
        contrast(proj, 'проектор/лобби')
        gm.locator('.g-check input').check()
        wait_text(proj, 'Звук включён ведущим')
        shot(gm, 'gm-lobby', full=True)
        contrast(gm, 'пульт/лобби')

        # ---------- Шаг 1: ситуация, обсуждение, голосование ролей и зала ----------
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
        check('Должен донести' not in phones['scout'].inner_text('body'), 'телефон видит приватку других ролей')
        phones['scout'].locator('.p-vote button').first.click()
        wait_text(phones['scout'], 'Голос учтён')
        o2 = opt(gm, 1)
        for role in api_roles[:2]:
            check(api(gm, '/api/vote', {'role': role, 'token': 'tok-' + role, 'option': o2}) == 200, f'голос {role}')
        wait_text(spec, 'Голосуйте')
        spec.locator('.p-vote button').nth(1).click()
        wait_text(spec, 'Ваш голос учтён')
        shot(spec, 'phone-spectator', full=True)
        phone_checks(spec, 'телефон/зритель')
        wait_text(proj, 'Проголосовали 3 из 5')
        wait_text(proj, 'Зал: 1 голос')
        shot(proj, 'screen-voting')
        contrast(proj, 'проектор/голосование')
        wait_text(gm, 'Зал (1)')
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
        proj.wait_for_selector('.s-aud')
        proj.wait_for_timeout(1000)
        shot(proj, 'screen-reveal')
        contrast(proj, 'проектор/последствия')
        other = [r for r in phones if r != 'scout'][0]
        wait_text(phones[other], 'Команда выбрала')
        shot(phones[other], 'phone-reveal', full=True)
        phone_checks(phones[other], 'телефон/последствия')
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

        # ---------- Заметка ведущего к шагу ----------
        gm.fill('textarea.g-note', 'Скаут не прочитал срез — зал хотел рестарт')
        gm.get_by_role('button', name='Сохранить заметку').click()
        wait_text(gm, 'Заметка сохранена')
        check('Скаут не прочитал срез' not in proj.inner_text('body'), 'заметка ведущего видна на проекторе')

        # ---------- Шаг 2: ничья без голоса Командира — выбирает ведущий ----------
        print('Ничья и бумажный режим')
        api(gm, '/api/cmd', {'type': 'voting'})
        voters = [r for r in api_roles if r != 'commander'][:2]
        if len(voters) == 2:
            api(gm, '/api/vote', {'role': voters[0], 'token': 'tok-' + voters[0], 'option': opt(gm, 0)})
            api(gm, '/api/vote', {'role': voters[1], 'token': 'tok-' + voters[1], 'option': opt(gm, 1)})
            wait_text(gm, 'Ничья. Командир называет вариант')
            check(gm.get_by_role('button', name='Раскрыть последствия').is_disabled(), 'ничья без Командира: «Раскрыть последствия» должна быть недоступна')
            shot(gm, 'gm-tie', full=True)
            gm.locator('.g-opt button', has_text='Раскрыть этот вариант').nth(1).click()
            wait_text(proj, 'выбор ведущего')
        else:
            api(gm, '/api/cmd', {'type': 'reveal', 'option': opt(gm, 1)})
        api(gm, '/api/cmd', {'type': 'next'})

        # ---------- Шаг 3: бумажный режим — ведущий вписывает голоса, ничья решается голосом Командира ----------
        api(gm, '/api/cmd', {'type': 'voting'})
        gm.wait_for_selector('select[aria-label="Голос за роль Командир инцидента"]')
        first, second = opt(gm, 0), opt(gm, 1)
        for role_name, o in [('Командир инцидента', first), ('Доменный специалист', second)]:
            sel = gm.locator(f'select[aria-label="Голос за роль {role_name}"]')
            if sel.count():
                sel.select_option(o)
                gm.wait_for_timeout(250)
        wait_text(gm, 'решает голос Командира')
        gm.get_by_role('button', name='Раскрыть последствия').click()
        wait_text(proj, 'решил Командир при ничьей')
        shot(proj, 'screen-commander-tiebreak')
        api(gm, '/api/cmd', {'type': 'next'})

        # ---------- Остальные шаги — командами пульта ----------
        print('До финала')
        for _ in range(80):
            ph_ = gm_view(gm)['phase']
            if ph_ == 'end':
                break
            if ph_ == 'situation':
                api(gm, '/api/cmd', {'type': 'voting'})
            elif ph_ == 'voting':
                api(gm, '/api/cmd', {'type': 'reveal', 'option': opt(gm, 0)})
            elif ph_ == 'revealed':
                api(gm, '/api/cmd', {'type': 'next'})
        proj.wait_for_selector('.recap')
        shot(proj, 'screen-final')
        contrast(proj, 'проектор/итоги')
        gm.wait_for_selector('.g-final')
        shot(gm, 'gm-final', full=True)
        contrast(gm, 'пульт/итоги')
        wait_text(phones['scout'], 'Очки команды')
        shot(phones['scout'], 'phone-final', full=True)

        # ---------- Аналитика и карточки ----------
        stats = new_page(1280, 900)
        stats.goto(BASE + '/#stats')
        stats.wait_for_selector('.st-table')
        wait_text(stats, 'Скаут не прочитал срез')  # заметка дошла до аналитики по архиву
        shot(stats, 'stats', full=True)
        contrast(stats, 'аналитика')
        english(stats, 'аналитика')
        cards = new_page(1000, 1200)
        cards.goto(BASE + '/#cards')
        cards.wait_for_selector('.card')
        shot(cards, 'cards')
        contrast(cards, 'карточки')

        # ---------- Комнаты и код входа ----------
        print('Комнаты')
        gm.get_by_role('button', name='Новая партия').click()
        gm.wait_for_selector('.g-cases')
        gm.locator('input[aria-label="Имя новой комнаты"]').fill('stol-2')
        gm.get_by_role('button', name='Создать комнату').click()
        wait_text(gm, 'stol-2')
        shot(gm, 'gm-rooms', full=True)
        check(api(gm, '/api/cmd?room=stol-2', {'type': 'joinCode', 'code': 'K7Q2'}) == 200, 'код входа в комнате stol-2')
        rp = new_page(1920, 1080)
        rp.goto(BASE + '/r/stol-2/#screen')
        rp.wait_for_selector('.s-lobby')
        check('/r/stol-2/#play' in rp.locator('.s-join .url').inner_text(), 'проектор комнаты показывает адрес комнаты')
        wait_text(rp, 'Код входа скажет ведущий')
        phc = new_page(390, 844)
        phc.goto(BASE + '/r/stol-2/#play')
        phc.wait_for_selector('.p-code')
        shot(phc, 'phone-join-code', full=True)
        phone_checks(phc, 'телефон/код входа')
        phc.locator('.p-code').fill('K7Q2')
        phc.get_by_role('button', name='Продолжить').click()
        phc.locator('.p-roles button', has_text='Связной').click()
        wait_text(phc, 'Ваша миссия')
        wait_text(rp, '1 из 5')

        # ---------- Сервер с PIN: вход ведущего и секреты вне адресов ----------
        print('PIN ведущего')
        urls = []
        g2 = browser.new_page(viewport={'width': 1280, 'height': 900})
        g2.on('request', lambda r: urls.append(r.url))
        g2.goto(BASE_PIN + '/#gm')
        g2.wait_for_selector('.g-pin input')
        shot(g2, 'gm-pin')
        contrast(g2, 'пульт/PIN')
        g2.fill('.g-pin input', '0000')
        g2.get_by_role('button', name='Открыть пульт').click()
        wait_text(g2, 'PIN не подошёл')
        g2.fill('.g-pin input', PIN)
        g2.get_by_role('button', name='Открыть пульт').click()
        g2.wait_for_selector('.g-cases')
        g2.reload()
        g2.wait_for_selector('.g-cases', timeout=5000)  # сессия в cookie переживает перезагрузку
        stored = g2.evaluate('JSON.stringify(Object.assign({}, localStorage))')
        check(PIN not in stored, f'PIN лежит в localStorage: {stored}')
        cookie = [c for c in g2.context.cookies() if c['name'] == 'incw_gm']
        check(cookie and cookie[0]['httpOnly'] and cookie[0]['sameSite'] == 'Strict', f'cookie сессии ведущего: {cookie}')
        p2 = browser.new_page(viewport={'width': 390, 'height': 844})
        p2.on('request', lambda r: urls.append(r.url))
        p2.goto(BASE_PIN + '/#play')
        p2.wait_for_selector('.p-roles')
        p2.locator('.p-roles button', has_text='Скаут').click()
        wait_text(p2, 'Ваша миссия')
        p2.reload()
        wait_text(p2, 'Ваша миссия')  # роль вернулась по cookie устройства
        dev = [c for c in p2.context.cookies() if c['name'] == 'incw_dev']
        check(dev and dev[0]['httpOnly'], f'cookie устройства: {dev}')
        leaks = [u for u in urls if 'pin=' in u or 'token=' in u or (dev and dev[0]['value'] in u)]
        check(not leaks, f'секреты в адресах запросов: {leaks[:3]}')
        g2.get_by_role('link', name='Выйти с пульта').click()
        g2.wait_for_selector('.g-pin input')

        # ---------- Сбой диска: предупреждение ведущему ----------
        print('Сбой диска')
        g3 = new_page(1280, 900)
        g3.goto(BASE_BROKEN + '/#gm')
        g3.wait_for_selector('.g-cases')
        g3.wait_for_selector('.g-storage', timeout=5000)  # запись при старте уже не удалась
        check('не сохраняется' in g3.locator('.g-storage').inner_text(), 'текст предупреждения о сохранении')
        shot(g3, 'gm-storage-error')
        contrast(g3, 'пульт/сбой диска')
        english(g3, 'пульт/сбой диска')

        check(not errors, f'ошибки в консоли: {errors[:5]}')
        browser.close()


if __name__ == '__main__':
    run()
    print()
    if failures:
        print(f'UI: {len(failures)} проблем(ы). Скриншоты: {OUT}')
        sys.exit(1)
    print(f'UI: всё чисто. Скриншоты: {OUT}')
