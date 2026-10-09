/* Движок воркшопа: чистые функции экономики и автопилота.
   Universal-модуль: в браузере — глобал ENGINE, в Node — module.exports. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ENGINE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function gameSec(g, now) {
    if (now === undefined) now = Date.now();
    if (!g || !g.startedAt) return 0;
    if (g.status === 'PAUSED' && g.pausedAt) return Math.max(0, (g.pausedAt - g.startedAt - (g.pausedTotal || 0)) / 1000);
    if (g.status === 'RESOLVED' || g.status === 'FAILED') return g.endedSec || 0;
    return Math.max(0, (now - g.startedAt - (g.pausedTotal || 0)) / 1000);
  }

  function burned(g, now) {
    if (now === undefined) now = Date.now();
    if (!g || !g.rateSegments || !g.rateSegments.length) return 0;
    const T = gameSec(g, now); let sum = 0; const s = g.rateSegments;
    for (let i = 0; i < s.length; i++) {
      const a = s[i].t, b = (i + 1 < s.length) ? s[i + 1].t : T;
      if (b > a) sum += (Math.min(b, T) - a) / 60 * s[i].rate;
    }
    return Math.max(0, Math.round(sum));
  }

  function tierOf(panic, tiers) {
    return tiers.find(t => panic >= t.min && panic <= t.max) || tiers[tiers.length - 1];
  }

  function currentRate(g, pack, now) {
    if (now === undefined) now = Date.now();
    if (!g || g.status === 'RESOLVED' || g.status === 'FAILED' || g.status === 'LOBBY') return 0;
    const mult = pack.telemetry(g).mult * tierOf(g.panic || 0, pack.panic.tiers).mult;
    let r = pack.money.basePerMin * mult;
    if (g.storm) r *= 1.2;
    return Math.round(r);
  }

  /* Эффект ивента мира (закрытый набор fx): патч в game и дельта паники.
     Один источник правды для автопилота и ручного броска на пульте. */
  function eventPatch(e, now) {
    if (!e) return {patch: {}, panic: 0};
    if (e.fx === 'storm') return {patch: {storm: true}, panic: 0};
    if (e.fx === 'panic1') return {patch: {}, panic: 1};
    if (e.fx === 'scout-x2') return {patch: {scoutX2: true}, panic: 0};
    if (e.fx === 'transient') return {patch: {transientUntil: now + (e.transientSec || 30) * 1000}, panic: 0};
    return {patch: {}, panic: 0};
  }

  /* Планировщик автопилота: по состоянию и пакету решает, что должно
     произойти к игровому моменту T. Возвращает null или один слитый
     результат: patch (мердж в game), events (в ленту), props (дозаписи
     proposals). Идемпотентен: срабатывания помечаются в game.fired. */
  function planAutopilot(state, pack, now, rng) {
    if (now === undefined) now = Date.now();
    if (rng === undefined) rng = Math.random;
    const game = state.game;
    if (!game || game.status !== 'ACTIVE') return null;
    const T = gameSec(game, now);
    const fired = Object.assign({}, game.fired || {});
    const patch = {fired};
    const events = [];
    const props = [];
    let dirty = false;
    let panicDelta = 0;
    const panicLogAdd = [];
    const addPanic = (d, why) => { panicDelta += d; panicLogAdd.push({t: Math.round(T), d, why}); };
    const fail = (why) => {
      patch.status = 'FAILED'; patch.endedSec = Math.round(T);
      if (game.call && game.call.active) patch.call = Object.assign({}, game.call, {active: false});
      events.push({msg: 'FAILED: ' + why, sev: 'danger'});
      return {patch, events, props};
    };

    // Концы игры
    if (T >= pack.durationSec && !fired.win) return fail('время вышло');
    if ((game.panic || 0) >= pack.panic.meltdownAt) {
      if (fired.meltStart == null) { fired.meltStart = T; dirty = true; }
      else if (T - fired.meltStart >= pack.panic.meltdownHoldSec) return fail('паника ' + pack.panic.meltdownAt + ' держится ' + pack.panic.meltdownHoldSec + ' секунд');
    } else if (fired.meltStart != null) { fired.meltStart = null; dirty = true; }
    if (burned(game, now) >= pack.money.failAt) return fail('сожжено ' + pack.money.failAt + ' ₽');

    // Окно победы (индикатор; Resolved жмёт GM)
    const winErr = pack.winErrPct == null ? 5 : pack.winErrPct;
    if (pack.telemetry(game).err <= winErr) {
      if (fired.winSince == null) { fired.winSince = T; dirty = true; }
      else if (!fired.win && T - fired.winSince >= pack.winHoldSec) {
        fired.win = 1; dirty = true;
        events.push({msg: 'Условия победы выполнены: success ≥ 95% держится ' + pack.winHoldSec + ' с', sev: 'success'});
      }
    } else if (fired.winSince != null) { fired.winSince = null; fired.win = 0; dirty = true; }

    // Авто-паника и тишина
    const lastAuto = game.lastAutoPanic || 0;
    if (T - lastAuto >= pack.panic.autoEverySec) {
      patch.lastAutoPanic = lastAuto + pack.panic.autoEverySec;
      addPanic(1, 'прошло ' + pack.panic.autoEverySec + ' секунд');
      dirty = true;
    }
    const lastStatus = game.lastStatusAt != null ? game.lastStatusAt : 0;
    if (T - lastStatus > pack.panic.silenceAfterSec && (game.silenceFlagAt || 0) <= lastStatus) {
      patch.silenceFlagAt = T;
      addPanic(1, 'нет статус-апдейта больше ' + pack.panic.silenceAfterSec + ' секунд');
      dirty = true;
    }

    // Звонок CIO
    const cc = pack.schedule && pack.schedule.cioCall;
    if (cc) {
      if (game.call && game.call.active) {
        if (!fired.call) { fired.call = 1; dirty = true; } // ручной звонок сжигает слот авто-старта
        const el = T - game.call.startedAt;
        const next = Object.assign({}, game.call);
        if (el >= cc.durationSec) {
          next.active = false; next.result = 'timeout';
          patch.call = next; dirty = true;
          events.push({msg: 'Звонок CIO сорван: ' + cc.durationSec + ' секунд без ответа', sev: 'danger'});
        } else {
          const ticks = Math.floor(el / cc.panicEverySec);
          if (ticks > (game.call.ticks || 0)) {
            next.ticks = ticks;
            patch.call = next; dirty = true;
            addPanic(1, 'звонок CIO без ответа');
          }
        }
      } else if (!fired.call && T >= cc.atSec) {
        fired.call = 1; dirty = true;
        patch.call = {active: true, caller: cc.caller, startedAt: Math.round(T), ticks: 0, dur: cc.durationSec};
        events.push({msg: '📞 Входящий звонок: ' + cc.caller, sev: 'danger'});
      }
    }

    // Ивенты мира
    const we = pack.schedule && pack.schedule.worldEvents;
    if (we) we.rollsAt.forEach((at, i) => {
      if (T < at || fired['ev' + i] !== undefined) return;
      const n = 1 + Math.floor(rng() * 10);
      fired['ev' + i] = n; dirty = true;
      const e = we.table[n];
      if (!e) return;
      events.push({msg: 'Ивент d10=' + n + ': ' + e.t, sev: 'warning'});
      const fx = eventPatch(e, now);
      Object.assign(patch, fx.patch);
      if (fx.panic) addPanic(fx.panic, e.t);
    });

    // Исполнение действий
    const A = new Set(game.applied || []); // общий накопитель: действия в одном тике не затирают друг друга
    let appliedDirty = false;
    for (const id of Object.keys(state.proposals || {})) {
      const p = state.proposals[id];
      if (!p || p.status !== 'go' || p.goAt == null) continue;
      const mit = (pack.mitigations || []).find(m => m.id === p.mitId);
      const doneAt = p.goAt + (mit ? mit.cost : 0) + (p.reviewedBy ? 30 : 0);
      if (T < doneAt) continue;
      const gA = Object.assign({}, game, {applied: Array.from(A)});
      const before = pack.telemetry(gA).mult;
      let eff = {add: [p.mitId]};
      if (mit && mit.apply) eff = mit.apply(new Set(A), gA, pack) || {};
      (eff.add || []).forEach(x => A.add(x));
      (eff.remove || []).forEach(x => A.delete(x));
      appliedDirty = true;
      if (eff.set) Object.assign(patch, eff.set);
      if (eff.transientSec) patch.transientUntil = now + eff.transientSec * 1000;
      let msg = eff.msg || ('Выполнено ' + p.mitId + (mit ? ': ' + mit.title : ''));
      let sev = eff.sev || 'success';
      if (mit && mit.review && !p.reviewedBy) {
        const d = 1 + Math.floor(rng() * 10);
        msg += ' · без ревью, d10=' + d;
        if (d <= 2) { msg += ' — ОШИБКА В КОНФИГЕ, соседний сервис упал'; sev = 'danger'; }
      }
      events.push({msg, sev});
      props.push({id, doc: Object.assign({}, p, {status: 'done', doneAt: Math.round(T)})});
      dirty = true;
      if (mit && mit.trap) addPanic(mit.trapDelta || 2, 'ловушка ' + p.mitId);
      if (!(p.cards || []).length) addPanic(2, 'действие вслепую ' + p.mitId);
      const after = pack.telemetry(Object.assign({}, game, patch, {applied: Array.from(A)})).mult;
      if (!fired.stab && after <= pack.money.stabilizeAtMult && before > pack.money.stabilizeAtMult) {
        fired.stab = 1;
        addPanic(-3, 'стабилизация сервиса');
      }
    }
    if (appliedDirty) patch.applied = Array.from(A);

    if (panicDelta) {
      patch.panic = Math.max(0, Math.min(20, (game.panic || 0) + panicDelta));
      patch.panicLog = (game.panicLog || []).concat(panicLogAdd).slice(-80);
      dirty = true;
    }
    if (!dirty) return null;
    return {patch, events, props};
  }

  return {gameSec, burned, tierOf, currentRate, eventPatch, planAutopilot};
});
