/* Проектор (#screen): инцидент, варианты без подсказок, последствия, итоги. Только чтение. */
(function () {
  'use strict';
  const { h, mount, plural, signed, mmss, rub, PHASES, timer, diagram, legend, meters, verdictTag } = UI;

  let playUrls = [], publicUrl = false;
  let lastReveal = null;
  let last = null;
  let beeped = null; // phaseAt фазы, по которой уже прозвучал сигнал

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
          h('div', { class: 's-qr' }, UI.qr(joinUrl(), 'QR-код для телефонов: ' + joinUrl())),
          h('div', null,
            h('p', { class: 'muted' }, 'Роли и зрители открывают на телефоне:'),
            h('p', { class: 'url' }, joinUrl()),
            local && !publicUrl && playUrls.length > 1 ? h('p', { class: 'muted' }, 'Если не открывается: ' + playUrls.slice(1, 3).join(' или ')) : null,
            v.joinRequired ? h('p', { class: 'muted' }, 'Код входа скажет ведущий.') : null,
            h('p', { class: 'muted', style: 'margin-top:.5rem' }, 'Экран телефона не показываем соседям: данные передаём словами, как на настоящем бридже.')))),
      h('div', { class: 'panel' },
        h('h3', null, 'Команда «' + v.team + '» — ' + taken + ' из 5 на местах'),
        seats(v),
        h('p', { class: 'muted', style: 'margin-top:.8rem' }, 'При ничьей решает Командир инцидента.')));
  }

  // Проектор открыт не с localhost (Docker, прокси, интернет) — значит, этот адрес и доступен телефонам.
  // С localhost — берём адрес ноутбука в локальной сети от сервера (или PUBLIC_URL).
  const local = /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);
  function joinUrl() { return (!local && !publicUrl) ? location.origin + UI.BASE + '#play' : playUrls[0] || location.origin + UI.BASE + '#play'; }

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
        v.seats.map(s => h('span', { class: 'chip' + (s.voted ? ' on' : '') }, s.name)),
        v.audienceCount ? h('span', { class: 's-aud-count' }, 'Зал: ' + v.audienceCount + ' ' + plural(v.audienceCount, 'голос', 'голоса', 'голосов')) : null) : null);
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
      h('p', { class: 's-reveal' }, r.revealText),
      r.audience ? audienceBars(v, r) : null);
    return h('div', { class: 's-grid' }, left, aside(v));
  }

  // Как проголосовал зал — подсказка для разбора: совпал ли он с ролями.
  function audienceBars(v, r) {
    const a = r.audience;
    return h('div', { class: 's-aud' },
      h('p', { class: 's-aud-title' }, 'Зал (' + a.total + ' ' + plural(a.total, 'голос', 'голоса', 'голосов') + ') выбрал бы:'),
      v.step.options.map((o, i) => {
        const pct = Math.round(a.counts[o.id] / a.total * 100);
        return h('div', { class: 's-aud-row' + (o.id === r.optionId ? ' chosen' : '') },
          h('span', { class: 'num-badge' }, i + 1),
          h('span', { class: 's-aud-label' }, o.label),
          h('span', { class: 's-aud-pct' }, pct + '%'),
          h('span', { class: 's-aud-track' }, h('span', { class: 's-aud-fill', style: 'width:' + pct + '%' })));
      }));
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

  // Сигнал конца фазы: один раз, когда таймер доходит до нуля (если ведущий включил звук).
  function soundTick() {
    const v = last;
    if (!v || !v.sound || !v.phaseSec || !v.phaseAt || beeped === v.phaseAt) return;
    if (UI.serverNow() >= v.phaseAt + v.phaseSec * 1000) { beeped = v.phaseAt; UI.beep(); }
  }
  function soundHint(v) {
    if (!v.sound || UI.soundReady()) return null;
    return h('p', { class: 's-sound' }, 'Звук включён ведущим: щёлкните по этому экрану, чтобы браузер разрешил сигнал.');
  }

  function render(v) {
    // Фаза, таймер которой уже истёк при подключении, не пищит задним числом.
    // Так же — если звук включили, когда таймер уже истёк.
    if (!last || last.phaseAt !== v.phaseAt || (!last.sound && v.sound)) beeped = v.phaseSec && UI.serverNow() >= v.phaseAt + v.phaseSec * 1000 ? v.phaseAt : null;
    last = v;
    const body = v.phase === 'lobby' ? lobby(v) : v.phase === 'end' ? finalView(v) : v.phase === 'revealed' ? revealView(v) : stepView(v);
    mount('screenBody', bar(v), soundHint(v), body);
    animateMeters(v);
  }

  function start() {
    document.title = 'Проектор — инцидент-тренировка';
    fetch(UI.api('/api/info')).then(r => r.json()).then(i => { playUrls = i.playUrls || []; publicUrl = !!i.publicUrl; if (last) render(last); }).catch(() => {});
    setInterval(soundTick, 500);
    const unlock = () => { UI.unlockSound(); setTimeout(() => last && render(last), 100); };
    document.addEventListener('click', unlock);
    UI.connect({ view: 'screen' }, render);
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      UI.unlockSound();
      if (e.code === 'KeyT') UI.toggleTheme();
      if (e.code === 'KeyF') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
    });
  }

  window.SCREEN = { start };
})();
