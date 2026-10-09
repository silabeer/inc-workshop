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
      phaseAt: null, stepAt: null, startedAt: null, endedAt: null,
      history: [],
    };
  }

  // Снимок для отката: всё, кроме истории и мест (освобождённая роль не должна «вернуться» по undo).
  function snapshot(state) {
    const s = JSON.parse(JSON.stringify(state));
    delete s.history; delete s.seats;
    return s;
  }
  function withHistory(state, next) {
    next.history = state.history.concat([snapshot(state)]).slice(-HISTORY_MAX);
    return next;
  }
  const clone = s => JSON.parse(JSON.stringify(s));
  const currentStep = (pack, state) => pack.steps[state.stepIndex];

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
    else if (leaders.length > 1 && leaders.includes(state.votes.commander)) { winner = state.votes.commander; decidedBy = 'commander'; }
    return { counts, total, leaders, tie: leaders.length > 1, winner, decidedBy, allVoted: total === ROLE_IDS.length };
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
        s.seats[cmd.role] = cmd.token;
        return s;
      }
      case 'release': {
        if (!ROLE_IDS.includes(cmd.role)) fail('Нет такой роли');
        s.seats[cmd.role] = null;
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
        Object.assign(s, { phase: 'voting', phaseAt: now, votes: {} });
        return withHistory(state, s);
      }
      case 'revote': {
        if (s.phase !== 'voting') fail('Повторное голосование — только во время голосования');
        Object.assign(s, { votes: {}, phaseAt: now });
        return withHistory(state, s);
      }
      case 'vote': {
        if (s.phase !== 'voting') fail('Голосование закрыто');
        if (!ROLE_IDS.includes(cmd.role)) fail('Нет такой роли');
        if (!step.options.some(o => o.id === cmd.option)) fail('Нет такого варианта');
        if (s.votes[cmd.role]) fail('Голос уже учтён');
        s.votes[cmd.role] = cmd.option;
        return s;
      }
      case 'reveal': {
        if (s.phase !== 'voting') fail('Раскрыть можно только после голосования');
        const t = tally(pack, s);
        let optionId = cmd.option, decidedBy = 'gm';
        if (optionId === undefined || optionId === null) {
          if (!t.total) fail('Нет голосов — выберите вариант вручную');
          if (!t.winner) fail('Ничья — Командир называет вариант, выберите его');
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
        s.journal.push({
          stepId: step.id, optionId, decidedBy, votes: Object.assign({}, s.votes),
          sec: Math.max(0, Math.round((now - s.stepAt) / 1000)), gained: o.score, trap: !!o.trap,
        });
        Object.assign(s, { phase: 'revealed', revealed: optionId, phaseAt: now });
        return withHistory(state, s);
      }
      case 'next': {
        if (s.phase !== 'revealed') fail('Дальше — после раскрытия');
        if (s.stepIndex + 1 >= pack.steps.length) Object.assign(s, { phase: 'end', endedAt: now, phaseAt: now });
        else Object.assign(s, { phase: 'situation', stepIndex: s.stepIndex + 1, votes: {}, revealed: null, stepAt: now, phaseAt: now });
        return withHistory(state, s);
      }
      case 'finish': {
        if (s.phase === 'lobby' || s.phase === 'end') fail('Игра не идёт');
        Object.assign(s, { phase: 'end', endedAt: now, phaseAt: now });
        return withHistory(state, s);
      }
      case 'undo': {
        if (!s.history.length) fail('Откатывать нечего');
        const prev = s.history[s.history.length - 1];
        return Object.assign(clone(prev), { seats: s.seats, history: s.history.slice(0, -1) });
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
      return {
        stepId: st.id, title: st.title, label: o.label, bestLabel: b.label, isBest: o.id === b.id,
        verdict: verdict(st, o), gained: j.gained, trap: j.trap, sec: j.sec, decidedBy: j.decidedBy,
        votes: Object.keys(j.votes).length,
      };
    });
    const max = maxScore(pack);
    return {
      score: state.score, max, metrics: state.metrics,
      best: steps.filter(x => x.isBest).length, traps: steps.filter(x => x.trap).length,
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
    s.steps.forEach((x, i) => lines.push(`${i + 1}. **${x.title}** (${mmss(x.sec)}): ${x.label} — ${x.verdict.label.toLowerCase()}, ${signed(x.gained)}` + (x.isBest ? '' : `. Лучше: ${x.bestLabel}`)));
    lines.push('', '## Дольше всего думали', '');
    s.steps.slice().sort((a, b) => b.sec - a.sec).slice(0, 3).forEach(x => lines.push(`- ${x.title} — ${mmss(x.sec)}`));
    lines.push('', '## Причина', '', pack.end.rootCause, '', '## Вопросы для разбора', '');
    pack.end.debriefQuestions.forEach(q => lines.push(`- ${q}`));
    return lines.join('\n');
  }

  /* ---------- Представления для трёх экранов ----------
     Сервер шлёт каждому клиенту только его представление: проектору — без приватки,
     голосов и флагов ловушек до раскрытия; роли — только её блок; ведущему — всё. */

  function publicReveal(step, state) {
    if (!state.revealed) return null;
    const o = step.options.find(x => x.id === state.revealed);
    const j = state.journal[state.journal.length - 1];
    return { optionId: o.id, label: o.label, revealText: o.revealText, verdict: verdict(step, o), gained: o.score, effects: o.effects, decidedBy: j && j.decidedBy };
  }

  function common(pack, state, now) {
    const step = state.phase === 'end' || state.phase === 'lobby' ? null : currentStep(pack, state);
    return {
      scenarioId: pack.meta.id, title: pack.meta.title, brief: pack.meta.brief, team: state.team,
      phase: state.phase, stepNo: state.stepIndex + 1, stepTotal: pack.steps.length,
      phaseAt: state.phaseAt, phaseSec: PHASE_SEC[state.phase] || null, now,
      seats: ROLE_IDS.map(r => ({ id: r, name: pack.roles[r].name, taken: !!state.seats[r], voted: !!state.votes[r] })),
      votedCount: Object.keys(state.votes).length,
      step: step && { id: step.id, title: step.title, brief: step.brief, question: step.question || 'Что делаем?', options: step.options.map(o => ({ id: o.id, label: o.label })) },
      revealed: step && publicReveal(step, state),
    };
  }

  function publicSummary(pack, state) {
    const s = summary(pack, state);
    return Object.assign(s, { rootCause: pack.end.rootCause, debriefQuestions: pack.end.debriefQuestions });
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
        summary: state.phase === 'end' ? publicSummary(pack, state) : null,
      });
    }
    if (audience === 'play') {
      const role = opts.role && ROLE_IDS.includes(opts.role) && opts.token && state.seats[opts.role] === opts.token ? opts.role : null;
      const r = role && pack.roles[role];
      return Object.assign(v, {
        view: 'play',
        role: role && { id: role, name: r.name, mission: r.mission, welcomePrivate: r.welcomePrivate },
        private: role && step ? step.private[role] : null,
        myVote: role ? state.votes[role] || null : null,
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
        votes: state.votes, tally: step ? tally(pack, state) : null,
        score: state.score, maxScore: maxScore(pack), metrics: state.metrics, moneyLimit: pack.meta.moneyLimit,
        canUndo: state.history.length > 0, journal: state.journal,
        upcoming: pack.steps.slice(state.stepIndex + 1).map(x => x.title),
        summary: state.journal.length ? publicSummary(pack, state) : null,
        report: state.phase === 'end' ? report(pack, state) : null,
      });
    }
    throw new Error('неизвестная аудитория ' + audience);
  }

  return {
    ROLE_IDS, PHASE_SEC, START_TENSION,
    validate, maxScore, minScore, bestOption, verdict, grade,
    createSession, apply, tally, summary, report, view,
  };
});
