/* Движок единого воркшопа: валидация пака, раунды с голосованием пяти ролей, подсчёт и итоги.
   Чистые функции без DOM, сети и часов: время приходит параметром `now` (мс).
   Universal-модуль: в Node — module.exports, в браузере — глобал WORKSHOP_ENGINE.
   Правила и формат пака — docs/scenario-authoring.md. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.WORKSHOP_ENGINE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROLE_IDS = ['commander', 'scout', 'engineer', 'domain', 'comms'];
  const COLORS = ['red', 'yellow', 'green', 'gray'];
  // Мягкий таймер фазы: подсказка ведущему, автоперехода нет.
  const PHASE_SEC = { situation: 30, discussion: 90, voting: 30 };
  const START_TENSION = 50;
  const HISTORY_MAX = 40;
  const AUDIENCE_MAX = 1000; // голосов зала на шаг: защита от накрутки скриптом
  // Вбросы — помехи, которые ведущий запускает кнопкой: звонок руководства, личка роли, посторонний алерт,
  // новый человек на бридже, отказ инструмента (роль без своих данных), выбывший Координатор.
  const KINDS = ['call', 'ping', 'alert', 'joiner', 'outage', 'handover'];
  const ROLE_KINDS = ['ping', 'outage']; // вброс адресован одной роли
  // Исход вброса двигает шкалы, но не очки: шкала оценок пака не зависит от числа вбросов.
  const INTERRUPT_FX = { held: { tension: -3, ttrMin: 0 }, lost: { tension: 5, ttrMin: 2 } };
  const CALL_TAKERS = ['commander', 'comms'];

  const str = v => typeof v === 'string' && v.trim() !== '';
  const num = v => typeof v === 'number' && isFinite(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function fail(msg) { const e = new Error(msg); e.userError = true; throw e; }

  /* ---------- Пак ---------- */

  const bestScore = step => Math.max.apply(null, step.options.map(o => o.score));
  const maxScore = pack => pack.steps.reduce((s, st) => s + bestScore(st), 0);
  const minScore = pack => pack.steps.reduce((s, st) => s + Math.min.apply(null, st.options.map(o => o.score)), 0);
  const bestOption = step => step.options.find(o => o.score === bestScore(step) && !o.trap);

  function verdict(step, option) {
    if (option.trap) return { level: 'trap', label: 'Ловушка' };
    if (option.score === bestScore(step)) return { level: 'best', label: 'Лучший ход' };
    if (option.score > 0) return { level: 'ok', label: 'Приемлемо' };
    return { level: 'weak', label: 'Слабый ход' };
  }

  function grade(pack, score) {
    const sorted = pack.end.grades.slice().sort((a, b) => b.min - a.min);
    return sorted.find(g => score >= g.min) || sorted[sorted.length - 1];
  }

  function validate(pack) {
    const errs = [];
    if (!pack || typeof pack !== 'object') return ['пак не объект'];
    const meta = pack.meta || {};
    if (!str(meta.id) || !/^[\w-]+$/.test(meta.id)) errs.push('meta.id: нужна строка из латиницы, цифр, - и _');
    if (!str(meta.title)) errs.push('meta.title пуст');
    if (!str(meta.brief)) errs.push('meta.brief пуст');
    if (!num(meta.moneyLimit) || meta.moneyLimit <= 0) errs.push('meta.moneyLimit: нужно положительное число (₽)');

    const roles = pack.roles || {};
    const ids = Object.keys(roles);
    if (ids.length !== ROLE_IDS.length || !ROLE_IDS.every(r => roles[r])) errs.push('roles: нужны ровно пять ролей ' + ROLE_IDS.join(', '));
    for (const r of ids) {
      if (!ROLE_IDS.includes(r)) continue;
      for (const f of ['name', 'mission', 'welcomePrivate']) if (!str(roles[r][f])) errs.push(`роль ${r}: пустое поле ${f}`);
    }

    const diag = pack.diagram;
    const dIds = new Set();
    if (!diag || !Array.isArray(diag.nodes) || !diag.nodes.length) errs.push('нет диаграммы (diagram.nodes пуст)');
    else {
      for (const d of diag.nodes) {
        if (dIds.has(d.id)) errs.push(`диаграмма: дубль id ${d.id}`);
        dIds.add(d.id);
        if (!num(d.x) || !num(d.y)) errs.push(`диаграмма: узел ${d.id}: координаты x/y должны быть числами`);
        if (d.color && !COLORS.includes(d.color)) errs.push(`диаграмма: узел ${d.id}: цвет ${d.color} не из ${COLORS.join('/')}`);
      }
      for (const e of diag.edges || []) if (!dIds.has(e.from) || !dIds.has(e.to)) errs.push(`диаграмма: ребро ${e.from} → ${e.to} ссылается на несуществующий узел`);
    }

    const steps = Array.isArray(pack.steps) ? pack.steps : [];
    if (!steps.length) errs.push('нет шагов (steps пуст)');
    const stepIds = new Set();
    for (const st of steps) {
      const at = `шаг ${st.id}`;
      if (!str(st.id)) errs.push('шаг без id');
      else if (stepIds.has(st.id)) errs.push(`${at}: дубль id`);
      stepIds.add(st.id);
      for (const f of ['title', 'brief', 'hint']) if (!str(st[f])) errs.push(`${at}: пустое поле ${f}`);
      for (const f of st.focus || []) if (!dIds.has(f)) errs.push(`${at}: focus → несуществующий компонент ${f}`);
      for (const k of Object.keys(st.state || {})) {
        if (!dIds.has(k)) errs.push(`${at}: state → несуществующий компонент ${k}`);
        if (!COLORS.includes(st.state[k])) errs.push(`${at}: state.${k}: цвет ${st.state[k]} не из ${COLORS.join('/')}`);
      }
      const priv = st.private || {};
      for (const r of ROLE_IDS) {
        if (!priv[r]) { errs.push(`${at}: нет приватного блока роли ${r}`); continue; }
        if (!str(priv[r].data)) errs.push(`${at}: ${r}: пустое data`);
        if (!str(priv[r].deliver)) errs.push(`${at}: ${r}: пустое deliver`);
      }
      for (const r of Object.keys(priv)) if (!ROLE_IDS.includes(r)) errs.push(`${at}: приватка неизвестной роли ${r}`);

      const opts = Array.isArray(st.options) ? st.options : [];
      if (opts.length < 2 || opts.length > 4) { errs.push(`${at}: должно быть 2–4 варианта`); continue; }
      const oIds = new Set();
      let numeric = true;
      for (const o of opts) {
        const oat = `${at}: вариант ${o.id}`;
        if (!str(o.id) || oIds.has(o.id)) errs.push(`${at}: пустой или повторный id варианта`);
        oIds.add(o.id);
        for (const f of ['label', 'revealText', 'debrief']) if (!str(o[f])) errs.push(`${oat}: пустое поле ${f}`);
        const fx = o.effects || {};
        if (!num(o.score) || !num(fx.tension) || !num(fx.money) || !num(fx.ttrMin)) {
          numeric = false;
          errs.push(`${oat}: score и effects.tension/money/ttrMin должны быть числами`);
        }
        if (/^ловушк/i.test(o.debrief || '') && o.trap !== true) errs.push(`${oat}: debrief начинается с «Ловушка», а trap не true`);
      }
      if (numeric) {
        const top = bestScore(st);
        const tops = opts.filter(o => o.score === top);
        if (tops.length !== 1 || tops[0].trap) errs.push(`${at}: нужен ровно один лучший вариант (максимум очков, не ловушка)`);
      }
    }

    const dis = Array.isArray(pack.distractions) ? pack.distractions : [];
    if (!dis.length) errs.push('distractions: нужен хотя бы один вброс (звонок руководства обязателен)');
    const disIds = new Set();
    for (const d of dis) {
      const at = `вброс ${d.id}`;
      if (!str(d.id) || disIds.has(d.id)) errs.push('вброс: пустой или повторный id');
      disIds.add(d.id);
      if (!KINDS.includes(d.kind)) errs.push(`${at}: kind ${d.kind} не из ${KINDS.join('/')}`);
      for (const f of ['from', 'text', 'win']) if (!str(d[f])) errs.push(`${at}: пустое поле ${f}`);
      if (ROLE_KINDS.includes(d.kind) && !ROLE_IDS.includes(d.role)) errs.push(`${at}: role ${d.role} — нужна одна из ${ROLE_IDS.join(', ')}`);
      if (d.kind === 'outage' && d.role === 'commander') errs.push(`${at}: у Координатора нет данных систем — отказ инструмента ему не адресуют`);
    }
    if (dis.length && dis.filter(d => d.kind === 'call').length !== 1) errs.push('distractions: нужен ровно один звонок руководства (kind: call)');

    const end = pack.end || {};
    if (!str(end.rootCause)) errs.push('end.rootCause пуст');
    if (!Array.isArray(end.debriefQuestions) || !end.debriefQuestions.length || !end.debriefQuestions.every(str)) errs.push('end.debriefQuestions: нужен непустой список вопросов');
    const grades = Array.isArray(end.grades) ? end.grades : [];
    if (!grades.length || !grades.every(g => num(g.min) && str(g.label) && str(g.text))) errs.push('end.grades: у каждой оценки нужны числовой min, label и text');
    else if (!errs.length) {
      const lo = Math.min.apply(null, grades.map(g => g.min)), hi = Math.max.apply(null, grades.map(g => g.min));
      if (lo > minScore(pack)) errs.push(`end.grades: нижний порог ${lo} выше минимально возможного счёта ${minScore(pack)} — дыра внизу шкалы`);
      if (hi > maxScore(pack)) errs.push(`end.grades: порог ${hi} недостижим (максимум ${maxScore(pack)})`);
    }
    return errs;
  }

  /* ---------- Сессия ---------- */

  function createSession(pack, opts) {
    opts = opts || {};
    const seats = {};
    for (const r of ROLE_IDS) seats[r] = (opts.seats && opts.seats[r]) || null;
    return {
      scenarioId: pack.meta.id,
      team: opts.team || 'Команда зала',
      phase: 'lobby',
      stepIndex: 0,
      votes: {},
      revealed: null,
      score: 0,
      metrics: { tension: START_TENSION, money: 0, ttrMin: 0 },
      journal: [],
      seats,
      audience: {},   // голоса зала на текущем шаге: {токен устройства: вариант}; на решение не влияют
      notes: {},      // заметки ведущего по шагам: {stepId: текст} — для разбора и правки кейса после прогона
      interrupt: null,  // активный вброс: { id, stepId, at, takenBy, dismissed }
      interrupts: [],   // закрытые вбросы: { id, kind, stepId, sec, takenBy, outcome }
      sound: !!opts.sound,
      phaseAt: null, stepAt: null, startedAt: null, endedAt: null,
      history: [],
    };
  }

  // Снимок для отката: всё, кроме истории, мест и настроек (освобождённая роль не должна «вернуться» по undo).
  function snapshot(state) {
    const s = JSON.parse(JSON.stringify(state));
    delete s.history; delete s.seats; delete s.sound; delete s.audience; delete s.notes; // голоса зала — сотни токенов, в снимках не нужны
    return s;
  }
  function withHistory(state, next) {
    next.history = state.history.concat([snapshot(state)]).slice(-HISTORY_MAX);
    return next;
  }
  const clone = s => JSON.parse(JSON.stringify(s));
  const currentStep = (pack, state) => pack.steps[state.stepIndex];
  // Партии и снимки истории до вбросов этих полей не знают.
  const activeOf = (pack, state) => state.interrupt ? pack.distractions.find(d => d.id === state.interrupt.id) || null : null;
  // Почему роль сейчас не голосует: «Go» теряет только Координатор — на звонке или выбыв.
  // Коммуникации на звонке — их работа, голос у них остаётся.
  function voteBlocked(pack, state, role) {
    const d = activeOf(pack, state);
    if (role !== 'commander' || !d) return null;
    if (d.kind === 'call' && state.interrupt.takenBy === 'commander') return 'Вы на звонке — «Go» недоступен';
    if (d.kind === 'handover') return 'Вы выбыли — командует другая роль';
    return null;
  }
  // Роль без своих данных на шаге: отказ её инструмента или выбывший Координатор.
  function dataHidden(pack, state, role) {
    const d = activeOf(pack, state);
    return !!d && ((d.kind === 'outage' && d.role === role) || (d.kind === 'handover' && role === 'commander'));
  }
  // Кто решает ничью: Координатор, а пока он выбыл — роль, взявшая командование (до этого — ведущий).
  function tieBreaker(pack, state) {
    const d = activeOf(pack, state);
    return d && d.kind === 'handover' ? state.interrupt.takenBy : 'commander';
  }

  function tally(pack, state) {
    const step = currentStep(pack, state);
    const counts = {};
    for (const o of step.options) counts[o.id] = 0;
    for (const r of Object.keys(state.votes)) counts[state.votes[r]]++;
    const total = Object.keys(state.votes).length;
    const top = Math.max.apply(null, Object.values(counts));
    const leaders = total ? step.options.map(o => o.id).filter(id => counts[id] === top) : [];
    let winner = null, decidedBy = null;
    if (leaders.length === 1) { winner = leaders[0]; decidedBy = 'votes'; }
    // Кто называет вариант при ничьей без решающего голоса: Координатор, исполняющий обязанности
    // или никто (Координатор выбыл или на звонке без голоса) — тогда выбирает ведущий.
    let namer = null;
    if (leaders.length > 1) {
      const tb = tieBreaker(pack, state);
      if (tb && leaders.includes(state.votes[tb])) { winner = state.votes[tb]; decidedBy = tb === 'commander' ? 'commander' : 'acting'; }
      else if (tb && !state.votes[tb] && !voteBlocked(pack, state, tb)) namer = tb;
    }
    return { counts, total, leaders, tie: leaders.length > 1, winner, decidedBy, namer, allVoted: total === ROLE_IDS.length };
  }

  // Голоса зала: подсказка для разбора («зал выбрал откат, роли — флаг»), на решение команды не влияют.
  function tallyAudience(pack, state) {
    const step = currentStep(pack, state);
    const counts = {};
    for (const o of step.options) counts[o.id] = 0;
    const audience = state.audience || {};
    for (const t of Object.keys(audience)) if (counts[audience[t]] !== undefined) counts[audience[t]]++;
    const total = Object.keys(audience).length;
    const top = total ? Math.max.apply(null, Object.values(counts)) : 0;
    const leaders = total ? step.options.map(o => o.id).filter(id => counts[id] === top) : [];
    return { counts, total, leader: leaders.length === 1 ? leaders[0] : null };
  }

  /* Применяет команду. Бросает Error с понятным текстом (e.userError), состояние не трогает.
     Кто вправе подать команду (ведущий или роль), проверяет сервер. */
  function apply(pack, state, cmd, now) {
    cmd = cmd || {};
    const s = clone(state);
    const step = currentStep(pack, s);
    switch (cmd.type) {
      case 'claim': {
        if (!ROLE_IDS.includes(cmd.role)) fail('Нет такой роли');
        if (!str(cmd.token)) fail('Нет токена устройства');
        if (s.seats[cmd.role] && s.seats[cmd.role] !== cmd.token) fail('Роль уже занята');
        // Одно устройство — одна роль: прежнее место этого телефона освобождается.
        for (const r of ROLE_IDS) if (s.seats[r] === cmd.token) s.seats[r] = null;
        s.seats[cmd.role] = cmd.token;
        return s;
      }
      case 'release': {
        if (!ROLE_IDS.includes(cmd.role)) fail('Нет такой роли');
        s.seats[cmd.role] = null;
        return s;
      }
      case 'shuffle': {
        // Жребий: перестановку присылает сервер (случайность вне движка). perm[i] — чья роль достаётся роли ROLE_IDS[i].
        if (s.phase !== 'lobby') fail('Перетасовать роли можно только в лобби');
        const perm = cmd.perm;
        if (!Array.isArray(perm) || perm.length !== ROLE_IDS.length || ROLE_IDS.some(r => !perm.includes(r))) fail('Неверная перестановка ролей');
        const old = s.seats;
        s.seats = {};
        ROLE_IDS.forEach((r, i) => { s.seats[r] = old[perm[i]]; });
        return s;
      }
      case 'sound': {
        s.sound = !!cmd.on;
        return s;
      }
      case 'note': {
        // Заметка ведущего к шагу (пустая — удалить). Откатом не отменяется, как и места ролей.
        if (!pack.steps.some(x => x.id === cmd.stepId)) fail('Нет такого шага');
        const text = String(cmd.text || '').trim().slice(0, 1000);
        s.notes = Object.assign({}, s.notes);
        if (text) s.notes[cmd.stepId] = text; else delete s.notes[cmd.stepId];
        return s;
      }
      case 'team': {
        if (!str(cmd.team)) fail('Пустое название команды');
        s.team = cmd.team.trim().slice(0, 40);
        return s;
      }
      case 'start': {
        if (s.phase !== 'lobby') fail('Игра уже идёт');
        Object.assign(s, { phase: 'situation', stepIndex: 0, startedAt: now, stepAt: now, phaseAt: now });
        return withHistory(state, s);
      }
      case 'discussion': {
        if (s.phase !== 'situation') fail('Обсуждение открывается после ситуации');
        Object.assign(s, { phase: 'discussion', phaseAt: now });
        return withHistory(state, s);
      }
      case 'voting': {
        if (s.phase !== 'situation' && s.phase !== 'discussion') fail('Голосование открывается после ситуации или обсуждения');
        Object.assign(s, { phase: 'voting', phaseAt: now, votes: {}, audience: {} });
        return withHistory(state, s);
      }
      case 'revote': {
        if (s.phase !== 'voting') fail('Повторное голосование — только во время голосования');
        Object.assign(s, { votes: {}, audience: {}, phaseAt: now });
        return withHistory(state, s);
      }
      case 'vote': {
        if (s.phase !== 'voting') fail('Голосование закрыто');
        if (!ROLE_IDS.includes(cmd.role)) fail('Нет такой роли');
        if (!step.options.some(o => o.id === cmd.option)) fail('Нет такого варианта');
        if (s.votes[cmd.role]) fail('Голос уже учтён');
        // Координатор на звонке «Go» не даёт; голос, поданный до звонка, остаётся.
        const why = voteBlocked(pack, s, cmd.role);
        if (why) fail(why);
        s.votes[cmd.role] = cmd.option;
        return s;
      }
      case 'audienceVote': {
        if (s.phase !== 'voting') fail('Голосование закрыто');
        if (!str(cmd.token) || cmd.token.length > 64) fail('Нет токена устройства');
        if (Object.values(s.seats).includes(cmd.token)) fail('У вас роль — голосуйте как роль');
        if (!step.options.some(o => o.id === cmd.option)) fail('Нет такого варианта');
        s.audience = s.audience || {};
        if (s.audience[cmd.token]) fail('Голос уже учтён');
        if (Object.keys(s.audience).length >= AUDIENCE_MAX) fail('Голосов зала слишком много');
        s.audience[cmd.token] = cmd.option;
        return s;
      }
      case 'reveal': {
        if (s.phase !== 'voting') fail('Раскрыть можно только после голосования');
        const t = tally(pack, s);
        let optionId = cmd.option, decidedBy = 'gm';
        if (optionId === undefined || optionId === null) {
          if (!t.total) fail('Нет голосов — выберите вариант вручную');
          if (!t.winner) fail(t.namer ? `Ничья — ${pack.roles[t.namer].name}${t.namer === 'commander' ? '' : ' (командует)'} называет вариант, выберите его` : 'Ничья — решающего голоса нет, выберите вариант сами');
          optionId = t.winner; decidedBy = t.decidedBy;
        }
        const o = step.options.find(x => x.id === optionId);
        if (!o) fail('Нет такого варианта');
        const fx = o.effects;
        s.score += o.score;
        s.metrics = {
          tension: clamp(s.metrics.tension + fx.tension, 0, 100),
          money: Math.max(0, s.metrics.money + fx.money),
          ttrMin: Math.max(0, s.metrics.ttrMin + fx.ttrMin),
        };
        const aud = tallyAudience(pack, s);
        s.journal.push({
          stepId: step.id, optionId, decidedBy, votes: Object.assign({}, s.votes),
          audience: { counts: aud.counts, total: aud.total, leader: aud.leader },
          sec: Math.max(0, Math.round((now - s.stepAt) / 1000)), gained: o.score, trap: !!o.trap,
        });
        Object.assign(s, { phase: 'revealed', revealed: optionId, phaseAt: now });
        return withHistory(state, s);
      }
      case 'interrupt': {
        if (!['situation', 'discussion', 'voting', 'revealed'].includes(s.phase)) fail('Вброс — только во время шага');
        if (s.interrupt) fail('Сначала закройте текущий вброс');
        const d = (pack.distractions || []).find(x => x.id === cmd.id);
        if (!d) fail('Нет такого вброса');
        if ((s.interrupts || []).some(x => x.id === d.id)) fail('Этот вброс уже был');
        s.interrupt = { id: d.id, stepId: step.id, at: now, takenBy: null, dismissed: false };
        return withHistory(state, s);
      }
      case 'takeCall': {
        const d = activeOf(pack, s);
        if (!d || d.kind !== 'call') fail('Сейчас никто не звонит');
        if (!CALL_TAKERS.includes(cmd.role)) fail('Звонок берут Координатор или Коммуникации');
        if (s.interrupt.takenBy) fail('Трубку уже взяли');
        s.interrupt.takenBy = cmd.role;
        return s;
      }
      case 'takeCommand': {
        const d = activeOf(pack, s);
        if (!d || d.kind !== 'handover') fail('Координатор на месте');
        if (!ROLE_IDS.includes(cmd.role) || cmd.role === 'commander') fail('Командование берёт одна из остальных ролей');
        if (s.interrupt.takenBy) fail('Командование уже взяли');
        s.interrupt.takenBy = cmd.role;
        return s;
      }
      case 'dismiss': {
        const d = activeOf(pack, s);
        if (!d || d.kind !== 'ping' || d.role !== cmd.role) fail('Вам сейчас никто не пишет');
        s.interrupt.dismissed = true;
        return s;
      }
      case 'resolve': {
        const d = activeOf(pack, s);
        if (!d) fail('Вброса нет');
        const fx = INTERRUPT_FX[cmd.outcome];
        if (!fx) fail('Исход вброса: held | lost');
        s.metrics = Object.assign({}, s.metrics, {
          tension: clamp(s.metrics.tension + fx.tension, 0, 100),
          ttrMin: Math.max(0, s.metrics.ttrMin + fx.ttrMin),
        });
        s.interrupts = (s.interrupts || []).concat([{ id: d.id, kind: d.kind, stepId: s.interrupt.stepId,
          sec: Math.max(0, Math.round((now - s.interrupt.at) / 1000)), takenBy: s.interrupt.takenBy, outcome: cmd.outcome }]);
        s.interrupt = null;
        return withHistory(state, s);
      }
      case 'next': {
        if (s.phase !== 'revealed') fail('Дальше — после раскрытия');
        if (s.interrupt) fail('Сначала закройте вброс');
        if (s.stepIndex + 1 >= pack.steps.length) Object.assign(s, { phase: 'end', endedAt: now, phaseAt: now });
        else Object.assign(s, { phase: 'situation', stepIndex: s.stepIndex + 1, votes: {}, audience: {}, revealed: null, stepAt: now, phaseAt: now });
        return withHistory(state, s);
      }
      case 'finish': {
        if (s.phase === 'lobby' || s.phase === 'end') fail('Игра не идёт');
        if (s.interrupt) fail('Сначала закройте вброс');
        Object.assign(s, { phase: 'end', endedAt: now, phaseAt: now });
        return withHistory(state, s);
      }
      case 'undo': {
        if (!s.history.length) fail('Откатывать нечего');
        const prev = s.history[s.history.length - 1];
        // Голоса зала текущего шага переживают откат внутри шага (например, отмену раскрытия).
        return Object.assign({ interrupt: null, interrupts: [] }, clone(prev), { seats: s.seats, sound: s.sound, audience: prev.stepIndex === s.stepIndex ? s.audience || {} : {}, notes: s.notes || {}, history: s.history.slice(0, -1) });
      }
      default:
        fail('Неизвестная команда');
    }
  }

  /* ---------- Итоги ---------- */

  function summary(pack, state) {
    const steps = state.journal.map(j => {
      const st = pack.steps.find(x => x.id === j.stepId);
      const o = st.options.find(x => x.id === j.optionId);
      const b = bestOption(st);
      const a = j.audience && j.audience.total ? j.audience : null;
      const leader = a && a.leader && st.options.find(x => x.id === a.leader);
      return {
        stepId: st.id, title: st.title, label: o.label, bestLabel: b.label, isBest: o.id === b.id,
        verdict: verdict(st, o), gained: j.gained, trap: j.trap, sec: j.sec, decidedBy: j.decidedBy,
        votes: Object.keys(j.votes).length,
        audience: a && { total: a.total, leaderLabel: leader ? leader.label : null, agree: a.leader === o.id, leaderIsBest: a.leader === b.id },
      };
    });
    const max = maxScore(pack);
    const ints = state.interrupts || [];
    return {
      score: state.score, max, metrics: state.metrics,
      interrupts: { total: ints.length, held: ints.filter(x => x.outcome === 'held').length },
      best: steps.filter(x => x.isBest).length, traps: steps.filter(x => x.trap).length,
      audienceSplit: steps.filter(x => x.audience && x.audience.leaderLabel && !x.audience.agree).length,
      totalSec: steps.reduce((a, x) => a + x.sec, 0), steps, grade: grade(pack, state.score),
      complete: state.journal.length === pack.steps.length,
    };
  }

  const mmss = sec => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
  const rub = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';

  // Markdown-отчёт для «Скопировать итоги». Долгие шаги — первыми в разборе.
  function report(pack, state) {
    const s = summary(pack, state);
    const lines = [
      `# ${pack.meta.title} — итоги`, '',
      `Команда: ${state.team}`, `Оценка: ${s.grade.label}`,
      `Очки: ${s.score} из ${s.max} · лучших решений: ${s.best} из ${s.steps.length} · ловушки: ${s.traps}`,
      `Напряжение: ${s.metrics.tension} · потери: ${rub(s.metrics.money)} · TTR: ${s.metrics.ttrMin} мин · время игры: ${mmss(s.totalSec)}`,
      '', '## Решения по порядку', '',
    ];
    s.steps.forEach((x, i) => lines.push(`${i + 1}. **${x.title}** (${mmss(x.sec)}): ${x.label} — ${x.verdict.label.toLowerCase()}, ${signed(x.gained)}` + (x.isBest ? '' : `. Лучше: ${x.bestLabel}`)
      + (x.audience && x.audience.leaderLabel && !x.audience.agree ? `. Зал (${x.audience.total}) выбрал бы: ${x.audience.leaderLabel}` : '')));
    lines.push('', '## Дольше всего думали', '');
    s.steps.slice().sort((a, b) => b.sec - a.sec).slice(0, 3).forEach(x => lines.push(`- ${x.title} — ${mmss(x.sec)}`));
    const ints = state.interrupts || [];
    if (ints.length) {
      lines.push('', `## Вбросы: отбили ${s.interrupts.held} из ${s.interrupts.total}`, '');
      ints.forEach(x => {
        const d = pack.distractions.find(y => y.id === x.id), st = pack.steps.find(y => y.id === x.stepId);
        lines.push(`- ${interruptLabel(pack, d)} (${st ? st.title : x.stepId}, ${mmss(x.sec)}): ${x.outcome === 'held' ? 'отбили' : 'сбило'}`
          + (x.takenBy ? (x.kind === 'handover' ? ', командовал(и): ' : ', трубку взял(и): ') + pack.roles[x.takenBy].name : ''));
      });
    }
    const notes = pack.steps.filter(st => state.notes && state.notes[st.id]);
    if (notes.length) {
      lines.push('', '## Заметки ведущего', '');
      notes.forEach(st => lines.push(`- **${st.title}:** ${state.notes[st.id].replace(/\s*\n\s*/g, ' ')}`));
    }
    lines.push('', '## Причина', '', pack.end.rootCause, '', '## Вопросы для разбора', '');
    pack.end.debriefQuestions.forEach(q => lines.push(`- ${q}`));
    return lines.join('\n');
  }

  // Заголовок вброса для проектора и телефонов: «Звонок CTO», «Личка: SRE» (отправителя зал не видит).
  function interruptTitle(pack, d) {
    if (!d) return 'Вброс';
    if (d.kind === 'call') return 'Звонок ' + d.from;
    if (d.kind === 'ping') return 'Личка: ' + pack.roles[d.role].name;
    if (d.kind === 'joiner') return 'Новые люди на бридже';
    if (d.kind === 'outage') return 'Отказ: ' + d.from;
    if (d.kind === 'handover') return 'Координатор выбыл';
    return 'Алерт · ' + d.from;
  }
  // Подпись для пульта и отчёта: вбросов одного вида в паке несколько — различаем по отправителю или тексту.
  function interruptLabel(pack, d) {
    if (!d) return 'Вброс';
    if (d.kind === 'ping') return 'Личка ' + pack.roles[d.role].name + ': ' + d.from;
    if (d.kind === 'outage') return 'Отказ ' + d.from + ' → ' + pack.roles[d.role].name;
    if (d.kind === 'alert') return 'Алерт: ' + (d.text.length > 42 ? d.text.slice(0, 40) + '…' : d.text);
    if (d.kind === 'joiner') return 'На бридже: ' + d.from;
    return interruptTitle(pack, d);
  }

  /* ---------- Представления для трёх экранов ----------
     Сервер шлёт каждому клиенту только его представление: проектору — без приватки,
     голосов и флагов ловушек до раскрытия; роли — только её блок; ведущему — всё. */

  function publicReveal(step, state) {
    if (!state.revealed) return null;
    const o = step.options.find(x => x.id === state.revealed);
    const j = state.journal[state.journal.length - 1];
    return { optionId: o.id, label: o.label, revealText: o.revealText, verdict: verdict(step, o), gained: o.score, effects: o.effects, decidedBy: j && j.decidedBy,
      audience: j && j.audience && j.audience.total ? { counts: j.audience.counts, total: j.audience.total } : null };
  }

  function common(pack, state, now) {
    const step = state.phase === 'end' || state.phase === 'lobby' ? null : currentStep(pack, state);
    return {
      scenarioId: pack.meta.id, title: pack.meta.title, brief: pack.meta.brief, team: state.team,
      phase: state.phase, stepNo: state.stepIndex + 1, stepTotal: pack.steps.length,
      phaseAt: state.phaseAt, phaseSec: PHASE_SEC[state.phase] || null, now,
      seats: ROLE_IDS.map(r => ({ id: r, name: pack.roles[r].name, taken: !!state.seats[r], voted: !!state.votes[r] })),
      votedCount: Object.keys(state.votes).length,
      audienceCount: Object.keys(state.audience || {}).length,
      step: step && { id: step.id, title: step.title, brief: step.brief, question: step.question || 'Что делаем?', options: step.options.map(o => ({ id: o.id, label: o.label })) },
      revealed: step && publicReveal(step, state),
    };
  }

  function publicSummary(pack, state) {
    const s = summary(pack, state);
    return Object.assign(s, { rootCause: pack.end.rootCause, debriefQuestions: pack.end.debriefQuestions });
  }

  /* ---------- Узкая раскладка приватки для телефона ---------- */

  // Телефон вмещает ~39 моноширинных символов (390 px, .86rem), а строки в паках рассчитаны
  // на пульт и карточки (до ~78). Переносим длинные строки так:
  //  — «label␣␣значение» (узкий label, разделитель ≥ 2 пробела) → продолжение по колонке значения,
  //    если та не глубже 28 (глубже — колонку на телефоне не спасти, переносим как обычный текст);
  //  — иначе слово, стоявшее в исходнике после широкого пробельного захода, продолжает по своей колонке (до 24);
  //  — обычный текст — по словам с отступом исходной строки.
  // Неразрывные токены (пути, url) могут остаться шире 39: их режет word-break в CSS.
  const REFLOW_WIDTH = 39;

  function reflowLine(line, width) {
    const ind = line.match(/^\s*/)[0];
    let vcol = -1;
    for (let i = ind.length + 2; i < ind.length + 16; i++) {
      if (line[i] === ' ' && line[i + 1] === ' ') { vcol = i + 2; while (line[vcol] === ' ') vcol++; break; }
    }
    if (vcol > 28) vcol = -1;
    // Пояснение «# текст»: перенос — под текстом, а не под решёткой.
    const base = /^#\s/.test(line.trim()) ? ind.length + 2 : ind.length;
    const words = [...line.trim().matchAll(/(\s*)(\S+)/g)].map(m => ({ sp: m[1], w: m[2], srcCol: m.index + m[1].length }));
    const rows = [];
    let row = ind, rowW = ind.length;
    for (const { sp, w, srcCol } of words) {
      const need = rowW + (row === ind ? 0 : sp.length) + w.length;
      if (row !== ind && need > width) {
        rows.push(row.trimEnd());
        let hang = vcol > 0 ? vcol : (sp.length >= 2 ? Math.min(srcCol, 24) : base);
        // неразрывный токен шире строки: глубокий отступ только мешает — прижимаем к исходному
        if (hang + w.length > width) hang = ind.length;
        row = ' '.repeat(hang); rowW = hang;
        row += w; rowW += w.length;
      } else {
        const spStr = row === ind ? '' : sp;
        row += spStr + w; rowW += spStr.length + w.length;
      }
    }
    if (row.trim()) rows.push(row.trimEnd());
    return rows;
  }

  // Пояснение в паке разбито под ширину пульта (78): на телефоне его продолжение склеиваем с началом
  // и переносим заново — «#   …» после «#»-строки или строка после незакрытой скобки.
  const opens = l => (l.match(/\(/g) || []).length > (l.match(/\)/g) || []).length;
  const indentOf = l => l.match(/^\s*/)[0].length;
  function joinContinuations(lines) {
    const out = [];
    for (const line of lines) {
      const prev = out[out.length - 1];
      // продолжение: «#   …» на том же отступе, что «# …»; после незакрытой скобки — строка глубже по отступу
      const hashCont = prev !== undefined && /^\s*#\s/.test(prev) && /^\s*#\s{2,}\S/.test(line) && indentOf(line) === indentOf(prev);
      const parenCont = prev !== undefined && opens(prev) && /^\s+[^\s#(│├└┌─]/.test(line) && indentOf(line) > indentOf(prev); // рамки трейсов не трогаем
      if (hashCont || parenCont) out[out.length - 1] = prev.trimEnd() + ' ' + line.trim().replace(/^#\s+/, '');
      else out.push(line);
    }
    return out;
  }

  function reflowData(data) {
    return joinContinuations(data.split('\n')).flatMap(line => line.length <= REFLOW_WIDTH ? [line] : reflowLine(line, REFLOW_WIDTH)).join('\n');
  }

  // Проектору — только явный список полей: текст лички остаётся у адресата, критерий исхода — у ведущего.
  function screenInterrupt(pack, state) {
    const d = activeOf(pack, state);
    if (!d) return null;
    const i = state.interrupt;
    return { kind: d.kind, title: interruptTitle(pack, d), from: d.kind === 'ping' ? null : d.from, text: d.kind === 'ping' ? null : d.text,
      roleName: d.role ? pack.roles[d.role].name : null,
      at: i.at, takenByName: i.takenBy ? pack.roles[i.takenBy].name : null, dismissed: !!i.dismissed };
  }
  // Телефону — только участникам: звонок видят Координатор и Коммуникации, личку — адресат.
  function playInterrupt(pack, state, role) {
    const d = activeOf(pack, state);
    if (!d) return null;
    const i = state.interrupt;
    if (d.kind === 'call' && CALL_TAKERS.includes(role)) return { kind: 'call', title: interruptTitle(pack, d), from: d.from, text: d.text, at: i.at, takenBy: i.takenBy, takenByName: i.takenBy ? pack.roles[i.takenBy].name : null };
    if (d.kind === 'ping' && d.role === role) return { kind: 'ping', title: interruptTitle(pack, d), from: d.from, text: d.text, at: i.at, dismissed: !!i.dismissed };
    if (d.kind === 'outage' && d.role === role) return { kind: 'outage', title: interruptTitle(pack, d), from: d.from, text: d.text, at: i.at };
    // Выбывший Координатор видит, что он вне игры; остальные — кнопку «Беру командование».
    if (d.kind === 'handover') return { kind: 'handover', title: interruptTitle(pack, d), text: d.text, at: i.at, out: role === 'commander',
      takenBy: i.takenBy, takenByName: i.takenBy ? pack.roles[i.takenBy].name : null };
    return null;
  }

  function view(pack, state, audience, opts) {
    opts = opts || {};
    const now = opts.now || 0;
    const v = common(pack, state, now);
    const step = v.step && currentStep(pack, state);
    if (audience === 'screen') {
      return Object.assign(v, {
        view: 'screen', diagram: pack.diagram, score: state.score, maxScore: maxScore(pack), metrics: state.metrics,
        moneyLimit: pack.meta.moneyLimit, focus: step ? step.focus || [] : [], diagramState: step ? step.state || {} : {},
        sound: !!state.sound,
        interrupt: screenInterrupt(pack, state),
        summary: state.phase === 'end' ? publicSummary(pack, state) : null,
      });
    }
    if (audience === 'play') {
      // Роль определяется по токену устройства: после жребия место телефона могло смениться.
      const role = opts.token ? ROLE_IDS.find(r => state.seats[r] === opts.token) || null : null;
      const r = role && pack.roles[role];
      return Object.assign(v, {
        view: 'play',
        role: role && { id: role, name: r.name, mission: r.mission, welcomePrivate: r.welcomePrivate },
        // Отказ инструмента: данных шага у роли нет — только то, что скажут другие.
        private: role && step ? (dataHidden(pack, state, role) ? { hidden: true } : Object.assign({}, step.private[role], { data: reflowData(step.private[role].data) })) : null,
        interrupt: role ? playInterrupt(pack, state, role) : null,
        voteBlocked: role ? voteBlocked(pack, state, role) : null,
        myVote: role ? state.votes[role] || null : null,
        // Зритель без роли тоже голосует — как подсказка для разбора.
        audienceVote: !role && opts.token ? (state.audience || {})[opts.token] || null : null,
        score: state.score, maxScore: maxScore(pack),
        summary: state.phase === 'end' ? { grade: grade(pack, state.score), score: state.score, max: maxScore(pack) } : null,
      });
    }
    if (audience === 'gm') {
      const full = step && {
        id: step.id, title: step.title, brief: step.brief, question: step.question || 'Что делаем?', hint: step.hint,
        private: step.private,
        options: step.options.map(o => Object.assign({}, o, { verdict: verdict(step, o), best: o === bestOption(step) })),
      };
      return Object.assign(v, {
        view: 'gm', step: full, roles: pack.roles, diagram: pack.diagram,
        focus: step ? step.focus || [] : [], diagramState: step ? step.state || {} : {},
        votes: state.votes, tally: step ? tally(pack, state) : null, audience: step ? tallyAudience(pack, state) : null,
        sound: !!state.sound,
        distractions: (pack.distractions || []).map(d => Object.assign({}, d, { title: interruptTitle(pack, d), label: interruptLabel(pack, d), used: (state.interrupts || []).some(x => x.id === d.id) })),
        interrupt: state.interrupt ? Object.assign({}, state.interrupt, { title: interruptLabel(pack, activeOf(pack, state)), kind: activeOf(pack, state).kind }) : null,
        interrupts: state.interrupts || [],
        score: state.score, maxScore: maxScore(pack), metrics: state.metrics, moneyLimit: pack.meta.moneyLimit,
        canUndo: state.history.length > 0, journal: state.journal, notes: state.notes || {},
        stepTitles: pack.steps.map(x => ({ id: x.id, title: x.title })),
        upcoming: pack.steps.slice(state.stepIndex + 1).map(x => x.title),
        summary: state.journal.length ? publicSummary(pack, state) : null,
        report: state.phase === 'end' ? report(pack, state) : null,
      });
    }
    throw new Error('неизвестная аудитория ' + audience);
  }

  return {
    ROLE_IDS, PHASE_SEC, START_TENSION, KINDS, INTERRUPT_FX,
    validate, maxScore, minScore, bestOption, verdict, grade,
    createSession, apply, tally, tallyAudience, summary, report, view, reflowData,
  };
});
