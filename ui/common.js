/* Общее для трёх экранов: построение DOM, связь с сервером, таймер, диаграмма, баннеры.
   Контент вставляется только как текст (никакого innerHTML с данными). */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // Комната берётся из адреса: /r/<комната>/ — своя партия; корень — комната main.
  const ROOM = (location.pathname.match(/^\/r\/([a-z0-9-]+)\//) || [])[1] || 'main';
  const BASE = ROOM === 'main' ? '/' : '/r/' + ROOM + '/';
  const api = (p, params) => p + '?' + new URLSearchParams(Object.assign({ room: ROOM }, params || {}));

  // h('div', {class: 'x', onclick: fn}, 'текст', h(...)) — дочерние строки становятся текстовыми узлами.
  function h(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) append(e, arguments[i]);
    return e;
  }
  function append(e, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(x => append(e, x));
    else e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function mount(id) { const box = $(id); box.replaceChildren(...[].slice.call(arguments, 1).flat(Infinity).filter(Boolean)); return box; }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many);
  }
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
  const mmss = sec => { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
  const group = n => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  // Потери крупно и коротко: 1,2 млн ₽, 850 тыс ₽.
  function rub(n) {
    if (Math.abs(n) >= 1e6) return (Math.round(n / 1e5) / 10).toString().replace('.', ',') + ' млн ₽';
    if (Math.abs(n) >= 1e3) return group(n / 1e3) + ' тыс ₽';
    return group(n) + ' ₽';
  }
  const PHASES = { lobby: 'Лобби', situation: 'Ситуация', discussion: 'Обсуждение', voting: 'Голосование', revealed: 'Последствия', end: 'Итоги' };

  let toastT = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  /* ---------- Ошибки рендера и связь ---------- */
  // Одно исключение в рендере не должно молча «заморозить» экран: показываем, что делать.
  let fatal = false;
  function showError(err) {
    console.error(err);
    if (fatal) return;
    fatal = true;
    const b = $('banner');
    b.className = 'banner err';
    b.replaceChildren('Экран сломался из-за ошибки. ', h('button', { onclick: () => location.reload() }, 'Обновить страницу'));
  }
  window.addEventListener('error', e => showError(e.error || e.message));
  window.addEventListener('unhandledrejection', e => showError(e.reason));
  function setLink(ok) {
    if (fatal) return;
    const b = $('banner');
    b.className = ok ? 'banner hidden' : 'banner warn';
    b.textContent = ok ? '' : 'Нет связи с сервером — переподключаемся…';
  }

  // Поток представления с сервера. EventSource сам переподключается; offset — разница часов с сервером для таймера.
  let offset = 0;
  // Возвращает { close }: при переподключении после ошибки сервера поток подменяется, а вызывающий
  // по-прежнему закрывает именно текущий.
  function connect(params, onView, onClosed) {
    let es = null, closed = false;
    const open = () => {
      es = new EventSource(api('/events', params));
      es.onmessage = e => {
        const v = JSON.parse(e.data);
        if (v.now) offset = v.now - Date.now();
        setLink(true);
        try { onView(v); } catch (err) { showError(err); }
      };
      es.onerror = () => {
        setLink(false);
        // Сервер ответил ошибкой, а не пропал: EventSource больше не переподключится. Комнату удалили?
        if (es.readyState !== EventSource.CLOSED) return;
        if (onClosed) { onClosed(); return; } // экран решает сам (пульт: не подошёл ли PIN)
        fetch(api('/api/info')).then(r => {
          if (r.status !== 404 || fatal) return;
          const b = $('banner'); b.className = 'banner err';
          b.textContent = 'Этой комнаты больше нет. Откройте адрес, который даст ведущий.';
        }).catch(() => {});
        setTimeout(() => { if (!closed && !fatal && $('banner').className !== 'banner err') open(); }, 5000);
      };
    };
    open();
    return { close() { closed = true; es.close(); } };
  }

  async function post(url, body, headers) {
    let r;
    try {
      r = await fetch(url.includes('?') ? url : api(url), { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
    } catch (e) { toast('Нет связи с сервером'); return { ok: false, status: 0 }; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok && data.error) toast(data.error);
    return { ok: r.ok, status: r.status, data };
  }

  /* ---------- Таймер фазы (мягкий: после нуля считает перерасход) ---------- */
  const timers = new Set();
  function timer(v) {
    const el = h('span', { class: 'timer mono', 'aria-label': 'Таймер фазы' });
    if (!v.phaseSec || !v.phaseAt) return null;
    el.dataset.end = v.phaseAt + v.phaseSec * 1000;
    timers.add(el); tick(el);
    return el;
  }
  // Таймер, который убрала перерисовка, выбывает; только что созданный (ещё не в DOM) — нет.
  function tick(fresh) {
    const now = Date.now() + offset;
    for (const el of timers) {
      if (el.isConnected) el.dataset.seen = '1';
      else if (el !== fresh && el.dataset.seen) { timers.delete(el); continue; }
      const left = (+el.dataset.end - now) / 1000;
      el.textContent = left >= 0 ? mmss(Math.ceil(left)) : '+' + mmss(-left);
      el.classList.toggle('over', left < 0);
    }
  }
  setInterval(tick, 500);

  /* ---------- Диаграмма ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  let svgSeq = 0;
  function el(name, attrs) { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  // Точка, где отрезок из центра a в центр b пересекает рамку b (с зазором под стрелку).
  function clipTo(ax, ay, b, gap) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = ax - cx, dy = ay - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const t = Math.min(dx ? (b.w / 2 + gap) / Math.abs(dx) : Infinity, dy ? (b.h / 2 + gap) / Math.abs(dy) : Infinity);
    return { x: cx + dx * t, y: cy + dy * t };
  }
  // Подпись, которая не помещается в блок, сжимается по ширине, а не вылезает за рамку.
  function fitText(t, s, maxW, charW) {
    t.textContent = s;
    if (s.length * charW > maxW) { t.setAttribute('textLength', maxW); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
    return t;
  }
  // state — перекраска компонентов на этом шаге; focus — компоненты, о которых шаг.
  function diagram(d, focus, state) {
    focus = focus || []; state = state || {};
    const id = 'arr' + (++svgSeq);
    const svg = el('svg', { viewBox: '0 0 640 320', class: 'diag' + (focus.length ? ' has-focus' : ''), role: 'img', 'aria-label': 'Схема архитектуры: ' + d.nodes.map(n => n.label).join(', ') });
    const defs = el('defs', {});
    const marker = el('marker', { id, markerWidth: '10', markerHeight: '10', refX: '9', refY: '5', orient: 'auto', markerUnits: 'userSpaceOnUse' });
    marker.appendChild(el('path', { d: 'M0,0 L10,5 L0,10 z', class: 'd-arrow' }));
    defs.appendChild(marker); svg.appendChild(defs);
    const H = 54, DW = 150, boxes = {};
    d.nodes.forEach(n => { boxes[n.id] = { x: n.x, y: n.y, w: n.w || DW, h: H }; });
    (d.edges || []).forEach(e => {
      const a = boxes[e.from], b = boxes[e.to];
      if (!a || !b) return;
      const p1 = clipTo(b.x + b.w / 2, b.y + b.h / 2, a, 0), p2 = clipTo(a.x + a.w / 2, a.y + a.h / 2, b, 2);
      svg.appendChild(el('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'd-edge', 'marker-end': 'url(#' + id + ')' }));
      // Подпись ребра — только если ей хватает места между блоками, иначе она налезает на рамки.
      if (e.label && Math.hypot(p2.x - p1.x, p2.y - p1.y) > e.label.length * 7 + 16) svg.appendChild(fitText(el('text', { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 6, class: 'd-elabel' }), e.label, 200, 7));
    });
    d.nodes.forEach(n => {
      const b = boxes[n.id];
      const g = el('g', { class: 'd-node' + (focus.includes(n.id) ? ' focus' : '') });
      g.appendChild(el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 7, class: 'd-box c-' + (state[n.id] || n.color || 'gray') }));
      g.appendChild(fitText(el('text', { x: b.x + b.w / 2, y: b.y + (n.note ? 23 : 33), class: 'd-label' }), n.label, b.w - 12, 8.4));
      if (n.note) g.appendChild(fitText(el('text', { x: b.x + b.w / 2, y: b.y + 43, class: 'd-note' }), n.note, b.w - 12, 7.2));
      svg.appendChild(g);
    });
    return svg;
  }
  const legend = () => h('div', { class: 'legend' },
    [['--sev', '--sev-bg', 'сбой'], ['--warn', '--warn-bg', 'деградация'], ['--ok', '--ok-bg', 'в норме'], ['--rule-strong', '--idle-bg', 'под вопросом']]
      .map(([b, f, t]) => h('span', null, h('i', { style: `border-color:var(${b});background:var(${f})` }), t)));

  /* ---------- Шкалы метрик ---------- */
  const level = (v, mid, high) => v >= high ? 'high' : v >= mid ? 'mid' : 'low';
  // prev — значения до раскрытия: шкала плавно доезжает до нового значения.
  function meters(v, prev) {
    const m = v.metrics;
    const delta = (cur, before, fmt) => before == null || cur === before ? null
      : h('span', { class: 'm-delta ' + (cur > before ? 'up' : 'down') }, (cur > before ? '+' : '−') + fmt(Math.abs(cur - before)));
    const moneyPct = Math.min(100, m.money / v.moneyLimit * 100);
    const rows = [
      { name: 'Напряжение', val: String(m.tension), pct: m.tension, lvl: level(m.tension, 40, 71), base: 50, d: delta(m.tension, prev && prev.tension, String) },
      { name: 'Потери, лимит ' + rub(v.moneyLimit), val: rub(m.money), pct: moneyPct, lvl: level(moneyPct, 50, 100), d: delta(m.money, prev && prev.money, rub) },
      { name: 'Время восстановления', val: m.ttrMin + ' мин', pct: null, d: delta(m.ttrMin, prev && prev.ttrMin, x => x + ' мин') },
    ];
    return rows.map(r => {
      const fill = r.pct === null ? null : h('div', { class: 'm-fill lvl-' + r.lvl, style: 'width:' + r.pct + '%' });
      return h('div', { class: 'meter' },
        h('span', { class: 'm-name' }, r.name),
        h('span', null, h('span', { class: 'm-val' }, r.val), r.d),
        r.pct === null ? null : h('div', { class: 'm-track' }, fill, r.base ? h('div', { class: 'm-base', style: 'left:' + r.base + '%', title: 'уровень на старте' }) : null));
    });
  }

  function verdictTag(vd) { return h('span', { class: 'tag ' + vd.level }, vd.label); }

  /* ---------- Хранилище устройства: может быть недоступно (приватный режим) ---------- */
  const mem = {};
  const store = {
    get(k) { try { const v = localStorage.getItem(k); if (v !== null) return v; } catch (e) { /* нет хранилища */ } return mem[k] || null; },
    set(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch (e) { /* только в памяти */ } },
    del(k) { delete mem[k]; try { localStorage.removeItem(k); } catch (e) { /* только в памяти */ } },
  };

  /* ---------- QR-код (ui/qr.js) как SVG: тёмные модули одним путём, тихая зона 4 модуля ---------- */
  function qr(text, label) {
    const q = QR.encode(text), n = q.size + 8;
    let d = '';
    q.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += 'M' + (x + 4) + ' ' + (y + 4) + 'h1v1h-1z'; }));
    const svg = el('svg', { viewBox: '0 0 ' + n + ' ' + n, class: 'qr', role: 'img', 'aria-label': label || ('QR-код: ' + text), 'shape-rendering': 'crispEdges' });
    svg.appendChild(el('rect', { width: n, height: n, fill: '#fff' }));
    svg.appendChild(el('path', { d, fill: '#000' }));
    return svg;
  }

  /* ---------- Звук конца фазы: короткий двойной сигнал без файлов (WebAudio) ---------- */
  let audio = null;
  function audioCtx() {
    if (!audio && (window.AudioContext || window.webkitAudioContext)) audio = new (window.AudioContext || window.webkitAudioContext)();
    return audio;
  }
  // Браузер разрешает звук только после действия пользователя на странице.
  const soundReady = () => !!audio && audio.state === 'running';
  function unlockSound() { const a = audioCtx(); if (a && a.state !== 'running') a.resume().catch(() => {}); }
  function beep() {
    const a = audioCtx();
    if (!a || a.state !== 'running') return false;
    [0, 0.28].forEach(t => {
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, a.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, a.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + t + 0.22);
      o.connect(g).connect(a.destination);
      o.start(a.currentTime + t); o.stop(a.currentTime + t + 0.25);
    });
    return true;
  }
  const serverNow = () => Date.now() + offset;

  function toggleTheme() {
    const r = document.documentElement;
    if (r.getAttribute('data-theme') === 'dark') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', 'dark');
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Итоги скопированы в Markdown'); return; } catch (e) { /* запасной путь ниже */ }
    const ta = h('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Итоги скопированы в Markdown'); } catch (e) { toast('Буфер обмена недоступен'); }
    ta.remove();
  }

  window.UI = { ROOM, BASE, api, qr, beep, unlockSound, soundReady, serverNow, $, h, mount, plural, signed, mmss, rub, PHASES, toast, showError, connect, post, timer, diagram, legend, meters, verdictTag, store, toggleTheme, copy };
})();
