/* Телефон (#play): роль — приватные данные и решающий голос; зритель — голос-подсказка для разбора. */
(function () {
  'use strict';
  const { h, mount, PHASES, timer, verdictTag, store, post, toast } = UI;

  // Токен устройства живёт в HttpOnly-cookie, которую выдаёт сервер: перезагрузка или уснувший телефон
  // возвращают ту же роль, а токен не виден странице и не попадает в адреса запросов.
  // Токен из localStorage (до 2.2) переносится в cookie один раз — занятая роль не теряется.
  async function ensureDevice() {
    const old = store.get('incw-token');
    await post('/api/device', old ? { token: old } : {});
    store.del('incw-token');
  }
  // Ключи устройства — по комнате: в другой комнате у того же телефона своя роль.
  const key = k => 'incw-' + k + (UI.ROOM === 'main' ? '' : '-' + UI.ROOM);

  let es = null, role = null, spectator = false, last = null, busy = false;
  let code = store.get(key('code')) || '';

  function reconnect() {
    if (es) es.close();
    es = UI.connect(role ? { view: 'play', role } : { view: 'play' }, render);
  }

  async function claim(id) {
    if (busy) return;
    busy = true;
    const r = await post('/api/claim', { role: id, code });
    busy = false;
    if (r.status === 403) { code = ''; store.del(key('code')); if (last) render(last); return; }
    if (!r.ok) return;
    role = r.data.role; store.set(key('role'), role);
    spectator = false; store.del(key('spectator'));
    reconnect();
  }

  async function vote(optionId) {
    if (busy || !last) return;
    busy = true;
    if (role) {
      if (last.myVote) { busy = false; return; }
      const r = await post('/api/vote', { role, option: optionId });
      if (r.status === 403) { toast('Роль передана другому устройству'); role = null; store.del(key('role')); reconnect(); }
    } else {
      if (last.audienceVote) { busy = false; return; }
      const r = await post('/api/audience', { option: optionId, code });
      if (r.status === 403) { code = ''; store.del(key('code')); render(last); }
    }
    busy = false;
  }

  function becomeSpectator(on) {
    spectator = on;
    if (on) store.set(key('spectator'), '1'); else store.del(key('spectator'));
    if (last) render(last);
  }

  function head(v) {
    return h('div', { class: 'p-head' },
      h('span', { class: 'who' }, v.role ? v.role.name : spectator ? 'Зритель' : 'Выбор роли'),
      h('span', { class: 'where' }, v.phase === 'lobby' ? 'Лобби' : v.phase === 'end' ? 'Итоги' : 'Шаг ' + v.stepNo + ' из ' + v.stepTotal + ' · ' + PHASES[v.phase], ' ', timer(v)));
  }

  // Код входа (если ведущий его включил): спрашиваем один раз, телефон запоминает.
  function codeForm(v, then) {
    const input = h('input', { class: 'p-code', inputmode: 'text', autocomplete: 'off', maxlength: 12, 'aria-label': 'Код входа', placeholder: 'Код от ведущего' });
    return h('form', { class: 'p-sect', onsubmit: e => { e.preventDefault(); code = input.value.trim(); store.set(key('code'), code); then(); } },
      h('h2', null, 'Код входа'),
      h('p', { class: 'muted' }, 'Ведущий включил код для этой игры. Спросите его у ведущего.'),
      input,
      h('button', { class: 'btn primary', type: 'submit', style: 'margin-top:.6rem;width:100%' }, 'Продолжить'));
  }

  function picker(v) {
    if (v.joinRequired && !code) return codeForm(v, () => render(v));
    const free = v.seats.filter(s => !s.taken).length;
    return [
      h('div', { class: 'p-sect' },
        h('h2', null, 'Команда «' + v.team + '»'),
        h('p', { class: 'muted' }, free ? 'Выберите свою роль. Первый занявший получает её, остальным она закрыта.' : 'Все пять ролей заняты. Можно голосовать как зритель — это подсказка для разбора, решают роли.')),
      h('div', { class: 'p-roles' },
        free ? h('button', { class: 'btn primary', onclick: () => claim('any') }, h('span', null, 'Мне любую свободную роль'), h('small', null, 'жребий')) : null,
        v.seats.map(s => h('button', { class: 'btn', disabled: s.taken, onclick: () => claim(s.id) }, h('span', null, s.name), h('small', null, s.taken ? 'занята' : 'свободна')))),
      h('div', { class: 'p-sect' }, h('button', { class: 'btn', style: 'width:100%', onclick: () => becomeSpectator(true) }, 'Я в зале — голосовать как зритель')),
    ];
  }

  const STATUS = {
    situation: ['Прочитайте свои данные. Скоро ведущий спросит вас.', false],
    discussion: ['Обсуждение. Перескажите свои данные словами — экран не показывайте.', false],
    voting: ['Голосование открыто. Голос окончательный.', true],
  };

  function voteButtons(v, mine, open) {
    return h('div', { class: 'p-vote' }, v.step.options.map((o, i) => h('button', {
      class: 'btn' + (mine === o.id ? ' mine' : ''), disabled: !open, onclick: () => vote(o.id),
    }, h('span', { class: 'num-badge' }, i + 1), o.label)));
  }

  function revealed(v) {
    return h('div', { class: 'p-sect' }, h('h2', null, 'Команда выбрала'),
      h('p', null, v.revealed.label, ' ', verdictTag(v.revealed.verdict)),
      h('p', { style: 'margin-top:.5rem' }, v.revealed.revealText));
  }

  function stepScreen(v) {
    const st = v.step, out = [];
    if (v.phase === 'revealed' && v.revealed) out.push(revealed(v));
    else if (STATUS[v.phase]) {
      const [text, go] = STATUS[v.phase];
      out.push(h('div', { class: 'p-status' + (go && !v.myVote ? ' go' : '') }, v.myVote ? 'Голос учтён. Ждём остальных: ' + v.votedCount + ' из 5.' : text));
    }
    out.push(h('div', { class: 'p-sect' }, h('h2', null, st.title),
      h('pre', { class: 'data' }, v.private.data),
      h('div', { class: 'deliver' }, h('b', null, 'Донесите команде: '), v.private.deliver)));
    if (v.phase !== 'revealed') {
      out.push(h('div', { class: 'p-sect' }, h('h2', null, st.question), voteButtons(v, v.myVote, v.phase === 'voting' && !v.myVote),
        v.phase === 'voting' ? null : h('p', { class: 'p-note' }, 'Кнопки станут активны, когда ведущий откроет голосование.')));
    }
    return out;
  }

  // Зритель: видит вопрос, голосует в фазе голосования; голос не влияет на решение ролей.
  function spectatorScreen(v) {
    if (v.joinRequired && !code) return codeForm(v, () => render(v));
    const back = h('p', { class: 'p-note' }, h('button', { class: 'btn', style: 'width:100%', onclick: () => becomeSpectator(false) }, 'Выбрать роль'));
    if (v.phase === 'lobby') return [h('div', { class: 'p-status' }, 'Ждём старта. Когда роли будут голосовать, вы тоже сможете — как подсказка для разбора.'), back];
    if (v.phase === 'end') return [h('div', { class: 'p-sect' }, h('h2', null, v.summary.grade.label), h('p', null, 'Очки команды: ' + v.summary.score + ' из ' + v.summary.max + '.'), h('p', { class: 'p-note' }, 'Разбор — на проекторе.'))];
    if (v.phase === 'revealed' && v.revealed) return [revealed(v)];
    const open = v.phase === 'voting' && !v.audienceVote;
    return [
      h('div', { class: 'p-status' + (open ? ' go' : '') }, v.audienceVote ? 'Ваш голос учтён. Решают роли — зал узнает, совпал ли с ними, после раскрытия.'
        : v.phase === 'voting' ? 'Голосуйте: это подсказка для разбора, решение за ролями.' : 'Слушайте роли. Голосование откроет ведущий.'),
      h('div', { class: 'p-sect' }, h('h2', null, v.step.title), h('p', null, v.step.question)),
      voteButtons(v, v.audienceVote, open),
      v.audienceCount ? h('p', { class: 'p-note' }, 'Проголосовало зрителей: ' + v.audienceCount + '.') : null,
    ];
  }

  function render(v) {
    last = v;
    // Роль сервер находит по токену: после жребия она могла смениться, после «Освободить» — исчезнуть.
    if (v.role && v.role.id !== role) { if (role) toast('Ваша новая роль: ' + v.role.name); role = v.role.id; store.set(key('role'), role); }
    else if (role && !v.role) { role = null; store.del(key('role')); toast('Роль освобождена ведущим — выберите снова'); }
    let body;
    if (!v.role) body = spectator ? spectatorScreen(v) : picker(v);
    else if (v.phase === 'lobby') body = h('div', { class: 'p-sect' }, h('h2', null, 'Ваша миссия'), h('p', null, v.role.mission),
      h('div', { class: 'deliver' }, h('b', null, 'Только для вас: '), v.role.welcomePrivate),
      h('p', { class: 'p-status' }, 'Ждём старта. Команда «' + v.team + '».'));
    else if (v.phase === 'end') body = h('div', { class: 'p-sect' }, h('h2', null, v.summary.grade.label),
      h('p', null, 'Очки команды: ' + v.summary.score + ' из ' + v.summary.max + '.'), h('p', { class: 'p-note' }, 'Разбор — на проекторе. Спасибо за игру!'));
    else body = stepScreen(v);
    mount('playBody', head(v), body);
  }

  async function start() {
    document.title = 'Телефон — инцидент-тренировка';
    role = store.get(key('role'));
    spectator = !role && store.get(key('spectator')) === '1';
    await ensureDevice();
    reconnect();
  }

  window.PLAY = { start };
})();
