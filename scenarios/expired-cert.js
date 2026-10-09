/* Контент-пак «Просроченный сертификат» v1.0 — учебный кейс.
   Документ сценария: expired-certificate-training.md */
SCENARIO({
  id: 'expired-cert',
  title: 'Просроченный сертификат',
  version: '1.0',
  slot: 'учебный, слот 35 минут',
  alert: '🔥 [CRITICAL] Клиенты не подключаются: TLS handshake failure 100% на edge',

  durationSec: 720, winHoldSec: 60, winErrPct: 5,
  money: {basePerMin: 150000, failAt: 3000000, stabilizeAtMult: 0.3},
  panic: {
    tiers: [
      {min:0,max:4,name:'Штатный сбой',mult:1,cost:1},
      {min:5,max:9,name:'Повышенная тревога',mult:2,cost:1.5},
      {min:10,max:14,name:'Критический эскалейшн',mult:4,cost:1.5},
      {min:15,max:18,name:'Неконтролируемый шторм',mult:4,cost:1.5},
      {min:19,max:20,name:'Meltdown',mult:4,cost:1.5},
    ],
    autoEverySec: 180, silenceAfterSec: 240, meltdownAt: 20, meltdownHoldSec: 90,
  },

  schedule: {
    cioCall: {atSec: 120, durationSec: 90, panicEverySec: 30, caller: 'Александр (CIO)', lines: [
      'Почему у нас истёк сертификат? У нас правда никто этим не владеет?',
      'Это атака? Мне уже пишут из прессы.',
      'Сколько мы теряем в минуту? Считаете вообще?',
      'Назовите время. Не «разбираемся», а время.',
      'Мне сказали, вчера что-то выкатывали. Почему не откатываете?',
    ]},
    worldEvents: {rollsAt: [360], table: [null,
      {t:'Соцсети: «банк взломали, деньги пропали»', d:'Comms даёт публичный комментарий за 2 минуты, иначе паника +1.'},
      {t:'Менеджер мобильного направления: «Это ваше приложение виновато, докажите обратное!»', d:'IC просит факт (C2 или S4) и озвучивает. Ссора без факта — +1.'},
      {t:'Подарок: инфра-коллега: «после миграции edge renew вроде отвалился, я забыл сказать»', d:'Ведёт к P3. Скачок по K4.'},
      {t:'ИБ: «Может, временно отключим проверку TLS?»', d:'Искушение T-INSECURE. Спасает D2.'},
      {t:'Дежурный из смежной команды: «Могу self-signed за минуту сгенерить»', d:'То же искушение. Self-signed с pinning не пройдёт.'},
    ]},
  },

  roles: {
    commander:{name:'Incident Commander',short:'IC',color:'violet',
      desc:'Ведёт доску гипотез и даёт «Go» на действия. Данных системы не видит. Сводит противоречащие срезы.',
      limit:'Не запрашивает данные и не запускает действия. Во время звонка CIO «Go» недоступен (если звонок не перехватил Comms).'},
    scout:{name:'Observability Scout',short:'Scout',color:'cyan',
      desc:'Метрики и дашборды. Видит edge и внутренние сервисы.',
      limit:'Туннельное зрение: хранятся только два последних артефакта. Не проговорил — потерял.'},
    platform:{name:'Platform Engineer',short:'Platform',color:'green',
      desc:'Kubernetes, сеть, сертификаты, cron, мониторинг.',
      limit:'Инфраструктурные действия без ревью — риск: GM бросает d10, на 1–2 опечатка.'},
    domain:{name:'Domain Specialist',short:'Domain',color:'amber',
      desc:'Владеет api-service: код, релизы, ранбуки.',
      limit:'Не раскатывает ничего, пока Platform вслух не подтвердил готовность кластера.'},
    comms:{name:'Comms Liaison',short:'Comms',color:'red',
      desc:'Тикеты, стейкхолдеры, статус-страница, внутренние чаты.',
      limit:'Техническая немота: технических артефактов не получает. Нужна одна фраза инженеров человеческим языком.'},
  },
  roleOrder: ['commander','scout','platform','domain','comms'],

  startScreens: {
    scout:`RED · edge (последние 10 мин)
  success        99,2% → 7,4%
  ошибки         100% — TLS handshake failure
  p99            n/a (соединение не установлено)
  RPS на входе   обычный

Карта сервисов
  edge [RED]  handshake failure
  api-service [GREEN]  5xx 0%  p99 118 ms
  postgresql  [GREEN]`,
    platform:`NAME                       READY  STATUS   RESTARTS  AGE
api-service-6f8c1-*****
  (8 подов)                  1/1    Running  0         5h02m
edge-nginx-2b-*****        1/1    Running  0         30d

HPA  штатно
ALERTS: нет. Ни одного.`,
    domain:`Релиз api-service v1.9.2 (вчера 16:40)
  - checkout: новый фича-флаг
  - deps: jackson 2.15 → 2.16

api-service · log (12:00–12:10)
  4 запроса от cron-джобы, все 200.
  Тишина.`,
    comms:`#incident
  12:01  [support-lead] Тикеты хлынули, все «не подключается».
  12:02  [e-com] У нас что-то упало? Клиенты пишут.
  12:03  [CIO] Что происходит? Кто ведёт?

Саппорт · последние тикеты
  #50211 «приложение пишет ошибка сети»
  #50212 «не подключается вообще»
  #50213 «это взлом???»
  ... +190

Статус-страница: Все системы работают (не обновлялась)`,
    commander:`Данных системы у вас нет.
Ваши инструменты: доска гипотез, «Go» на действия, синхронизация.
Ваша работа: свести срезы — «инфра зелёная», «ошибки на входе», «клиенты не подключаются».`,
  },

  artifacts: [
    {id:'S1',role:'scout',tool:'Типы ошибок на edge, топ-5',cost:20,key:'K2',body:
`С 12:00:00 ровно 100% ошибок:
  SSL_do_handshake() failed ... certificate expired
До 12:00 — ноль ошибок.`},
    {id:'S2',role:'scout',tool:'Карта сервисов внутри периметра',cost:15,key:'K2',body:
`api-service: 5xx 0%   p99 118 мс   пул БД норм
БД: нагрузка штатная

Внутри периметра всё живо.`},
    {id:'S3',role:'scout',tool:'Хронология: релизы против метрик',cost:20,key:'K3',body:
`deploy v1.9.2          16:40 вчера
метрики 16:41→11:59    безупречны
обвал                  ровно в 12:00:00`},
    {id:'S4',role:'scout',tool:'RPS по клиентам / ASN / User-Agent',cost:20,key:null,body:
`Уникальных пользователей (10 мин):  ×1,01
User-Agent: только наше приложение 6.2
Повторных запросов с тем же id: 2% (мобильный клиент не ретраит handshake)

DDoS не подтверждается.`},
    {id:'S5',role:'scout',tool:'Дашборд мобильной аналитики (decoy)',cost:15,key:null,decoy:true,body:`Крашей приложения нет, версии в норме.`},
    {id:'P1',role:'platform',tool:'kubectl get pods -A',cost:15,key:null,body:
`Всё Running, рестартов 0, ресурсы 40/60%.

Инфраструктура зелёная.`},
    {id:'P2',role:'platform',tool:'openssl s_client к edge + даты сертификата',cost:30,key:'K1',body:
`$ echo | openssl s_client -connect edge:443 -servername api.bank.example
verify error:num=10: SSL routines::certificate has expired

notBefore   90 дней назад
notAfter    сегодня, 12:00:00`},
    {id:'P3',role:'platform',tool:'История renewal: cron и логи renew-certs.sh',cost:30,key:'K4',body:
`last success          30 дней назад
затем                 FAILED (ACME-секрет не найден после миграции)
7 дней назад          дежурный отключил cron «до разборки»`},
    {id:'P4',role:'platform',tool:'Правила мониторинга сертификатов',cost:20,key:'K4',body:
`Правило «cert expires < 30d»:
  target  /etc/nginx/tls/old.pem   (старый путь)
  статус  no data — 30 дней
Дашборд сроков жизни сертификатов: пуст.`},
    {id:'P5',role:'platform',tool:'Диски, ноды, сертификаты других фронтов (decoy)',cost:15,key:null,decoy:true,body:
`Ноды Ready, диски 41%.
office.bank.example — осталось 200 дней.`},
    {id:'D1',role:'domain',tool:'Diff релиза v1.9.2',cost:20,key:'K3',body:
`checkout/flag/…        +38
jackson                2.15 → 2.16
TLS / сетевое / конфиг   не тронуты`},
    {id:'D2',role:'domain',tool:'README: схема трафика и TLS',cost:15,key:'K3',body:
`«TLS терминируется на edge, внутри периметра plain HTTP.
Приложение не использует сертификаты».

Отдельно: pinning в приложении включён.`},
    {id:'D3',role:'domain',tool:'Ранбук «Обновление TLS-сертификата edge»',cost:15,key:null,body:
`Шаги актуальны.
Владелец — инженер, уволившийся месяц назад.
Последний запуск: 90 дней назад.

Примечание: аварийный серт на 30 дней лежит в vault, инструкция в разделе 9.`},
    {id:'D4',role:'domain',tool:'Changelog зависимостей (decoy)',cost:15,key:null,decoy:true,body:`jackson 2.16: security fixes only, релизноты без TLS.`},
    {id:'C1',role:'comms',tool:'Кластеризация тикетов',cost:15,key:null,body:
`«приложение не подключается / ошибка сети»   88%
«нас взломали?»                               7%
прочее                                        5%

Соцсети начинают шуметь.`},
    {id:'C2',role:'comms',tool:'Мобильная команда (чат)',cost:30,key:'K2',body:
`«6.2 с pinning, до нас трафик не доходит вообще.
Наш релиз был неделю назад. Смотрите сетевой слой».`},
    {id:'C3',role:'comms',tool:'Поиск «сертификат» по внутренним чатам',cost:20,key:null,body:
`14 дней назад, дежурный инфраструктуры:
«помню, после миграции edge что-то было с сертом,
не помню чем кончилось».`},
    {id:'C4',role:'comms',tool:'Цифры бизнеса',cost:15,key:null,body:
`Мобильный канал — 68% трафика.
Полный простой — 150 000 ₽/мин.
Каждые 15 минут — 2,25 млн ₽.`},
    {id:'C5',role:'comms',tool:'Календарь акций и рассылок (decoy)',cost:15,key:null,decoy:true,body:`Сегодня тихо, акций нет.`},
  ],

  mitigations: [
    {id:'M-P1',role:'platform',title:'Обновить сертификат edge по ранбуку (новый серт, nginx -s reload)',cost:90,review:true,hint:'Лечение. Деньги горят, пока серт ставится. Нужна K1.'},
    {id:'M-P2',role:'platform',title:'Аварийный сертификат из vault-архива (на 30 дней)',cost:45,review:true,hint:'Быстро, но костыль: Resolved с оговоркой. Нужна K4 или D3.'},
    {id:'T-ROLL',role:'domain',title:'Откатить api-service на v1.9.1',cost:60,review:false,reversible:true,hint:'Вчерашний релиз под подозрением. Обратимо: можно без улик, но сначала сверьте время сбоя с временем релиза.'},
    {id:'T-RESTART',role:'platform',title:'Rolling restart api-service и edge',cost:60,review:false,trap:true,trapDelta:1,hint:'Поды встанут здоровыми, серт всё тот же.'},
    {id:'T-INSECURE',role:'domain',title:'Перевести edge на http / отключить проверку сертификата',cost:30,review:true,trap:true,hint:'Pinning и HSTS: не сработает. ИБ взорвётся.'},
    {id:'T-SCALE',role:'platform',title:'Масштабировать api-service 8 → 16',cost:45,review:false,trap:true,trapDelta:1,hint:'Трафик до приложения не доходит.'},
  ],

  // Проектор: графики по полям telemetry(); side — подпись справа от заголовка.
  charts:[
    {key:'err',title:'TLS handshake failure на edge',max:100,color:'#ff5a6a',unit:' %',digits:1,idle:0.3,transient:50,
     side:t=>'success '+Math.max(0,100-t.err)+' %'},
    {key:'rps',title:'RPS на edge',max:3000,color:'#5fb8f0',idle:2000,
     format:v=>new Intl.NumberFormat('ru-RU').format(Math.round(v))},
  ],
  // Первое упоминание настоящей причины в ленте — метрика постмортема.
  rootCause:/сертификат|certificate|expired/i,

  telemetry:(g)=>{
    const A=new Set(g.applied||[]);
    let t={err:93,rps:2000,pool:'—',poolN:0,gor:0,mult:1.0,label:'Инцидент: TLS handshake failure 100%, success 7%'};
    if(A.has('M-P1')) t={err:1,rps:2000,pool:'—',poolN:0,gor:0,mult:0,label:'Сертификат обновлён: success 99%, стабилизация'};
    else if(A.has('M-P2')) t={err:5,rps:2000,pool:'—',poolN:0,gor:0,mult:0,label:'Временный сертификат (30 дней): success 95%, Resolved с оговоркой'};
    return t;
  },

  trainingOverrides: {panic: {autoEverySec: 360, silenceAfterSec: 300}},

  hints: {
    commander: [
      'Соберите команду: объявите «Синхронизацию» — каждая роль называет факт и гипотезу.',
      'Заведите три гипотезы, которые назовут первыми: релиз, приложение, DDoS.',
      'Следите за таймером звонка CIO: примите его или отдайте Comms.',
      'Не давайте «Go» на действие без привязанной улики — это +2 паники.',
      'Когда success ≥ 95% держится 60 секунд — объявите Resolved вслух.',
    ],
    scout: [
      'Прочитай стартовый экран вслух команде: цифры и время.',
      'Запроси S1 (типы ошибок) — что именно ломается?',
      'Запроси S2 (карта внутри) — бэкенд жив?',
      'Проговори вывод и вынеси на стену (140 знаков).',
      'Запроси S3 или S4, чтобы снять «релиз» и «DDoS».',
    ],
    platform: [
      'Прочитай стартовый экран: всё зелёное — скажи об этом команде как факт.',
      'Запроси P2 (даты сертификата) — главная улика кейса.',
      'Вынеси K1 на стену: «серт истёк ровно в 12:00».',
      'Запроси P3 или P4 — почему не заметили заранее.',
      'Предложи M-P1 (или M-P2 по ранбуку D3) с привязкой к улике.',
    ],
    domain: [
      'Прочитай стартовый экран: релиз вчера, логи чисты.',
      'Запроси D1 (diff) — снимите «релиз сломал» вместе со Scout.',
      'Запроси D2 — кто вообще владеет TLS?',
      'Сходи в D3 (ранбук) — там аварийный серт из vault.',
      'Не жми «откатить релиз» — это ловушка, сначала улики.',
    ],
    comms: [
      'Прочитай ленту тикетов вслух: что именно пишут клиенты?',
      'Запроси C2 (мобильная команда) — снимите «приложение сломалось».',
      'Опубликуй первый статус-апдейт: что не работает / что работает / когда следующий.',
      'Возьми звонок CIO на себя («Щит»): влияние, что делаем, чекпойнт.',
      'Перед финалом запроси C4 — цифры для апдейта.',
    ],
  },

  cheatsheet:`Причина: сертификат на edge истёк ровно в 12:00:00. Renewal мёртв 30 дней
(после миграции ноды), мониторинг слеп (правило на старый путь), владелец ранбука уволен.
Внутри периметра plain HTTP — api-service и БД здоровы и ни при чём.
Приложение 6.2 с TLS pinning — обхода нет.

Победа: M-P1 (новый серт по ранбуку, 90 с) или M-P2 (аварийный из vault, 45 с, костыль на 30 дней).
Ловушки: T-RESTART, T-INSECURE (pinning/HSTS), T-SCALE. T-ROLL — не ловушка, а обратимая мера: тратит 60 с, ничего не меняет, таймлайн снимал её сразу.
K1 P2 · K2 S1/S2/C2 · K3 S3/D1/D2 · K4 P3/P4

Паника: +1 / 3 мин · +1 тишина > 4 мин · +2 ловушка · +2 вслепую (кроме обратимых: T-ROLL) · +1 / 30 с звонка
        −1 ключевая улика (K1–K4) · −1/−2 статус · −2 отбитый звонок · −3 стабилизация
Звонок CIO — на 2-й минуте, 90 с. Ивент d10 — на 6-й. Стоп на 12-й минуте.
Победа: ≥95% success 60 секунд. FAILED: 12 мин без стабилизации / паника 20 на 90 с / 3 млн ₽.`,
});
