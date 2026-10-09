/* Движок холл-режима v1.1: одна команда с ролями, валидация сценариев и ходы.
   Universal-модуль: в браузере — глобал HALL_ENGINE, в Node — module.exports. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.HALL_ENGINE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function validate(scn) {
    const errs = [];
    const nodes = scn.nodes || {};
    const ids = Object.keys(nodes);
    if (!scn.start || !nodes[scn.start]) errs.push(`стартовый узел ${scn.start} не найден`);

    const roles = scn.roles || {};
    const roleIds = Object.keys(roles);
    if (roleIds.length === 0) errs.push('нет блока roles');

    for (const id of ids) {
      const n = nodes[id];
      if (n.end) continue;
      const choices = n.choices || [];
      if (choices.length < 2 || choices.length > 4) errs.push(`узел ${id}: должно быть 2–4 варианта`);
      for (const c of choices) {
        if (!nodes[c.goto]) errs.push(`узел ${id}: вариант ${c.id} → несуществующий узел ${c.goto}`);
        if (typeof c.score !== 'number' || typeof c.tension !== 'number') errs.push(`узел ${id}: вариант ${c.id}: score и tension должны быть числами`);
        if (!c.outcome || !String(c.outcome).trim()) errs.push(`узел ${id}: вариант ${c.id}: пустой outcome`);
      }
      if (!n.role) errs.push(`узел ${id}: не указана роль`);
      else if (!roles[n.role]) errs.push(`узел ${id}: неизвестная роль ${n.role}`);
      if (!n.roleTask || !String(n.roleTask).trim()) errs.push(`узел ${id}: пустой roleTask`);
    }

    const reachesEnd = (from, seen) => {
      const n = nodes[from];
      if (!n) return false;
      if (n.end) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (n.choices || []).some(c => reachesEnd(c.goto, seen));
    };
    for (const id of ids) {
      if (!reachesEnd(id, new Set())) errs.push(`из узла ${id} недостижим ни один end`);
    }

    // Граф должен быть ацикличным: иначе игра может не закончиться, а maxScore не определён.
    const color = {};
    const hasCycle = (id) => {
      if (color[id] === 1) return true;
      if (color[id] === 2 || !nodes[id] || nodes[id].end) return false;
      color[id] = 1;
      const found = (nodes[id].choices || []).some(c => hasCycle(c.goto));
      color[id] = 2;
      return found;
    };
    for (const id of ids) {
      if (hasCycle(id)) { errs.push(`в графе решений цикл через узел ${id}`); break; }
    }

    const diag = scn.diagram;
    if (!diag || !diag.nodes || diag.nodes.length === 0) {
      errs.push('нет диаграммы (diagram.nodes пуст)');
    } else {
      const dIds = new Set();
      for (const d of diag.nodes) {
        if (dIds.has(d.id)) errs.push(`диаграмма: дубль id ${d.id}`);
        dIds.add(d.id);
        if (typeof d.x !== 'number' || typeof d.y !== 'number') errs.push(`диаграмма: узел ${d.id}: координаты x/y должны быть числами`);
      }
      for (const e of (diag.edges || [])) {
        if (!dIds.has(e.from) || !dIds.has(e.to)) errs.push(`диаграмма: ребро ${e.from} → ${e.to} ссылается на несуществующий узел`);
      }
    }
    return errs;
  }

  function createGame(scn, opts) {
    opts = opts || {};
    const st = {
      scenarioId: scn.id,
      nodeId: scn.start,
      team: opts.team || 'Команда зала',
      score: 0,
      tension: 50,
      log: [],
      status: 'ACTIVE',
    };
    Object.defineProperty(st, '_scn', { value: scn, enumerable: false, writable: true });
    return st;
  }

  function choose(state, choiceId) {
    if (state.status === 'ENDED') throw new Error('игра завершена');
    const node = state._scn.nodes[state.nodeId];
    const c = (node.choices || []).find(x => x.id === choiceId);
    if (!c) throw new Error(`нет варианта ${choiceId} в узле ${state.nodeId}`);

    const tension = Math.min(100, Math.max(0, state.tension + c.tension));
    const nextNode = state._scn.nodes[c.goto];
    const ended = !!nextNode.end;

    const next = {
      scenarioId: state.scenarioId,
      nodeId: c.goto,
      team: state.team,
      score: state.score + c.score,
      tension,
      log: state.log.concat([{ nodeId: state.nodeId, choiceId, gained: c.score, tension, trap: !!c.trap }]),
      status: ended ? 'ENDED' : 'ACTIVE',
    };
    Object.defineProperty(next, '_scn', { value: state._scn, enumerable: false, writable: true });

    return {
      state: next,
      result: { choice: c, gained: c.score, tension },
    };
  }

  // Максимум очков по лучшему пути от старта (граф ацикличен — см. validate).
  function maxScore(scn) {
    const memo = {};
    const best = (id) => {
      const n = scn.nodes[id];
      if (!n || n.end) return 0;
      if (memo[id] === undefined) memo[id] = Math.max.apply(null, n.choices.map(c => c.score + best(c.goto)));
      return memo[id];
    };
    return best(scn.start);
  }

  // Сколько решений осталось до end по самому длинному пути — для счётчика «шаг N из M».
  function stepsLeft(scn, nodeId) {
    const n = scn.nodes[nodeId];
    if (!n || n.end) return 0;
    return 1 + Math.max.apply(null, n.choices.map(c => stepsLeft(scn, c.goto)));
  }

  const GRADES = [
    { min: 0.85, level: 'great', title: 'Образцовое реагирование', text: 'Команда шла от данных, обошла ловушки и закрыла инцидент по критерию.' },
    { min: 0.6, level: 'good', title: 'Уверенно, с потерями', text: 'Причину нашли, но часть времени ушла на ложные пути. Разберите шаги, где выбор был не лучшим.' },
    { min: 0.35, level: 'shaky', title: 'Тяжело, но вытянули', text: 'Инцидент закрыт ценой лишних действий и напряжения. Главный вопрос разбора — где команда действовала до улик.' },
    { min: -Infinity, level: 'bad', title: 'Инцидент управлял командой', text: 'Решения принимались под давлением, а не по данным. Пройдите кейс ещё раз после разбора.' },
  ];
  function grade(ratio) {
    return GRADES.find(g => ratio >= g.min);
  }

  // Итог для финального экрана и разбора: шаги с ролью и лучшим вариантом, метрики, оценка.
  function summary(scn, state) {
    const steps = state.log.map(l => {
      const n = scn.nodes[l.nodeId];
      const c = n.choices.find(x => x.id === l.choiceId);
      const top = Math.max.apply(null, n.choices.map(x => x.score));
      const bestC = n.choices.find(x => x.score === top);
      return {
        nodeId: l.nodeId, title: n.title, role: n.role, label: c.label, gained: l.gained,
        trap: l.trap, isBest: c.score === top, bestLabel: bestC.label,
      };
    });
    const max = maxScore(scn);
    return {
      score: state.score, max, tension: state.tension,
      traps: steps.filter(x => x.trap).length,
      best: steps.filter(x => x.isBest).length,
      steps,
      grade: grade(max > 0 ? state.score / max : 0),
    };
  }

  return { validate, createGame, choose, maxScore, stepsLeft, grade, summary };
});
