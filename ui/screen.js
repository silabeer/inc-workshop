/* Проектор (#screen): инцидент, варианты без подсказок, последствия, итоги. Только чтение. */
(function () {
  'use strict';
  const { h, mount, plural, signed, mmss, rub, PHASES, timer, diagram, legend, meters, verdictTag } = UI;

  let playUrls = [];
  let lastReveal = null;

  function bar(v) {
    const right = h('div', { class: 'right' },
      v.phase === 'lobby' || v.phase === 'end' ? null : h('span', { class: 'phase' }, PHASES[v.phase]),
      timer(v),
      v.phase === 'lobby' ? null : h('span', { class: 's-score' }, v.team, h('b', null, String(v.score).replace('-', '−'))));
    return h('div', { class: 's-bar' },
      h('div', null, h('span', { class: 'case' }, v.title),
        v.phase === 'lobby' || v.phase === 'end' ? null : h('span', { class: 'step' }, 'шаг ' + v.stepNo + ' из ' + v.stepTotal)),
      right);
  }

  function seats(v) {
    return h('ul', { class: 'seats' }, v.seats.map(s => h('li', null,
      h('span', null, s.name), h('span', { class: s.taken ? 'taken' : 'free' }, s.taken ? 'на месте' : 'свободна'))));
  }

  function lobby(v) {
    const taken = v.seats.filter(s => s.taken).length;
    return h('div', { class: 's-lobby' },
      h('div', null,
        h('h1', null, v.title),
        h('p', { class: 'lead' }, v.brief),
        h('div', { class: 's-join' },
          h('p', { class: 'muted' }, 'Пять ролей открывают на телефоне:'),
          playUrls.length ? playUrls.slice(0, 2).map(u => h('p', { class: 'url' }, u)) : h('p', { class: 'url' }, location.host + '/#play'),
          h('p', { class: 'muted', style: 'margin-top:.5rem' }, 'Экран телефона не показываем соседям: данные передаём словами, как на настоящем бридже.'))),
      h('div', { class: 'panel' },
        h('h3', null, 'Команда «' + v.team + '» — ' + taken + ' из 5 на местах'),
        seats(v),
        h('p', { class: 'muted', style: 'margin-top:.8rem' }, 'При ничьей решает Командир инцидента.')));
  }

  function aside(v) {
    return h('div', { class: 's-aside' },
      h('div', { class: 'panel s-metrics' }, meters(v, v.revealed && prevMetrics(v))),
      h('div', { class: 'panel' }, h('h3', null, 'Архитектура'), diagram(v.diagram, v.focus, v.diagramState), legend()));
  }
  function prevMetrics(v) {
    const fx = v.revealed.effects, m = v.metrics;
    return { tension: m.tension - fx.tension, money: m.money - fx.money, ttrMin: m.ttrMin - fx.ttrMin };
  }

  function stepView(v) {
    const st = v.step;
    const left = h('div', null,
      h('h2', { class: 's-title' }, st.title),
      h('p', { class: 's-brief' }, st.brief),
      h('p', { class: 's-question' }, st.question),
      h('ol', { class: 's-options' }, st.options.map((o, i) => h('li', null, h('span', { class: 'num-badge' }, i + 1), h('span', null, o.label)))),
      v.phase === 'voting' ? h('div', { class: 's-votes' },
        h('span', { class: 'lbl' }, 'Проголосовали ' + v.votedCount + ' из 5'),
        v.seats.map(s => h('span', { class: 'chip' + (s.voted ? ' on' : '') }, s.name))) : null);
    return h('div', { class: 's-grid' }, left, aside(v));
  }

  function revealView(v) {
    const r = v.revealed, idx = v.step.options.findIndex(o => o.id === r.optionId);
    const how = r.decidedBy === 'commander' ? ' — решил Командир при ничьей' : r.decidedBy === 'gm' ? ' — выбор ведущего' : '';
    const left = h('div', null,
      h('h2', { class: 's-title' }, v.step.title),
      h('p', { class: 's-picked' }, 'Команда выбрала: ', h('b', null, (idx + 1) + '. ' + r.label), how),
      h('div', { class: 's-delta' }, verdictTag(r.verdict),
        h('span', { class: 'pts', style: 'color:' + (r.gained > 0 ? 'var(--ok)' : r.gained < 0 ? 'var(--sev)' : 'var(--muted)') },
          signed(r.gained), h('small', null, plural(Math.abs(r.gained), 'очко', 'очка', 'очков')))),
      h('p', { class: 's-reveal' }, r.revealText));
    return h('div', { class: 's-grid' }, left, aside(v));
  }

  function finalView(v) {
    const s = v.summary;
    const lvl = s.score >= s.max * .85 ? 'var(--ok)' : s.score >= s.max * .35 ? 'var(--ink)' : 'var(--sev)';
    return [
      h('div', { class: 's-final-head' },
        h('div', null,
          h('h1', { style: 'color:' + lvl }, s.grade.label), h('p', null, s.grade.text)),
        h('div', { class: 'metrics' },
          [[s.score + ' / ' + s.max, 'очки'], [s.best + ' / ' + s.steps.length, 'лучших решений'], [rub(s.metrics.money), 'потери'],
            [s.metrics.ttrMin + ' мин', 'восстановление'], [mmss(s.totalSec), 'время игры']]
            .map(([b, t]) => h('div', { class: 'metric' }, h('b', null, b), h('span', null, t))))),
      h('div', { class: 's-grid' },
        h('div', null, h('h2', { style: 'font-size:1.4rem;margin-bottom:.3rem' }, 'Что выбрали и что было лучшим'),
          h('ol', { class: 'recap' }, s.steps.map(x => h('li', null,
            h('div', { class: 'r-title' }, x.title),
            h('div', { class: 'r-pts', style: 'color:' + (x.isBest ? 'var(--ok)' : x.gained < 0 ? 'var(--sev)' : 'var(--muted)') }, signed(x.gained)),
            h('div', { class: 'r-pick' }, x.label, x.isBest ? null : [' — ', h('span', { style: x.trap ? 'color:var(--sev);font-weight:600' : '' }, x.verdict.label.toLowerCase())]),
            x.isBest ? null : h('div', { class: 'r-better' }, 'Лучше: ' + x.bestLabel))))),
        h('div', { class: 'panel' }, h('h3', null, 'Что случилось на самом деле'), h('p', { class: 's-cause' }, s.rootCause))),
    ];
  }

  // Шкалы на раскрытии стартуют с прежних значений и доезжают до новых — зал видит последствия.
  function animateMeters(v) {
    const key = v.stepNo + ':' + (v.revealed && v.revealed.optionId);
    if (v.phase !== 'revealed' || key === lastReveal) { lastReveal = v.phase === 'revealed' ? key : null; return; }
    lastReveal = key;
    const fills = document.querySelectorAll('#screen .m-fill');
    const p = prevMetrics(v);
    const from = [p.tension, Math.min(100, p.money / v.moneyLimit * 100)];
    fills.forEach((f, i) => { const to = f.style.width; f.style.transition = 'none'; f.style.width = from[i] + '%'; f.getBoundingClientRect(); f.style.transition = ''; f.style.width = to; });
  }

  function render(v) {
    const body = v.phase === 'lobby' ? lobby(v) : v.phase === 'end' ? finalView(v) : v.phase === 'revealed' ? revealView(v) : stepView(v);
    mount('screenBody', bar(v), body);
    animateMeters(v);
  }

  function start() {
    document.title = 'Проектор — инцидент-тренировка';
    fetch('/api/info').then(r => r.json()).then(i => { playUrls = i.playUrls || []; }).catch(() => {});
    UI.connect({ view: 'screen' }, render);
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'KeyT') UI.toggleTheme();
      if (e.code === 'KeyF') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
    });
  }

  window.SCREEN = { start };
})();
