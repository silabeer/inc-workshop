/* Контент-пак «Фантомная сеть» v3.1 — перенос контента из war-room.html.
   Документ сценария: phantom-network-asymmetric.md */
SCENARIO({
  id: 'phantom-network',
  title: 'Фантомная сеть и шторм повторов',
  version: '3.1',
  slot: 'связка order-service → payment-proxy, слот 60 минут',
  alert: '🔥 [CRITICAL] 504 Gateway Timeout on checkout-api > 45%. Success Rate: 8.4%',

  durationSec: 1320, winHoldSec: 90, winErrPct: 5,
  money: {basePerMin: 150000, failAt: 10000000, stabilizeAtMult: 0.3},
  panic: {
    tiers: [
      {min:0,max:4,name:'Штатный сбой',mult:1,cost:1},
      {min:5,max:9,name:'Повышенная тревога',mult:1,cost:1},
      {min:10,max:14,name:'Критический эскалейшн',mult:2,cost:1.5},
      {min:15,max:18,name:'Неконтролируемый шторм',mult:4,cost:1.5},
      {min:19,max:20,name:'Meltdown',mult:4,cost:1.5},
    ],
    autoEverySec: 240, silenceAfterSec: 300, meltdownAt: 20, meltdownHoldSec: 120,
  },

  schedule: {
    cioCall: {atSec: 240, durationSec: 180, panicEverySec: 45, caller: 'Александр (CIO)', lines: [
      'Мне через десять минут звонить председателю правления. Что я ему скажу?',
      'Почему не откатили релиз? Мы всегда откатываем.',
      'Назовите время. Не «разбираемся», а время.',
      'Кто виноват — мы или эквайер? Мне нужна фамилия.',
      'Сколько мы уже потеряли? Вы вообще считаете?',
      'Я сейчас подключу ещё десять человек, они помогут.',
      'Платёжный сервис же зелёный, мне дашборд показали. Почему вы на него смотрите?',
    ]},
    worldEvents: {rollsAt: [420, 900], table: [null,
      {t:'Шквал саппорта', d:'+20% к ставке потерь, пока не выйдет статус-апдейт на 2 из 3.', fx:'storm'},
      {t:'Пост в крупном телеграм-канале «банк лежит»', d:'Comms за 2 минуты даёт публичный комментарий, иначе паника +1.'},
      {t:'Руководитель e-commerce: «Откатывайте релиз немедленно!»', d:'IC отвечает отказом со ссылкой на улики или поддаётся — ловушка 3.'},
      {t:'Графана тормозит', d:'Следующий запрос Scout стоит ×2.', fx:'scout-x2'},
      {t:'Дежурный DBA: «MR на pool_size=300 готов, мержу?»', d:'Искушение ловушкой 2. Спасает pg_stat_activity.'},
      {t:'ИБ: «Похоже на DDoS, режем на WAF?»', d:'Искушение ловушкой 1. Спасает разбивка RPS по клиентам.'},
      {t:'Эквайер обновил статус-страницу: «All systems operational»', d:'Проверка, верит ли команда своим данным.'},
      {t:'Сосед из другой команды «помог» и рестартнул поды order-service', d:'30 секунд ложного облегчения. Не объявит ли IC победу?', fx:'transient', transientSec:30},
      {t:'Алертит ledger-service', d:'Паника +1. Общий кластер БД — причина одна.', fx:'panic1'},
      {t:'Коллега: «У эквайера вроде сегодня работы на сети»', d:'Подарок. Ведёт к письму аккаунт-менеджеру.'},
    ]},
  },

  roles: {
    commander:{name:'Incident Commander',short:'IC',color:'violet',
      desc:'Ведёт доску гипотез и даёт «Go» на действия. Данных системы не видит. Сводит противоречащие срезы.',
      limit:'Не запрашивает данные и не запускает действия сам. Во время звонка CIO кнопка «Go» недоступна.'},
    scout:{name:'Observability Scout',short:'Scout',color:'cyan',
      desc:'Метрики, трейсы, дашборды. Видит edge-gateway, order-service, payment-proxy, зависимости.',
      limit:'Туннельное зрение: в терминале хранятся только два последних артефакта. Не проговорил — потерял.'},
    platform:{name:'Platform Engineer',short:'Platform',color:'green',
      desc:'Kubernetes, сеть, PgBouncer, Envoy. kubectl, ss, tcpdump, access-логи.',
      limit:'Инфраструктурные действия без ревью — риск: GM бросает d10, на 1–2 опечатка роняет соседний сервис.'},
    domain:{name:'Domain Specialist',short:'Domain',color:'amber',
      desc:'Владеет order-service и payment-proxy: код, дампы, фича-флаги, ранбуки.',
      limit:'Не раскатывает ничего (флаги можно), пока Platform вслух не подтвердит, что кластер примет раскатку.'},
    comms:{name:'Comms Liaison',short:'Comms',color:'red',
      desc:'Тикеты саппорта, стейкхолдеры, статус-страница, письма партнёрам.',
      limit:'Техническая немота: технических артефактов не получает. Для апдейта нужна одна фраза от инженеров человеческим языком.'},
  },
  roleOrder: ['commander','scout','platform','domain','comms'],

  startScreens: {
    scout:`RED · edge-gateway (последние 10 мин)
  RPS            2 010 → 8 480   ▲ ×4,2
  5xx            0,3% → 92,1%
  p99            180 ms → 30 000 ms   (ровная полка)

Карта сервисов
  edge-gateway ──► order-service  [RED]   5xx 92%
                     ├──► pgbouncer  [YELLOW] cl_waiting 70
                     └──► payment-proxy [GREEN] 5xx 0%  rps 0,4`,
    platform:`NAME                          READY  STATUS             RESTARTS  AGE
order-service-7c9f4-2xk8q     0/1    CrashLoopBackOff   6         5h12m
order-service-7c9f4-4hd2p     1/1    Running            5         5h12m
order-service-7c9f4-7vq1s     0/1    Running            7         5h12m
... (12 подов, рестартов 4–7, Exit Code: 137)
payment-proxy-5d8b6-b7qzn     1/1    Running            0         21d
payment-proxy-5d8b6-m2xl4     1/1    Running            0         21d
payment-proxy-5d8b6-w9kdt     1/1    Running            0         21d

HPA order-service   12/12 (max)
ALERT pgbouncer     cl_waiting > 20, maxwait > 10s   [FIRING 6m]`,
    domain:`Релиз order-service v2.41.0 (09:12)
  - receipt: новый шаблон чека
  - deps: bump mtsb-logging 3.4 → 3.5

Фича-флаги (prod)
  payments.card.enabled            = true
  payments.sbp.enabled             = true
  payments.card.fallback_acquirer  = false
  orders.async_payment             = false

order-service · ERROR (tail)
  14:07:41 HikariPool-1 - Connection is not available, request timed out after 30000ms
  14:07:41 HikariPool-1 - Connection is not available, request timed out after 30000ms
  14:07:42 HikariPool-1 - Connection is not available, request timed out after 30000ms
  ... ×4 812

payment-proxy · log
  14:01:12 INFO charge ok method=card 142ms
  14:01:38 INFO charge ok method=sbp 88ms
  (тишина с 14:01:40)`,
    comms:`#incident
  14:03  [e-com] Оплата не проходит у всех? Клиенты пишут.
  14:04  [support-lead] За 3 минуты 212 тикетов. Это рекорд.
  14:05  [CIO] Что происходит? Кто ведёт?

Саппорт · последние тикеты
  #48113 «не могу оплатить, крутится и ошибка»
  #48114 «списали или нет??? два раза нажала»
  #48115 «карта не проходит, через сбп прошло»
  #48116 «ошибка 504 что это»
  ... +208

Статус-страница: All systems operational (не обновлялась)`,
    commander:`Данных системы у вас нет.
Ваши инструменты: доска гипотез, «Go» на действия, синхронизация.
Ваша работа: свести три среза, которые будут противоречить друг другу.`,
  },

  artifacts: [
    {id:'S1',role:'scout',tool:'RPS по клиентам / ASN / User-Agent',cost:30,key:'K4',body:
`Уникальных пользователей (10 мин):   41 200 → 42 100   (×1,02)
Запросов на пользователя:            2,9 → 12,1
User-Agent:  MTSBank-iOS/5.8.2  61%   MTSBank-Android/5.8.1  36%   прочее 3%
ASN top:     MTS 31%  Beeline 22%  Megafon 19%  Tele2 14%  прочие 14%
Повторных запросов с тем же X-Request-Id:  76%`},
    {id:'S2',role:'scout',tool:'Тепловая карта задержек order-service',cost:20,key:null,body:
`latency heatmap · POST /orders · 14:02–14:08
   30 000 ms ████████████████████████████████████████  91,7%
    2 000 ms
      500 ms
      120 ms ███                                          8,3%
быстрые ответы: GET /checkout/config + первые 5–8 с жизни свежих подов`},
    {id:'S3',role:'scout',tool:'Хронология по эндпоинтам',cost:30,key:'K5',body:
`14:01:40  POST /orders  pay=card   p99 180ms → 30 000ms   5xx ▲
14:01:40  POST /orders  pay=sbp    p99 210ms   OK
14:02:10  POST /orders  pay=sbp    p99 → 30 000ms   5xx ▲
14:02:10  GET  /cart, /profile     p99 → 30 000ms   5xx ▲
14:02:15  GET  /checkout/config    OK (без БД)`},
    {id:'S4',role:'scout',tool:'Success rate по подам order-service',cost:45,key:null,body:
`pod           success(%)  таймлайн 60с
-2xk8q        0    ▁▁▁▁▁█▇▃▁▁▁▁▁▁  (рестарт 14:06:12)
-4hd2p        0    ▁▁▁▁▁▁▁▁▁▁█▆▂▁  (рестарт 14:06:41)
-7vq1s        0    ▁▁▁▁▁▁▁▁▁▁▁▁▁▁
После рестарта под отдаёт 200 примерно 6 секунд, затем 0.`},
    {id:'S5',role:'scout',tool:'Распределённый трейс упавшего POST /orders',cost:60,key:'K2',body:
`trace 8f2c…a1 · POST /orders · status 504 · 30 002 ms
├─ envoy ingress                        0 ms ── 30 002 ms   [timeout UT]
└─ order-service placeOrder             2 ms ── (обрезан)
   ├─ pg INSERT INTO orders             4 ms ✔
   ├─ http POST payment-proxy /charge/card   6 ms ── ∞  [span open]
   │  └─ http POST acq-gw /v2/authorize      7 ms ── ∞  [span open]
   │     └─ tcp connect 11 ms ✔  tls ✔  request sent ✔  response: —
   └─ pg COMMIT                         — (не достигнут)`},
    {id:'S6',role:'scout',tool:'Дашборд зависимостей',cost:45,key:'K6',body:
`order-service → payment-proxy     in-flight 48   ответов/мин 0   ошибок 0
order-service → pgbouncer         in-flight 120  maxwait 29s
payment-proxy → acq-gw:443        in-flight 48   ответов/мин 0   ошибок 0   connect 11ms
payment-proxy → nspk              запросов/мин 0

payment-proxy RED:  rps 400 → 0,4   5xx 0%   p99 n/a`},
    {id:'S7',role:'scout',tool:'Метрики JVM order-service',cost:30,key:null,body:
`heap used         1,1 / 2,0 GiB   (ровно, GC норм)
tomcat busy       200 / 200
hikari active     10 / 10
hikari pending    190
threads total     231`},
    {id:'S8',role:'scout',tool:'Runtime-метрики payment-proxy',cost:30,key:'K6',body:
`rps               400 → 0,4
5xx               0%
goroutines        210 → 258 в 14:02, дальше ПОЛКА 258 шесть минут
rss               120 → 180 MiB (+1 MiB/мин)
in-flight acq-gw  48 (не меняется)`},
    {id:'S9',role:'scout',tool:'Задержка DNS',cost:20,key:null,decoy:true,body:`coredns p99 1,2 ms · errors 0 · норма`},
    {id:'S10',role:'scout',tool:'Kafka consumer lag',cost:20,key:null,decoy:true,body:`orders-events lag 0 · receipts lag 3 · норма`},
    {id:'S11',role:'scout',tool:'CPU нод',cost:20,key:null,decoy:true,body:`node cpu avg 22% · max 34% · норма`},
    {id:'P1',role:'platform',tool:'kubectl describe pod order-service',cost:20,key:null,body:
`Last State:   Terminated
  Reason:     Error
  Exit Code:  137
Events:
  Warning  Unhealthy  Liveness probe failed: Get "http://10.4.1.17:8080/actuator/health": context deadline exceeded
  Normal   Killing    Container order-service failed liveness probe, will be restarted
Memory: 1 134Mi / limit 2Gi`},
    {id:'P2',role:'platform',tool:'Логи order-service',cost:30,key:null,body:
`14:07:41 ERROR HikariPool-1 - Connection is not available, request timed out after 30000ms
14:07:41 ERROR HikariPool-1 - Connection is not available, request timed out after 30000ms
14:07:43 ERROR o.a.tomcat.util.net.Acceptor - Socket accept failed
java.io.IOException: Too many open files
        at sun.nio.ch.ServerSocketChannelImpl.accept0(Native Method)`},
    {id:'P3',role:'platform',tool:'ss -tan в поде order-service (сводка)',cost:45,key:null,body:
`ESTAB       4    → payment-proxy:8081
ESTAB      10    → pgbouncer:6432
CLOSE-WAIT 3 912 ← envoy (10.4.0.x) на :8080
LISTEN      1      :8080`},
    {id:'P4',role:'platform',tool:'/proc/1/limits + число fd',cost:30,key:null,body:
`Max open files   4096   4096   files
ls /proc/1/fd | wc -l   → 4096`},
    {id:'P5',role:'platform',tool:'PgBouncer SHOW POOLS',cost:20,key:null,body:
`database  user   cl_active cl_waiting sv_active sv_idle maxwait
orders    app    50        70         50        0       29`},
    {id:'P6',role:'platform',tool:'pg_stat_activity',cost:45,key:'K1',body:
`state                 count  min_age  max_age  application   last query
idle in transaction   48     3m02s    6m12s    order-service INSERT INTO orders (…)
active                2      0s       1s       ledger-service SELECT …
cpu(db)  6%   locks 0   replication ok`},
    {id:'P7',role:'platform',tool:'История раскаток',cost:20,key:null,body:
`order-service   v2.41.0   09:12 today   (5h без замечаний)
order-service   v2.40.3   3d ago
payment-proxy   v1.17.2   21d ago
edge-gateway    envoy 1.29  40d ago`},
    {id:'P8',role:'platform',tool:'Выборка access-лога Envoy',cost:45,key:'K4',body:
`x-client-retry-count ≥ 1 : 80%   max: 12
upstream_rq_time: 30000   response_flags: UT   code: 504
[14:07:40] POST /orders 504 UT 30000ms x-client-retry-count=7  ua=MTSBank-iOS/5.8.2
[14:07:40] POST /orders 504 UT 30000ms x-client-retry-count=11 ua=MTSBank-Android/5.8.1`},
    {id:'P9',role:'platform',tool:'describe + ss в поде payment-proxy',cost:45,key:'K6',body:
`payment-proxy-5d8b6-b7qzn   Running   restarts 0   cpu 3%   rss 180Mi/512Mi (+1Mi/min)
ss -tan:
  ESTAB 16 ← order-service на :8081     (все старше 3 мин)
  ESTAB 16 → acq-gw.partner:443         (все старше 3 мин)
  ESTAB  0 → nspk
(×3 пода = 48 пар «вход-выход»)`},
    {id:'P10',role:'platform',tool:'curl -v + tcpdump из пода payment-proxy к acq-gw',cost:40,key:'K2',body:
`* Connected to acq-gw.partner (185.x.x.x) port 443 (11 ms)
* TLS 1.3 handshake OK
> POST /v2/authorize HTTP/1.1
* Request completely sent off
* Operation timed out after 10 001 ms with 0 bytes received
tcpdump: наши сегменты ACK'нуты, данных от сервера 0, FIN нет, RST нет.
Контроль: curl nspk → 200 за 90 ms`},
    {id:'P11',role:'platform',tool:'Состояние нод',cost:20,key:null,decoy:true,body:`12/12 Ready · pressure none`},
    {id:'P12',role:'platform',tool:'События CNI / сеть кластера',cost:20,key:null,decoy:true,body:`cilium: 0 drops · policy ok`},
    {id:'P13',role:'platform',tool:'Сертификаты Envoy',cost:20,key:null,decoy:true,body:`*.mtsbank: expires in 89d · chain ok`},
    {id:'D1',role:'domain',tool:'Diff релиза v2.41.0',cost:45,key:null,body:
`receipt/ReceiptTemplate.java     +41 −12
build.gradle                      mtsb-logging 3.4.0 → 3.5.1
payments/**                       (без изменений)
http/**                           (без изменений)`},
    {id:'D2',role:'domain',tool:'Thread dump order-service (jstack, сводка)',cost:40,key:'K1',body:
`190 × WAITING   HikariPool.getConnection            (сменяются каждые 30 с)
  6 × RUNNABLE  socketRead0 ← org.postgresql.QueryExecutor   (ждут PgBouncer)
  4 × RUNNABLE  socketRead0 ← PaymentProxyClient.charge
                ← OrderService.placeOrder [@Transactional]
                самый старый:  6m12s    (остальные 3: 5m48s, 4m30s, 3m02s)`},
    {id:'D3',role:'domain',tool:'Код HTTP-клиентов на обоих хопах',cost:45,key:'K3',body:
`order-service · mtsb-http-commons/HttpClients.java
  RequestConfig.custom().setConnectTimeout(2000).build();   // setSocketTimeout — нет
  git blame: 2y 4m ago

payment-proxy · acquirer/client.go
  &http.Client{Transport: &http.Transport{
      DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
  }}                                                        // Timeout: — нет
  resp, err := c.http.Do(req.WithContext(context.Background()))  // без дедлайна
  git blame: 2y 1m ago
circuit breaker: нет ни там, ни там`},
    {id:'D4',role:'domain',tool:'Goroutine dump payment-proxy',cost:40,key:'K2',body:
`goroutine profile: total 258
 48 @ net/http.(*persistConn).readLoop
      ← acquirer.(*Client).Authorize
      ← handlers.ChargeCard
      самая старая: 6m12s
  0 @ handlers.ChargeSBP
210 @ runtime/idle, http server, metrics (норма)`},
    {id:'D5',role:'domain',tool:'Ранбук: резервный эквайер и асинхронная оплата',cost:30,key:null,body:
`payments.card.fallback_acquirer=true
  → карты уходят на эквайера Б. Лимит 300 TPS. Комиссия +0,4%.
orders.async_payment=true
  → заказ принимается в PENDING_PAYMENT, списание в фоне, клиенту пуш.
!! Уже зависшие потоки и горутины флаги НЕ освобождают. После флага — rolling restart.`},
    {id:'D6',role:'domain',tool:'Проверка двойных списаний',cost:30,key:null,body:
`orders в статусе PENDING без commit:   4 812
авторизаций у эквайера за 14:01–14:08: 0
списаний: 0`},
    {id:'D7',role:'domain',tool:'README payment-proxy · конфигурация',cost:20,key:null,body:
`ACQUIRER_TIMEOUT   duration   default: unset (= без лимита)   читается при старте
ACQUIRER_CB        TODO`},
    {id:'D8',role:'domain',tool:'Конфиг шаблонизатора чеков',cost:20,key:null,decoy:true,body:`receipt.template=v3 · без ошибок`},
    {id:'D9',role:'domain',tool:'Changelog mtsb-logging 3.5.1',cost:20,key:null,decoy:true,body:`json layout fix · no runtime changes`},
    {id:'D10',role:'domain',tool:'Настройки GC',cost:20,key:null,decoy:true,body:`G1 · pause p99 18ms · норма`},
    {id:'C1',role:'comms',tool:'Кластеризация тикетов',cost:30,key:'K5',body:
`«не проходит оплата картой»            94%
«через СБП прошло» (упомянуто)          11 тикетов
«списали дважды?»                        8%
«приложение зависает» (общее)            6%`},
    {id:'C2',role:'comms',tool:'Вопрос мобильной команде',cost:60,key:'K4',body:
`[mobile-lead] 5.8 ретраит любой 5xx: 5 раз в секунду, до 12 попыток, без паузы.
Backoff с jitter лежит в бэклоге с марта. Могу выкатить в 5.9 через 2 недели.`},
    {id:'C3',role:'comms',tool:'Статус-страница эквайера',cost:20,key:null,body:`acq-gw.partner/status:  All systems operational   (обновлено 13:55)`},
    {id:'C4',role:'comms',tool:'Письмо аккаунт-менеджеру эквайера',cost:120,key:'K2',body:
`[AM эквайера] Плановые работы на сетевом оборудовании с 14:00 до 16:00, влияния не ожидали. Уточняю у сетевиков.`,
      followUp:{delay:180,body:`[AM эквайера] Подтверждаю: проблема на балансировщике, сессии не закрываются. Срока восстановления нет.`}},
    {id:'C5',role:'comms',tool:'Цифры бизнеса',cost:30,key:null,body:
`Оплаты: карта 62%  СБП 38%
Потери при полном простое: 150 000 ₽/мин
Средний чек: 3 400 ₽`},
    {id:'C6',role:'comms',tool:'Упоминания в соцсетях',cost:20,key:null,decoy:true,body:`3 упоминания за 10 мин · пока тихо`},
    {id:'C7',role:'comms',tool:'Календарь акций',cost:20,key:null,decoy:true,body:`сегодня акций нет`},
  ],

  mitigations: [
    {id:'M-P1',role:'platform',title:'Envoy: 429 + Retry-After на x-client-retry-count ≥ 1',cost:90,review:true,hint:'Срезает шторм повторов. Ошибки сами не уходят.'},
    {id:'M-P2',role:'platform',title:'Drain & Isolate: 4 пода только под sbp и не-/orders',cost:120,review:true,hint:'Переборка по способу оплаты. Нужна улика «только карты».'},
    {id:'M-P3',role:'platform',title:'Rolling restart order-service',cost:60,review:false,hint:'Очищает зависшие потоки. До флага — 30 с облегчения.',
      apply:(A)=>(A.has('M-D1')||A.has('M-D2')||A.has('M-D2b'))
        ? {set:{cleared:true},msg:'Выполнено M-P3: Rolling restart order-service — зависшие потоки очищены',sev:'success'}
        : {transientSec:30,msg:'Выполнено M-P3: Rolling restart order-service — 30 секунд облегчения, потом снова',sev:'warning'}},
    {id:'M-P4',role:'platform',title:'Rolling restart payment-proxy',cost:60,review:false,hint:'Сбрасывает горутины. Без флага виснет снова через 10 с.',
      apply:(A)=>(A.has('M-D1')||A.has('M-D2')||A.has('M-D2b'))
        ? {set:{cleared:true},msg:'Выполнено M-P4: Rolling restart payment-proxy — горутины сброшены',sev:'success'}
        : {transientSec:30,msg:'Выполнено M-P4: Rolling restart payment-proxy — 30 секунд облегчения, потом снова',sev:'warning'}},
    {id:'M-P0',role:'platform',reversible:true,title:'Вернуть по манифесту: откатить своё последнее инфра-действие',cost:20,review:false,hint:'Без штрафа к панике. GM снимет эффект.',
      apply:(A,g,pack)=>{const infra=[...A].reverse().find(x=>x!=='M-P0'&&(pack.mitigations||[]).some(m=>m.id===x&&m.role==='platform'));
        return infra?{remove:[infra],msg:'Выполнено M-P0 — снято '+infra,sev:'success'}:{msg:'Выполнено M-P0 — откатывать нечего',sev:'info'};}},
    {id:'T-WAF',role:'platform',title:'Зарезать трафик на WAF / rate limit на Envoy',cost:60,review:true,trap:true,hint:'Похоже на DDoS?'},
    {id:'T-POOL',role:'platform',title:'PgBouncer default_pool_size 50 → 300',cost:45,review:true,trap:true,hint:'База же ждёт коннектов.'},
    {id:'T-NOFILE',role:'platform',title:'Поднять nofile до 65 536 и maxThreads',cost:45,review:false,trap:true,hint:'Too many open files исчезнет.'},
    {id:'T-LIVE',role:'platform',title:'Убрать liveness-пробу order-service',cost:30,review:false,trap:true,hint:'Рестарты прекратятся.'},
    {id:'T-SCALE',role:'platform',title:'Масштабировать payment-proxy 3 → 10',cost:60,review:false,trap:true,hint:'Больше подов — больше горутин.'},
    {id:'T-ROLL',role:'domain',title:'Откатить order-service на v2.40.3',cost:90,review:true,reversible:true,hint:'Утренний релиз под подозрением. Обратимо: можно без улик, но время дорогое.',
      apply:()=>({transientSec:30,msg:'Выполнено T-ROLL: Откатить order-service на v2.40.3 — 30 секунд облегчения, ничего не изменилось: релиз ни при чём',sev:'warning'})},
    {id:'M-D1',role:'domain',reversible:true,title:'Kill-switch: payments.card.enabled=false',cost:30,review:false,hint:'Карта получает вежливый отказ. Зависшее не освобождает.'},
    {id:'M-D2',role:'domain',reversible:true,title:'payments.card.fallback_acquirer=true',cost:30,review:false,hint:'Эквайер Б, лимит 300 TPS. Без среза ретраев — 429.'},
    {id:'M-D2b',role:'domain',reversible:true,title:'orders.async_payment=true',cost:30,review:false,hint:'Заказ в PENDING_PAYMENT, списание позже. Клиентам надо объяснить.'},
    {id:'M-D3',role:'domain',title:'Хотфикс: ACQUIRER_TIMEOUT=3s в payment-proxy + rollout',cost:90,review:true,hint:'Карта падает через 3 с вместо вечности. Частичный эффект.'},
    {id:'M-D4',role:'domain',title:'pg_terminate_backend для idle in transaction',cost:45,review:true,hint:'Освобождает 6 из 10 коннектов на 2 минуты.'},
  ],

  // Проектор: графики по полям telemetry(); side — подпись справа от заголовка.
  charts:[
    {key:'err',title:'5xx · edge',max:100,color:'#ff4d4f',unit:' %',digits:1,idle:0.3,transient:60,jitter:4,
     side:t=>'RPS '+new Intl.NumberFormat('ru-RU').format(t.rps)},
    {key:'poolN',title:'Пул коннектов БД',max:t=>t.poolN>50?300:50,color:'#f5a524',idle:6,transient:20,jitter:2,
     format:(v,t)=>Math.round(v)+' / '+(t.poolN>50?300:50),side:t=>'cl_waiting '+(t.poolN>=50?70:0)},
    {key:'gor',title:'Горутины payment-proxy',max:300,color:'#4fc3f7',idle:210,transient:215,jitter:2,side:()=>'5xx 0 %'},
  ],
  // Ручные переключатели на пульте GM (поле game[key]).
  manualFlags:[{key:'cleared',label:'зависшие потоки очищены (рестарт после флага)',on:'Зависшие потоки очищены'}],
  // Первое упоминание настоящей причины в ленте — метрика постмортема.
  rootCause:/эквайер|acq/i,

  telemetry:(g)=>{
    const A=new Set(g.applied||[]);
    const flag=A.has('M-D1')||A.has('M-D2')||A.has('M-D2b');
    const cleared=!!g.cleared;
    let t={err:92,rps:8500,pool:'50/50',poolN:50,gor:258,mult:1.0,label:'Инцидент'};
    if(A.has('T-WAF')) t={err:0,rps:8500,pool:'50/50',poolN:50,gor:258,mult:1.6,label:'WAF: 100% запросов получают 403, СБП тоже мёртв'};
    if(A.has('T-POOL')) t={...t,pool:'120/300',poolN:120,mult:Math.max(t.mult,1.3),label:'Пул 300: max_connections исчерпан, ledger-service упал'};
    if(A.has('T-LIVE')) t={...t,err:100,label:'Без liveness: пила исчезла, success ровно 0%'};
    if(A.has('M-P1')) t={...t,rps:2200};
    if(A.has('M-D3')&&!flag) t={...t,err:A.has('M-P1')?50:70,pool:'30/50',poolN:30,gor:16,mult:0.8,label:'Таймаут 3 с: карта падает быстро, но Hikari всё ещё держится по 3 с'};
    if(A.has('M-P2')&&!flag) t={...t,err:55,mult:0.6,label:'Переборка: СБП и корзина живы, карта лежит'};
    if(A.has('M-D4')&&!flag) t={...t,err:40,pool:'20/50',poolN:20,mult:0.5,label:'Сессии сброшены: 6 из 10 коннектов работают, через 2 минуты снова'};
    if(flag&&!cleared) t={...t,label:t.label+' · флаг включён, но зависшие потоки не освобождены — нужен рестарт'};
    if(flag&&cleared){
      const p1=A.has('M-P1');
      if(A.has('M-D2b')) t={err:2,rps:p1?2200:2400,pool:'9/50',poolN:9,gor:210,mult:0.3,label:'Асинхронная оплата: заказы принимаются, списание позже'};
      else if(A.has('M-D2')) t=p1?{err:2,rps:2200,pool:'8/50',poolN:8,gor:210,mult:0,label:'Резервный эквайер + срез ретраев: стабилизация'}
                          :{err:45,rps:8500,pool:'14/50',poolN:14,gor:210,mult:0.5,label:'Резервный эквайер без среза ретраев: 300 TPS пробиты, Б отвечает 429'};
      else t={err:3,rps:p1?2200:2400,pool:'9/50',poolN:9,gor:210,mult:0.6,label:'Карта отключена: всё остальное здорово'};
    }
    return t;
  },

  cheatsheet:`Причина: эквайер принимает TCP/TLS и молчит (ни FIN, ни RST).
payment-proxy → acq-gw без Timeout → 48 горутин висят, сервис «зелёный» (трафика нет).
order-service → payment-proxy без SocketTimeout, вызов ВНУТРИ @Transactional → 4 потока/под держат Hikari,
190 ждут по 30 с → 504 → liveness не отвечает → 137 → CLOSE_WAIT от Envoy → nofile 4096.
Приложение 5.8 ретраит 5/с ×12 → RPS 2 000 → 8 500.

Победа: M-P1 (срез ретраев) → M-D2 или M-D2b (флаг) → M-P3 (рестарт). Рестарт ДО флага — 30 с облегчения.
K1 D2/P6 · K2 D4/P10/S5/C4 · K3 D3 · K4 P8/S1/C2 · K5 C1/S3 · K6 S6/S8/P9

Паника: +1 / 4 мин авто · +1 тишина > 5 мин · +2 ловушка · +2 вслепую (кроме обратимых: флаги, откат, M-P0) · +1 / 45 с звонка
Откат T-ROLL — не ловушка: законная обратимая мера, просто бесполезная здесь (стоит 90 с).
        −1 ключевая улика · −1/−2 статус · −2 отбитый звонок · −3 стабилизация
Звонок CIO — на 4-й минуте, 180 с. Ивенты d10 — на 7-й и 15-й.
Стоп на 22-й минуте. Победа: ≥95% success 90 секунд.`,
});
