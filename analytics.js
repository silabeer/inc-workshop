/* Аналитика по архиву партий: какие ловушки срабатывают чаще, где дольше думают, совпадает ли зал с ролями.
   Чистые функции: на входе записи архива ({summary, session}) и паки, на выходе сводка по кейсам. */
'use strict';

const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, d = 0) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function aggregate(records, packs) {
  const out = [];
  for (const pack of packs) {
    const games = records.filter(r => r && r.session && r.session.scenarioId === pack.meta.id && r.session.journal && r.session.journal.length);
    if (!games.length) continue;
    const steps = pack.steps.map(st => {
      const best = st.options.find(o => o.score === Math.max.apply(null, st.options.map(x => x.score)) && !o.trap);
      const entries = games.map(g => g.session.journal.find(j => j.stepId === st.id)).filter(Boolean);
      const withAudience = entries.filter(j => j.audience && j.audience.total);
      const picks = st.options.map(o => ({
        optionId: o.id, label: o.label, trap: !!o.trap, best: o === best,
        count: entries.filter(j => j.optionId === o.id).length,
      }));
      return {
        id: st.id, title: st.title, played: entries.length, picks,
        bestRate: entries.length ? round(entries.filter(j => j.optionId === best.id).length / entries.length, 2) : null,
        trapRate: entries.length ? round(entries.filter(j => j.trap).length / entries.length, 2) : null,
        avgSec: round(avg(entries.map(j => j.sec))),
        audienceGames: withAudience.length,
        audienceAgreeRate: withAudience.length ? round(withAudience.filter(j => j.audience.leader === j.optionId).length / withAudience.length, 2) : null,
        audienceBestRate: withAudience.length ? round(withAudience.filter(j => j.audience.leader === best.id).length / withAudience.length, 2) : null,
        // Заметки ведущих с прогонов — свежие первыми (записи архива уже отсортированы по времени, новые сверху).
        notes: games.map(g => g.session.notes && g.session.notes[st.id] ? { team: g.session.team, text: g.session.notes[st.id] } : null).filter(Boolean).slice(0, 10),
      };
    });
    const traps = [];
    steps.forEach(st => st.picks.filter(p => p.trap && p.count).forEach(p => traps.push({ stepId: st.id, stepTitle: st.title, label: p.label, count: p.count, rate: round(p.count / st.played, 2) })));
    const grades = {};
    games.forEach(g => { const l = g.summary && g.summary.grade; if (l) grades[l] = (grades[l] || 0) + 1; });
    // Средние по счёту и времени — по доигранным партиям (недоигранные занижают); если таких нет — по всем.
    const full = games.filter(g => g.session.journal.length === pack.steps.length);
    const base = full.length ? full : games;
    out.push({
      scenarioId: pack.meta.id, title: pack.meta.title,
      games: games.length,
      completed: games.filter(g => g.session.journal.length === pack.steps.length).length,
      avgScore: round(avg(base.map(g => g.session.score)), 1),
      maxScore: pack.steps.reduce((s, st) => s + Math.max.apply(null, st.options.map(o => o.score)), 0),
      avgMoney: round(avg(base.map(g => g.session.metrics.money))),
      avgTtrMin: round(avg(base.map(g => g.session.metrics.ttrMin)), 1),
      avgGameSec: round(avg(base.map(g => g.session.journal.reduce((a, j) => a + j.sec, 0)))),
      averagesOver: full.length ? 'completed' : 'all',
      grades,
      topTraps: traps.sort((a, b) => b.rate - a.rate || b.count - a.count).slice(0, 5),
      slowSteps: steps.filter(s => s.avgSec !== null).slice().sort((a, b) => b.avgSec - a.avgSec).slice(0, 3).map(s => ({ id: s.id, title: s.title, avgSec: s.avgSec })),
      steps,
    });
  }
  return out;
}

module.exports = { aggregate };
