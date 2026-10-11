// Минимальный валидный пак для тестов движка и сервера: два шага, пять ролей.
const roles = {};
for (const [id, name] of [['commander', 'Координатор'], ['scout', 'SRE'], ['engineer', 'Platform Engineer'], ['domain', 'Разработчик'], ['comms', 'Коммуникации']]) {
  roles[id] = { name, mission: 'Миссия ' + id, welcomePrivate: 'Привет, ' + id };
}
const priv = tag => Object.fromEntries(Object.keys(roles).map(r => [r, { data: `секрет-${tag}-${r}`, deliver: `донести-${tag}-${r}` }]));

module.exports = {
  meta: { id: 'mini', title: 'Мини-кейс', brief: 'Тестовый инцидент', difficulty: 'лёгкая', etaMin: 10, moneyLimit: 1000000 },
  roles,
  diagram: { nodes: [{ id: 'a', label: 'A', x: 10, y: 10, color: 'red' }, { id: 'b', label: 'B', x: 200, y: 10, color: 'green' }], edges: [{ from: 'a', to: 'b' }] },
  steps: [
    {
      id: 's1', title: 'Первый шаг', brief: 'Что-то сломалось', question: 'Что делаем?', focus: ['a'], state: { a: 'yellow' },
      private: priv('s1'), hint: 'Подсказка ведущему s1',
      options: [
        { id: 'A', label: 'Смотреть данные', effects: { tension: -5, money: 100000, ttrMin: 2 }, score: 2, revealText: 'Нашли улику', debrief: 'Лучший путь' },
        { id: 'B', label: 'Рестартнуть всё', effects: { tension: 15, money: 400000, ttrMin: 8 }, score: -1, trap: true, revealText: 'Стало хуже', debrief: 'Ловушка: симптом' },
        { id: 'C', label: 'Подождать', effects: { tension: 5, money: 200000, ttrMin: 4 }, score: 0, revealText: 'Ничего', debrief: 'Слабо' },
      ],
    },
    {
      id: 's2', title: 'Второй шаг', brief: 'Нужно решение', focus: ['b'],
      private: priv('s2'), hint: 'Подсказка ведущему s2',
      options: [
        { id: 'X', label: 'Откатить', effects: { tension: 0, money: 50000, ttrMin: 3 }, score: 1, revealText: 'Помогло частично', debrief: 'Приемлемо' },
        { id: 'Y', label: 'Флаг', effects: { tension: -10, money: 10000, ttrMin: 1 }, score: 2, revealText: 'Стабилизировали', debrief: 'Лучший' },
      ],
    },
  ],
  distractions: [
    { id: 'cto', kind: 'call', from: 'CTO', text: '«Координатора — в звонок»', win: 'Трубку взяли Коммуникации' },
    { id: 'pm', kind: 'ping', role: 'scout', from: 'PM', text: 'секрет-лички', win: 'Отложил' },
    { id: 'bk', kind: 'alert', from: 'Alertmanager', text: '[WARNING] backup-job', win: 'Проверили одной фразой' },
    { id: 'mkt', kind: 'joiner', from: 'Маркетинг', text: '«Что происходит? Коротко»', win: 'Сводка за 30 секунд' },
    { id: 'graf', kind: 'outage', role: 'scout', from: 'Grafana', text: '502 Bad Gateway', win: 'Цифры дали устно' },
    { id: 'out', kind: 'handover', from: 'Координатор', text: 'Телефон сел', win: 'Командование передали вслух' },
  ],
  end: {
    grades: [
      { min: 4, label: 'Образцово', text: 'Всё по данным' },
      { min: 2, label: 'Уверенно', text: 'С потерями' },
      { min: -99, label: 'Тяжело', text: 'Разберите' },
    ],
    rootCause: 'Причина мини-кейса', debriefQuestions: ['Где опирались на данные?'],
  },
};
