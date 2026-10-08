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

  return { validate, createGame, choose };
});
