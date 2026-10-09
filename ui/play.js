/* Телефон роли (#play): выбор свободной роли, приватные данные шага, голос. */
(function () {
  'use strict';
  const { h, mount, PHASES, timer, verdictTag, store, post, toast } = UI;

  // Токен устройства: перезагрузка или уснувший телефон возвращают ту же роль без участия ведущего.
  function deviceToken() {
    let t = store.get('incw-token');
    if (!t) {
      t = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
      store.set('incw-token', t);
    }
    return t;
  }

  let es = null, role = null, last = null, busy = false;
  const token = deviceToken();

  function reconnect() {
    if (es) es.close();
    es = UI.connect(role ? { view: 'play', role, token } : { view: 'play' }, render);
  }

  async function claim(id) {
    if (busy) return;
    busy = true;
    const r = await post('/api/claim', { role: id, token });
    busy = false;
    if (!r.ok) return;
    role = id; store.set('incw-role', id);
    reconnect();
  }

  async function vote(optionId) {
    if (busy || !last || last.myVote) return;
    busy = true;
    const r = await post('/api/vote', { role, token, option: optionId });
    busy = false;
    if (r.status === 403) { toast('Роль передана другому устройству'); role = null; store.del('incw-role'); reconnect(); }
  }

  function head(v) {
    return h('div', { class: 'p-head' },
      h('span', { class: 'who' }, v.role ? v.role.name : 'Выбор роли'),
      h('span', { class: 'where' }, v.phase === 'lobby' ? 'Лобби' : v.phase === 'end' ? 'Итоги' : 'Шаг ' + v.stepNo + ' из ' + v.stepTotal + ' · ' + PHASES[v.phase], ' ', timer(v)));
  }

  function picker(v) {
    const free = v.seats.filter(s => !s.taken).length;
    return [
      h('div', { class: 'p-sect' },
        h('h2', null, 'Команда «' + v.team + '»'),
        h('p', { class: 'muted' }, free ? 'Выберите свою роль. Первый занявший получает её, остальным она закрыта.' : 'Все пять ролей заняты. Следите за проектором — решения принимает команда.')),
      h('div', { class: 'p-roles' }, v.seats.map(s => h('button', { class: 'btn', disabled: s.taken, onclick: () => claim(s.id) },
        h('span', null, s.name), h('small', null, s.taken ? 'занята' : 'свободна')))),
    ];
  }

  const STATUS = {
    situation: ['Прочитайте свои данные. Скоро ведущий спросит вас.', false],
    discussion: ['Обсуждение. Перескажите свои данные словами — экран не показывайте.', false],
    voting: ['Голосование открыто. Голос окончательный.', true],
  };

  function stepScreen(v) {
    const st = v.step, out = [];
    if (v.phase === 'revealed' && v.revealed) {
      out.push(h('div', { class: 'p-sect' }, h('h2', null, 'Команда выбрала'),
        h('p', null, v.revealed.label, ' ', verdictTag(v.revealed.verdict)),
        h('p', { style: 'margin-top:.5rem' }, v.revealed.revealText)));
    } else if (STATUS[v.phase]) {
      const [text, go] = STATUS[v.phase];
      out.push(h('div', { class: 'p-status' + (go && !v.myVote ? ' go' : '') }, v.myVote ? 'Голос учтён. Ждём остальных: ' + v.votedCount + ' из 5.' : text));
    }
    out.push(h('div', { class: 'p-sect' }, h('h2', null, st.title),
      h('pre', { class: 'data' }, v.private.data),
      h('div', { class: 'deliver' }, h('b', null, 'Донесите команде: '), v.private.deliver)));
    if (v.phase !== 'revealed') {
      const open = v.phase === 'voting' && !v.myVote;
      out.push(h('div', { class: 'p-sect' }, h('h2', null, st.question),
        h('div', { class: 'p-vote' }, st.options.map((o, i) => h('button', {
          class: 'btn' + (v.myVote === o.id ? ' mine' : ''), disabled: !open, onclick: () => vote(o.id),
        }, h('span', { class: 'num-badge' }, i + 1), o.label))),
        v.phase === 'voting' ? null : h('p', { class: 'p-note' }, 'Кнопки станут активны, когда ведущий откроет голосование.')));
    }
    return out;
  }

  function render(v) {
    last = v;
    // Роль освободил ведущий или заняло другое устройство — возвращаем к выбору.
    if (role && !v.role) { role = null; store.del('incw-role'); toast('Роль освобождена ведущим — выберите снова'); }
    let body;
    if (!v.role) body = picker(v);
    else if (v.phase === 'lobby') body = h('div', { class: 'p-sect' }, h('h2', null, 'Ваша миссия'), h('p', null, v.role.mission),
      h('div', { class: 'deliver' }, h('b', null, 'Только для вас: '), v.role.welcomePrivate),
      h('p', { class: 'p-status' }, 'Ждём старта. Команда «' + v.team + '».'));
    else if (v.phase === 'end') body = h('div', { class: 'p-sect' }, h('h2', null, v.summary.grade.label),
      h('p', null, 'Очки команды: ' + v.summary.score + ' из ' + v.summary.max + '.'), h('p', { class: 'p-note' }, 'Разбор — на проекторе. Спасибо за игру!'));
    else body = stepScreen(v);
    mount('playBody', head(v), body);
  }

  function start() {
    document.title = 'Роль — инцидент-тренировка';
    role = store.get('incw-role');
    reconnect();
  }

  window.PLAY = { start };
})();
