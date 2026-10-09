/* Пульт ведущего (#gm): всё видно, всё управляется. Защищён GM_PIN, если он задан. */
(function () {
  'use strict';
  const { h, mount, plural, signed, mmss, rub, PHASES, timer, verdictTag, store, post, toast, copy } = UI;

  let pin = store.get('incw-pin') || '';
  let es = null, last = null;

  async function send(type, extra) {
    const r = await post('/api/cmd', Object.assign({ type }, extra || {}), { 'x-gm-pin': pin });
    if (r.status === 401) askPin('PIN не подошёл');
    return r.ok;
  }
  const confirmSend = (question, type, extra) => { if (confirm(question)) send(type, extra); };

  /* ---------- PIN ---------- */
  function askPin(err) {
    if (es) { es.close(); es = null; }
    store.del('incw-pin');
    const input = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'PIN ведущего' });
    const go = async e => {
      e.preventDefault();
      pin = input.value.trim();
      const r = await fetch('/api/auth', { headers: { 'x-gm-pin': pin } });
      if (r.ok) { store.set('incw-pin', pin); open(); } else askPin('PIN не подошёл');
    };
    mount('gmBody', h('form', { class: 'g-pin panel g-form', onsubmit: go },
      h('h2', null, 'Пульт ведущего'),
      h('label', null, 'PIN ведущего', input),
      err ? h('p', { style: 'color:var(--sev);font-weight:600' }, err) : null,
      h('button', { class: 'btn primary', type: 'submit' }, 'Открыть пульт')));
    input.focus();
  }

  /* ---------- Общие блоки ---------- */
  function bar(v) {
    return h('div', { class: 'g-bar' },
      h('div', null, h('span', { class: 'case' }, v.title), ' ', h('span', { class: 'muted' }, '· ' + v.team)),
      h('div', { class: 'info' },
        v.phase === 'lobby' || v.phase === 'end' ? null : h('span', null, 'Шаг ', h('b', null, v.stepNo + ' из ' + v.stepTotal)),
        h('span', { class: 'phase' }, PHASES[v.phase]), timer(v),
        h('span', null, 'Очки ', h('b', null, v.score + ' / ' + v.maxScore)),
        h('span', null, 'Напряжение ', h('b', null, v.metrics.tension)),
        h('span', null, 'Потери ', h('b', null, rub(v.metrics.money))),
        h('span', null, 'TTR ', h('b', null, v.metrics.ttrMin + ' мин')),
        v.canUndo ? h('button', { class: 'btn small', onclick: () => send('undo'), title: 'Если нажали не то: вернуть предыдущее состояние (очки, метрики, журнал)' }, 'Откатить') : null));
  }

  function seatsPanel(v) {
    return h('div', { class: 'panel' }, h('h3', null, 'Роли: ' + v.seats.filter(s => s.taken).length + ' из 5 на местах'),
      h('ul', { class: 'g-votes' }, v.seats.map(s => h('li', null, h('span', null, s.name),
        h('span', null, s.taken ? h('span', null, h('span', { style: 'color:var(--ok);font-weight:600;margin-right:.6rem' }, 'на месте'),
          h('button', { class: 'btn small', onclick: () => confirmSend('Освободить роль «' + s.name + '»? Телефон игрока вернётся к выбору роли.', 'release', { role: s.id }) }, 'Освободить'))
          : h('span', { class: 'muted' }, 'свободна'))))));
  }

  function dangerZone(v) {
    const sel = h('select', { 'aria-label': 'Кейс новой партии' }, v.catalog.map(c => h('option', { value: c.id, selected: c.id === v.scenarioId }, c.title)));
    return h('div', { class: 'g-danger' }, h('h3', null, 'Редкие действия'),
      h('div', { class: 'g-actions' },
        v.phase !== 'lobby' && v.phase !== 'end' ? h('button', { class: 'btn danger', onclick: () => confirmSend('Перейти к итогам досрочно? Оставшиеся шаги не будут сыграны.', 'finish') }, 'Перейти к итогам') : null,
        sel,
        h('button', { class: 'btn danger', onclick: () => confirmSend('Начать новую партию? Текущая уйдёт в архив; команда и роли сохранятся.', 'reset', { scenarioId: sel.value }) }, 'Новая партия')));
  }

  function links(v) {
    return h('p', { class: 'g-links' },
      h('a', { href: '/#screen', target: '_blank' }, 'Открыть проектор'),
      h('a', { href: '/#cards', target: '_blank' }, 'Карточки ролей для печати'),
      h('span', null, 'Телефоны: ' + location.host + '/#play'),
      v.gmPin ? null : h('span', { class: 'note-warn' }, 'Пульт без PIN: защитите — GM_PIN=4821 npm start'));
  }

  /* ---------- Лобби ---------- */
  function lobby(v) {
    const team = h('input', { value: v.team, maxlength: 40, autocomplete: 'off' });
    const saveTeam = () => { if (team.value.trim() && team.value.trim() !== v.team) send('team', { team: team.value }); };
    team.addEventListener('change', saveTeam);
    const taken = v.seats.filter(s => s.taken).length;
    return h('div', { class: 'g-grid' },
      h('div', { class: 'g-col' },
        h('div', { class: 'panel' }, h('h3', null, 'Кейс'),
          h('div', { class: 'g-cases' }, v.catalog.map(c => h('button', {
            class: 'g-case', 'aria-pressed': String(c.id === v.scenarioId),
            onclick: () => { if (c.id !== v.scenarioId) send('reset', { scenarioId: c.id }); },
          }, h('h3', null, c.title), h('p', null, c.brief), h('p', null, c.steps + ' ' + plural(c.steps, 'шаг', 'шага', 'шагов') + ' · ~' + c.etaMin + ' мин · ' + c.difficulty))))),
        h('div', { class: 'panel g-form' },
          h('label', null, 'Название команды', team),
          h('button', { class: 'btn primary', onclick: () => { saveTeam(); send('start'); } }, 'Начать игру'),
          h('p', { class: 'muted' }, taken === 5 ? 'Все роли на местах.' : 'На местах ' + taken + ' из 5. Можно начинать и так: голоса пустых ролей вписываете вы (бумажный режим).')),
        links(v)),
      h('div', { class: 'g-col' }, seatsPanel(v), dangerZone(v)));
  }

  /* ---------- Раунд ---------- */
  function roundControls(v) {
    const t = v.tally, nextLabel = v.stepNo >= v.stepTotal ? 'К итогам' : 'Дальше: шаг ' + (v.stepNo + 1);
    if (v.phase === 'situation') return [
      h('p', { class: 'muted' }, 'Прочитайте ситуацию вслух. Роли читают приватку на телефонах.'),
      h('div', { class: 'g-actions' }, h('button', { class: 'btn primary', onclick: () => send('discussion') }, 'Открыть обсуждение'),
        h('button', { class: 'btn', onclick: () => send('voting') }, 'Сразу к голосованию'))];
    if (v.phase === 'discussion') return [
      h('p', { class: 'muted' }, 'Опросите роли по очереди. Зал советует, решают роли.'),
      h('div', { class: 'g-actions' }, h('button', { class: 'btn primary', onclick: () => send('voting') }, 'Открыть голосование'))];
    if (v.phase === 'voting') {
      const byRole = v.seats.filter(s => v.votes[s.id]).map(s => s.name.split(' ')[0] + ' — ' + (v.step.options.findIndex(o => o.id === v.votes[s.id]) + 1));
      const tieNote = t.tie && !t.winner ? h('p', { class: 'note-warn' }, 'Ничья. Командир называет вариант — выберите его в списке ниже.')
        : t.tie ? h('p', null, 'Ничья — решает голос Командира: вариант ' + (v.step.options.findIndex(o => o.id === t.winner) + 1) + '.') : null;
      return [
        h('p', { class: 'g-tally' }, t.total + '/5' + (byRole.length ? ': ' + byRole.join(', ') : ': голосов пока нет')),
        tieNote,
        h('div', { class: 'g-actions' },
          h('button', { class: 'btn primary', disabled: !t.winner, onclick: () => send('reveal') }, 'Раскрыть последствия'),
          h('button', { class: 'btn', onclick: () => confirmSend('Сбросить голоса и голосовать заново?', 'revote') }, 'Повторное голосование'))];
    }
    if (v.phase === 'revealed') {
      const o = v.step.options.find(x => x.id === v.revealed.optionId);
      return [
        h('p', null, 'Выбрано: ', h('b', null, o.label), ' ', verdictTag(o.verdict)),
        h('div', { class: 'g-hint' }, h('b', null, 'Для мини-разбора: '), o.debrief),
        h('div', { class: 'g-actions', style: 'margin-top:.7rem' }, h('button', { class: 'btn primary', onclick: () => send('next') }, nextLabel))];
    }
    return [];
  }

  function optionsPanel(v) {
    const t = v.tally;
    return h('div', { class: 'panel' }, h('h3', null, 'Варианты — что видит зал и что за ними'),
      h('div', { class: 'g-opts' }, v.step.options.map((o, i) => h('div', { class: 'g-opt' + (v.revealed && v.revealed.optionId === o.id ? ' chosen' : '') },
        h('span', { class: 'num-badge' }, i + 1),
        h('span', { class: 'lbl' }, o.label, ' ', verdictTag(o.verdict)),
        h('span', { class: 'cnt', title: 'голосов' }, v.phase === 'voting' ? String(t.counts[o.id]) : signed(o.score)),
        h('span', { class: 'meta' }, signed(o.score) + ' ' + plural(Math.abs(o.score), 'очко', 'очка', 'очков') + ' · напряжение ' + signed(o.effects.tension) + ' · потери ' + rub(o.effects.money) + ' · TTR +' + o.effects.ttrMin + ' мин'),
        h('span', { class: 'deb' }, o.debrief),
        v.phase === 'voting' ? h('span', { class: 'deb' }, h('button', { class: 'btn small', onclick: () => confirmSend('Раскрыть вариант ' + (i + 1) + ' вне зависимости от голосов?', 'reveal', { option: o.id }) }, 'Раскрыть этот вариант')) : null))));
  }

  function votesPanel(v) {
    if (v.phase !== 'voting') return null;
    return h('div', { class: 'panel' }, h('h3', null, 'Голоса ролей — видите только вы'),
      h('ul', { class: 'g-votes' }, v.seats.map(s => {
        const mine = v.votes[s.id];
        let cell;
        if (mine) cell = h('b', null, 'вариант ' + (v.step.options.findIndex(o => o.id === mine) + 1));
        else {
          const sel = h('select', { 'aria-label': 'Голос за роль ' + s.name, onchange: e => { if (e.target.value) send('vote', { role: s.id, option: e.target.value }); } },
            h('option', { value: '' }, s.taken ? 'ждём… или вписать голос' : 'вписать голос (бумага)'),
            v.step.options.map((o, i) => h('option', { value: o.id }, (i + 1) + '. ' + o.label)));
          cell = sel;
        }
        return h('li', null, h('span', null, s.name), cell);
      })));
  }

  function privatePanel(v) {
    return h('div', { class: 'panel' }, h('h3', null, 'Приватка ролей на этом шаге'),
      Object.keys(v.roles).map(id => {
        const p = v.step.private[id], seat = v.seats.find(s => s.id === id);
        return h('div', { class: 'g-priv' },
          h('h4', null, h('span', null, v.roles[id].name), h('span', { class: 'muted', style: 'font-weight:500' }, seat.taken ? '' : 'роль свободна — озвучьте сами')),
          h('div', { class: 'deliver' }, h('b', null, 'Должен донести: '), p.deliver),
          h('pre', { class: 'data', style: 'margin-top:.4rem' }, p.data));
      }));
  }

  function stepView(v) {
    return h('div', { class: 'g-grid' },
      h('div', { class: 'g-col' },
        h('div', { class: 'panel g-step' }, h('h2', null, v.step.title), h('p', { class: 'muted', style: 'margin-top:.4rem' }, v.step.brief),
          h('div', { class: 'g-hint' }, h('b', null, 'Как подать: '), v.step.hint)),
        h('div', { class: 'panel' }, h('h3', null, 'Раунд'), roundControls(v)),
        votesPanel(v),
        optionsPanel(v),
        v.upcoming.length ? h('p', { class: 'muted' }, 'Дальше: ' + v.upcoming.join(' → ')) : null),
      h('div', { class: 'g-col' }, privatePanel(v), seatsPanel(v), links(v), dangerZone(v)));
  }

  /* ---------- Итоги ---------- */
  function finalView(v) {
    const s = v.summary;
    return h('div', { class: 'g-grid' },
      h('div', { class: 'g-col' },
        h('div', { class: 'panel' }, h('h2', null, s ? s.grade.label : 'Итоги'),
          s ? h('p', { style: 'margin-top:.4rem' }, 'Очки ' + s.score + ' из ' + s.max + ' · лучших решений ' + s.best + ' из ' + s.steps.length + ' · ловушки ' + s.traps + ' · потери ' + rub(s.metrics.money) + ' · TTR ' + s.metrics.ttrMin + ' мин · игра ' + mmss(s.totalSec)) : null,
          h('div', { class: 'g-actions', style: 'margin-top:.8rem' }, h('button', { class: 'btn primary', onclick: () => copy(v.report) }, 'Скопировать итоги'))),
        s ? h('div', { class: 'panel g-final' }, h('h3', null, 'Разбор: долгие шаги первыми'),
          h('ol', null, s.steps.slice().sort((a, b) => b.sec - a.sec).map(x => h('li', null, h('b', null, x.title), ' — ' + mmss(x.sec) + '. ' + x.label + ' (' + x.verdict.label.toLowerCase() + ')' + (x.isBest ? '' : '. Лучше: ' + x.bestLabel))))) : null),
      h('div', { class: 'g-col' },
        s ? h('div', { class: 'panel g-final' }, h('h3', null, 'Вопросы залу'), h('ol', null, s.debriefQuestions.map(q => h('li', null, q)))) : null,
        dangerZone(v)));
  }

  function render(v) {
    last = v;
    const body = v.phase === 'lobby' ? lobby(v) : v.phase === 'end' ? finalView(v) : stepView(v);
    // Не перерисовываем, пока ведущий печатает название команды: иначе ввод собьётся.
    const a = document.activeElement;
    if (a && a.tagName === 'INPUT' && document.getElementById('gm').contains(a) && v.phase === 'lobby') return;
    mount('gmBody', bar(v), body);
  }

  function open() {
    if (es) es.close();
    es = UI.connect({ view: 'gm', pin }, render);
  }

  async function start() {
    document.title = 'Пульт ведущего — инцидент-тренировка';
    const r = await fetch('/api/auth', { headers: { 'x-gm-pin': pin } }).catch(() => null);
    if (r && r.status === 401) askPin(pin ? 'PIN не подошёл' : '');
    else open();
    document.addEventListener('keydown', e => {
      if (e.code === 'KeyT' && !(e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName))) UI.toggleTheme();
    });
  }

  /* ---------- Карточки ролей для бумажного режима ---------- */
  async function cards() {
    document.title = 'Карточки ролей — инцидент-тренировка';
    const r = await fetch('/api/pack', { headers: { 'x-gm-pin': pin } });
    if (!r.ok) { mount('cardsBody', h('p', { class: 'panel' }, 'Откройте сначала пульт ведущего (#gm) и введите PIN — карточки доступны только ведущему.')); return; }
    const p = await r.json();
    mount('cardsBody',
      h('div', { class: 'no-print g-actions', style: 'margin-bottom:1rem' }, h('button', { class: 'btn primary', onclick: () => print() }, 'Печать'),
        h('span', { class: 'muted' }, p.meta.title + ': по стопке на роль, ведущий раздаёт карточку шага в начале раунда.')),
      Object.keys(p.roles).map((id, n) => [
        h('div', { class: 'card' + (n ? ' card-role' : '') }, h('h2', null, p.roles[id].name), h('p', null, p.roles[id].mission),
          h('div', { class: 'deliver' }, h('b', null, 'Только для вас: '), p.roles[id].welcomePrivate)),
        p.steps.map((st, i) => h('div', { class: 'card' },
          h('p', { class: 'muted' }, p.roles[id].name + ' · шаг ' + (i + 1) + ' из ' + p.steps.length),
          h('h3', null, st.title), h('pre', { class: 'data' }, st.private[id].data),
          h('div', { class: 'deliver' }, h('b', null, 'Донесите команде: '), st.private[id].deliver))),
      ]));
  }

  window.GM = { start, cards };
})();
