# Сценарно-независимый движок воркшопа — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить односценарное приложение в движок, проводящий воркшоп по любому контент-паку: лобби с выбором кейса и режима, автопилот расписания, учебный режим с подсказками, архив игр.

**Architecture:** Контент-паки — саморегистрирующиеся `scenarios/*.js` (глобальная `SCENARIO(obj)`). Чистое ядро `engine.js` (universal-модуль: браузер + Node) несёт экономику и планировщик автопилота. `server.js` добавляет условную запись (`expectRev`/`409`), раздачу пакетов и архив. `war-room.html` теряет весь контент и собственную экономику, обретает лобби, исполнитель автопилота, вкладку подсказок и историю игр.

**Tech Stack:** Node.js 18+ (`node --test`), нулевые зависимости, vanilla JS/HTML.

**Spec:** `docs/superpowers/specs/2026-10-07-workshop-engine-design.md`

## Global Constraints

- Нулевые зависимости: никаких npm-пакетов, сборки, бандлеров. Запуск: `node server.js [порт]` и открытие `war-room.html` файлом.
- Каталог НЕ является git-репозиторием: шаги коммитов отсутствуют, git-команды не выполнять.
- Весь пользовательский текст — русский, стиль существующего кода (компактный, тот же словарь: «улика», «паника», «действие вслепую»).
- Пакеты обязаны зеркалить GM-документы: цены артефактов, ключи улик, таблицы телеметрии, расписание, пороги FAILED — точь-в-точь из `phantom-network-asymmetric.md` (v3.1) и `expired-certificate-training.md` (v1.0).
- `server.js` при запуске как скрипт ведёт себя как раньше (печать URL); при `require()` отдаёт фабрику для тестов.
- Старый `state.json` без поля `rev` игнорируется (переход без обратной совместимости, продуктивных игр не было).

## Review Focus

1. **Пауза во время игры:** планировщик считает в игровых секундах — ни звонок, ни ивент, ни исполнение действия не должны тикать на паузе. Тест: Task 3 (paused → null).
2. **Две вкладки с автопилотом (пульт + проектор):** эффект применяется ровно один раз, вторая вкладка получает 409 и молчит. Тест: Task 2 (гонка условных записей); ручная проверка: Task 8.
3. **Действие-ловушка вслепую:** паника +2 за ловушку И +2 за вслепую = +4 суммарно (спек §4.1: «в дополнение»). Тест: Task 3.
4. **Reset посреди ACTIVE-игры:** архив содержит полный снапшот, таймлайн и `.md` восстанавливаются из него. Тест: Task 2 (архивация), ручная проверка: Task 10.
5. **file://-режим:** без сервера лобби и игра работают, архив скрыт, rev не мешает. Ручная проверка: Task 6 и Task 10.

---

### Task 1: engine.js — чистое ядро экономики

**Files:**
- Create: `engine.js`
- Test: `test/engine.test.js`

**Interfaces:**
- Produces: universal-модуль — в браузере глобал `ENGINE`, в Node `require('./engine.js')`. Экспорты: `gameSec(game, now=Date.now()) -> number`, `burned(game, now=Date.now()) -> number`, `tierOf(panic:number, tiers:array) -> tier`, `currentRate(game, pack, now=Date.now()) -> number`.
- Семантика переносится из текущего `war-room.html`: `gameSec` — ACTIVE/PAUSED/ended (`pausedTotal`, `pausedAt`, `endedSec`); `burned` — интегрирование `rateSegments` по игровому времени; `currentRate` — `0` для LOBBY/RESOLVED/FAILED, иначе `pack.money.basePerMin × pack.telemetry(game).mult × tierOf(game.panic, pack.panic.tiers).mult × (game.storm ? 1.2 : 1)`, округление до рубля.

- [ ] **Step 1: Написать failing-тесты `test/engine.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const ENGINE = require('../engine.js');

// fakePack-стаб, используется во всех тестах задачи:
const tiers = [
  {min:0,max:4,name:'a',mult:1,cost:1},{min:5,max:9,name:'b',mult:2,cost:1.5},
  {min:10,max:14,name:'c',mult:4,cost:1.5},{min:15,max:18,name:'d',mult:4,cost:1.5},
  {min:19,max:20,name:'e',mult:4,cost:1.5}];
const pack = { money:{basePerMin:150000}, panic:{tiers},
               telemetry:(g)=>({mult: g&&g.applied&&g.applied.includes('FIX')?0:1.0}) };

test('gameSec: пауза замораживает, ended отдаёт endedSec', ...)
// ACTIVE startedAt=1000, now=61000, pausedTotal=0 → 60; PAUSED pausedAt=31000 → 30;
// endedSec=77 → 77 вне зависимости от now.
test('burned: интегрирует сегменты по игровому времени', ...)
// rateSegments [{t:0,rate:150000},{t:60,rate:300000}], gameSec=120 → 450000.
test('tierOf: границы тиров', ...)
// 0→a, 4→a, 5→b, 9→b, 10→c, 14→c, 15→d, 18→d, 19→e, 20→e.
test('currentRate: множители и нулевые статусы', ...)
// ACTIVE panic 12 → 150000×1×4=600000; storm → 720000;
// applied:['FIX'] → 0; LOBBY/RESOLVED/FAILED → 0.
```

- [ ] **Step 2: Прогнать — должны упасть**

Run: `node --test test/engine.test.js`
Expected: FAIL (`Cannot find module '../engine.js'`)

- [ ] **Step 3: Реализовать `engine.js`**

UMD-обёртка (factory-функция, `module.exports` vs `root.ENGINE`). Тела — перенос логики из `war-room.html` (`gameSec`, `burned`) с заменой констант на поля `pack`. Без DOM, без сети.

- [ ] **Step 4: Прогнать — зелёные**

Run: `node --test test/engine.test.js`
Expected: PASS (все 4 теста)

---

### Task 2: server.js — rev, условная запись, статика, архив

**Files:**
- Modify: `server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Produces: `require('./server.js') -> {makeServer(opts)}` при require; как скрипт — прежнее поведение (`node server.js [порт]`, печать URL). `makeServer({file, archiveDir, html}) -> http.Server`, состояние `{rev, game, players, wall, hypotheses, proposals, statuses}`; `rev` — число, инкремент на каждой применённой записи.
- Протокол `POST /write`: `{col,id,doc,del,expectRev?}` | `{col:'game',doc,expectRev?}` | `{reset:true, archive?}` — `expectRev` не совпал → `409` без изменений; успех → `204`. `reset` с `archive={scenarioId,mode,status,endedSec,burned,at}` и нетривиальным состоянием (`game.startedAt` или непустые wall/hypotheses/proposals/statuses) → файл `archive/<sanitized-at>-<scenarioId||'game'>.json` вида `{summary, state}`. `GET /archive` → JSON-массив сводок (desc); `GET /archive/<file>` → `{summary,state}`; валидация имени `^[\w.-]+\.json$`. Статика: `/engine.js` и `/scenarios/<имя>.js` → `text/javascript`; отсутствующий файл под `/scenarios/` → `404` (не HTML-фолбэк). Хранимый `state.json` без числового `rev` → EMPTY при старте.

- [ ] **Step 1: Написать failing-тесты `test/server.test.js`**

```js
// makeServer({file: tmp/state.json, archiveDir: tmp/archive, html: tmp/war-room.html})
// beforeEach: mkdtemp, записать минимальный war-room.html
test('условная запись: из двух записей с одним expectRev проходит одна', ...)
// rev=0 → write {col:'game',doc:{...g1},expectRev:0} → 204;
// write {col:'game',doc:{...g2},expectRev:0} → 409; state.game = g1.
test('запись без expectRev применяется всегда', ...)
test('reset с archive пишет файл и /archive его отдаёт', ...)
// игра со startedAt → reset+archive → файл существует; GET /archive → 1 элемент
// со сводкой; GET /archive/<file> → {summary,state}, state.game.status совпадает.
test('reset без archive на пустом лобби не пишет файл', ...)
test('/scenarios/*.js отдаётся как javascript, отсутствующий — 404', ...)
// фикстура scenarios/x.js → content-type содержит 'javascript'; /scenarios/nope.js → 404.
```

- [ ] **Step 2: Прогнать — падение**

Run: `node --test test/server.test.js`
Expected: FAIL (`makeServer` не экспортируется)

- [ ] **Step 3: Переписать `server.js`**

Обёртка `makeServer` (все текущие пути — параметры с дефолтами `__dirname`-based), экспорт через `if (require.main === module)`; добавить `rev`/`expectRev`/409, архивацию, эндпоинты архива, раздачу `/scenarios/` и `/engine.js` с allowlist-расширением `.js`. Ответ 409 — без тела, статус только.

- [ ] **Step 4: Прогнать — зелёные + регрессия старта**

Run: `node --test test/server.test.js && node -e "require('./server.js'); console.log('require ok')"`
Expected: PASS; затем вручную: `node server.js 8123` открывает приложение в браузере (проверить один раз, убить процесс).

---

### Task 3: planAutopilot — планировщик автопилота

**Files:**
- Modify: `engine.js`
- Test: `test/engine.test.js` (дополнение)

**Interfaces:**
- Consumes: Task 1 (`gameSec`, `burned`).
- Produces: `planAutopilot(state, pack, now=Date.now(), rng=Math.random) -> null | {patch:object, events:[{msg,sev}]}`. `patch` — мердж в `game` (движок исполнителя делает `{...game,...patch}`), `events` — в ленту. Маркеры идемпотентности — `game.fired = {}` (внутри patch). Паника: patch.panic уже пересчитана с клампом 0–20, patch.panicLog дополнен `{t,delta,why}`.
- Правила (спек §5, значения — из полей пакета):
  - auto-паника каждые `panic.autoEverySec`, тишина `panic.silenceAfterSec` (флаг `silenceFlagAt` как раньше).
  - Звонок: старт в `schedule.cioCall.atSec` (`call={active:true,caller,startedAt:T,ticks:0}`), +1 каждые `panicEverySec` без ответа, таймаут в `durationSec` → `call.active=false, result='timeout'`.
  - Ивенты: каждый `rollsAt[i]` бросается один раз (`rng` инжектится), `fx`: `storm`→`storm:true`; `panic1`→+1; `scout-x2`→`scoutX2:true`; `transient`→`transientUntil=now+transientSec*1000`.
  - Действия: `status:'go'` с `goAt` выполняется в `goAt+cost+(reviewedBy?30:0)` игровых секундах: `status:'done', doneAt:T`; эффект — `mitigation.apply(new Set(game.applied), game)` или дефолт `{add:[id]}`; `trap`→+2; пустой `cards`→+2; ревью-риск без ревью: `d=1+floor(rng()*10)`, `d<=2` → сообщение об ошибке и `sev:'danger'`; стабилизация: mult до/после через `pack.telemetry`, порог `pack.money.stabilizeAtMult`, один раз (`fired.stab`), −3.
  - Концы: `T>=durationSec` без `fired.win` → FAILED (`status, endedSec:T`); паника `>=meltdownAt` на `meltdownHoldSec` → FAILED; `burned>=money.failAt` → FAILED. Окно победы: `telemetry.err<=winErrPct` подряд `winHoldSec` → `fired.win=1` (индикатор, не FAILED-триггер).
  - `status!=='ACTIVE'` → `null`. Нечего делать → `null`.

- [ ] **Step 1: Failing-тесты** (дописать в `test/engine.test.js`)

```js
// autopilotPack — стаб на базе pack из Task 1 + поля schedule/durationSec и т.д.;
// helper: run(state, T, rng) => ENGINE.planAutopilot(state, autopilotPack, base+T*1000, rng||(()=>0.99))
test('пауза: планировщик молчит', ...) // status PAUSED → null
test('звонок стартует в atSec и только один раз', ...) // T=atSec-1 → null; T=atSec → call.active; повторный вызов на T+1 → patch без call
test('звонок: +1 на 45с без ответа, таймаут на durationSec', ...)
test('ивент бросается один раз, fx=panic1 даёт +1, storm ставит флаг', ...)
test('действие: go → done ровно в goAt+cost, эффект в applied', ...) // cost 90: T=89 → null; T=90 → done, applied содержит id
test('ревью +30с: без reviewedBy done на cost, с reviewedBy на cost+30', ...)
test('ловушка +2, вслепую +2, ловушка вслепую +4', ...)
test('стабилизация: −3 один раз при mult<=0.3', ...) // telemetry-стаб: mult 1 → 0 после 'FIX'
test('d10 ревью-риска: rng→0.05 ошибка (d=1), rng→0.99 — нет', ...)
test('FAILED: durationSec без win; meltdown; failAt по деньгам', ...)
test('win: err<=winErrPct подряд winHoldSec → fired.win; после него durationSec не даёт FAILED', ...)
```

- [ ] **Step 2: Прогнать — падение** (`planAutopilot is not a function`)

- [ ] **Step 3: Реализовать `planAutopilot` в `engine.js`**

Сборка одного слитого patch за вызов; события с игровым временем `Math.round(T)`; rng — параметр. Порядок проверок: FAILED-условия первыми, затем остальное.

- [ ] **Step 4: Прогнать — зелёные**

Run: `node --test test/engine.test.js`
Expected: PASS (все, включая Task 1)

---

### Task 4: Пакет «Фантомная сеть»

**Files:**
- Create: `scenarios/phantom-network.js`
- Test: `test/packs.test.js`

**Interfaces:**
- Produces: `scenarios/phantom-network.js` вызывает глобальную `SCENARIO(obj)` с пакетом: `id:'phantom-network'`, `title:'Фантомная сеть'`, `version:'3.1'`, `slot:'связка order-service → payment-proxy, слот 60 минут'`; `durationSec:1320`, `winHoldSec:90`, `winErrPct:5`, `money:{basePerMin:150000, failAt:10000000, stabilizeAtMult:0.3}`; `panic` — тиры из текущего `PANIC_TIERS`, `autoEverySec:240`, `silenceAfterSec:300`, `meltdownAt:20`, `meltdownHoldSec:120`; `schedule.cioCall:{atSec:240, durationSec:180, panicEverySec:45, caller:'Александр (CIO)', lines:[7 реплик из phantom-network-asymmetric.md §7]}`; `schedule.worldEvents:{rollsAt:[420,900], table:[null+10 записей]}` = текущий `WORLD_EVENTS`; `roles`, `roleOrder`, `startScreens`, `artifacts` (все S*/P*/D*/C* с телами, ценами, ключами, decoy, followUp у C4), `mitigations` (все M-*/T-* с `hint`), `telemetry` = текущая `resolveTelemetry` (включая чтение `transientUntil`, `cleared`, `storm`), `apply`-хуки: M-P3/M-P4 (флаг → `cleared:true`, иначе `transientSec:30`), M-P0 (`remove` последнего platform-действия из applied), T-ROLL (`transientSec:30`), `cheatsheet` = `GM_CHEATSHEET`. `hints`/`trainingOverrides` отсутствуют.
- Test-хелпер `test/packs.test.js`: `global.SCENARIO=(o)=>PACKS.push(o); require('../scenarios/phantom-network.js')` (и далее все паки).

- [ ] **Step 1: Написать `test/packs.test.js`**

```js
test('пак well-formed: обязательные поля, уникальные id, роли существуют, ключи K\\d+', ...)
test('phantom: инцидент err 92; M-P1+M-D2+M-P3 → err 2, mult 0', ...)
// telemetry({applied:[],status:'ACTIVE',...}) → err 92, mult 1
// telemetry({applied:['M-P1','M-D2','M-P3'],cleared:true,...}) → err 2, mult 0
```

- [ ] **Step 2: Прогнать — падение** (файла нет / PACKS пуст)

- [ ] **Step 3: Написать `scenarios/phantom-network.js`**

Механический перенос контента из `war-room.html` в объект пакета; `apply`-хуки — императивные функции по спек §3. Никакой логики сверх перенесённой.

- [ ] **Step 4: Прогнать — зелёные**

Run: `node --test test/packs.test.js`
Expected: PASS

---

### Task 5: Пакет «Просроченный сертификат»

**Files:**
- Create: `scenarios/expired-cert.js`
- Test: `test/packs.test.js` (дополнение)

**Interfaces:**
- Produces: пакет `id:'expired-cert'` по `expired-certificate-training.md`: `durationSec:720`, `winHoldSec:60`, `money:{basePerMin:150000, failAt:3000000, stabilizeAtMult:0.3}`; тиры паники: 0–4 mult 1, 5–9 mult 2 cost 1.5, 10–14 mult 4 cost 1.5, 15–18 mult 4, 19–20 mult 4 (документ §5: у учебного 5–9 уже ×2 — отличие от основного пакета сознательно); `autoEverySec:180`, `silenceAfterSec:240`, `meltdownAt:20`, `meltdownHoldSec:90`; `cioCall:{atSec:120, durationSec:90, panicEverySec:30, caller:'Александр (CIO)', lines:[5 реплик §6]}`; `worldEvents:{rollsAt:[360], table:[null, 5 ивентов §7, null×4]}` (fx по документу); артефакты S1–S4+S5-decoy, P1–P4+P5-decoy, D1–D3+D4-decoy, C1–C4+C5-decoy с телами и ценами из §3; действия M-P1 (cost 90, review, `hint` из §4.1), M-P2 (45, review), T-ROLL/T-RESTART/T-INSECURE/T-SCALE (`trap:true`, цены 60/60/30/45); `telemetry` по таблице §4.2: база err 7/rps 2000/mult 1; M-P1 → err 99, mult 0; M-P2 → err 95, mult 0, label с «оговоркой»; ловушки — без изменений err; `hints` по ролям из эталона §8 (по 4–6 пунктов); `cheatsheet` — цепочка причины и правила паники из §2/§5.

- [ ] **Step 1: Дописать тесты**

```js
test('cert: инцидент err 7; M-P1 → err 99 mult 0; M-P2 → err 95; T-ROLL не меняет err', ...)
test('каждый пак из PACKS проходит well-formed и telemetry-smoke', ...) // общий цикл
```

- [ ] **Step 2: Прогнать — падение**

- [ ] **Step 3: Написать `scenarios/expired-cert.js`**

Контент — из GM-документа, тела артефактов — дословные тексты из §3 (включая вывод openssl в P2).

- [ ] **Step 4: Прогнать — зелёные**

Run: `node --test`
Expected: PASS (все три файла тестов)

---

### Task 6: war-room.html — реестр пакетов, rev в store, удаление хардкода

**Files:**
- Modify: `war-room.html`
- Modify: `index`-порядок скриптов: `<script src="engine.js">`, `<script src="scenarios/phantom-network.js">`, `<script src="scenarios/expired-cert.js">` перед основным скриптом.

**Interfaces:**
- Produces: глобалы `SCENARIO(obj)`, `SCENARIOS: Map<id,pack>`, `activePack() -> pack` (по `S.g.scenarioId`, дефолт — первый зарегистрированный). `store.write(op)` добавляет `expectRev: STATE.rev` в http-режиме; при ответе 409 — rejected promise с `{code:409}` (без toast, решение принимает вызывающий). `startIncident(scenarioId, mode)` — параметризован пакетом; `game` обретает `scenarioId`, `mode`, `fired:{}`. Локальные определения `gameSec/burned/tierOf/currentRate/PANIC_TIERS/BASE_RATE/resolveTelemetry` удаляются — вместо них `ENGINE.*` и `activePack().telemetry(...)`; `ROLES/START_SCREENS/ARTIFACTS/MIT/WORLD_EVENTS/CIO_LINES/GM_CHEATSHEET` удаляются — вместо них поля пакета (`ART`/`MIT` строятся из `activePack()`). Рендер подписывается на поля пакета (заголовок проектора, шпаргалка GM, роли в пикере).

- [ ] **Step 1: Подключить скрипты и поднять реестр**

Теги в `<head>` конца `<body>` перед основным `<script>`; `SCENARIO` пушит в `SCENARIOS`, дублирующийся `id` — ошибка в консоль.

- [ ] **Step 2: store с expectRev**

`store.write`: http-ветка добавляет `expectRev: STATE.rev`; не-ок ответ: если 409 → `throw {code:409}`, иначе toast как раньше. `S.rev` обновляется из `STATE.rev` в `apply`.

- [ ] **Step 3: Параметризовать движок**

Удалить перенесённые в `engine.js`/пакеты определения; заменить обращения; `costMult()` — через `tierOf(g.panic||0, activePack().panic.tiers).cost`; `requestArtifact` — список из `activePack().artifacts`, `scoutX2`-флаг: если `g.scoutX2` и роль scout — цена ×2 и сброс флага в той же записи. В GM-вью interim-`<select>` пакета + переключатель режима перед «Start Incident» (карточки лобби — Task 7).

- [ ] **Step 4: Ручная проверка обоих режимов запуска**

http: `node server.js 8123` → `#gm` → старт «Просроченный сертификат» → `#play/scout` видит стартовый экран и меню S*; `#projector` рисует графики из пакета. file://: открыть файл → лобби/пульт работают, в консоли оба пакета зарегистрированы, `SCENARIOS.size===2`.

- [ ] **Step 5: Регрессия автотестов**

Run: `node --test`
Expected: PASS (без изменений против Task 5)

---

### Task 7: Лобби с выбором кейса

**Files:**
- Modify: `war-room.html`

**Interfaces:**
- Produces: карточки пакетов на home и в GM-вью (LOBBY): название, версия, `slot`, радио-выбор; переключатель режима «стандартный/учебный»; выбор живёт в `S.lobbySel={scenarioId, mode}` и подсвечивается на проекторе (название кейса + плашка режима в LOBBY-оверлее). `startIncident` берёт `S.lobbySel`; reset очищает `game.scenarioId`, выбор в лобби сохраняется для реванша.

- [ ] **Step 1: Разметка карточек**

Home: сетка карточек поверх существующих трёх больших ссылок; GM (LOBBY): тот же блок + кнопка старта.

- [ ] **Step 2: Проектор LOBBY**

В оверлей подключения — имя выбранного кейса, режим, пилюли ролей (уже есть).

- [ ] **Step 3: Ручная проверка**

Оба пакета переключаются, старт берёт правильный пакет (проверить по шпаргалке GM и стартовым экранам), reset возвращает в лобби.

---

### Task 8: Исполнитель автопилота

**Files:**
- Modify: `war-room.html`

**Interfaces:**
- Consumes: Task 3 (`planAutopilot`), Task 6 (`store.write` с 409).
- Produces: `runAutopilot()` — вызывается из `tick()` на вью `#gm` и `#projector`: `const plan = ENGINE.planAutopilot(STATE, activePack(), Date.now()); if(!plan) return; const g={...G(),...plan.patch}; if(plan.events.length) g.events=[...(g.events||[]),...plan.events.map(e=>({t:Math.round(ENGINE.gameSec(g,Date.now())),...e}))].slice(-150); store.write({col:'game',doc:g,expectRev:STATE.rev}).catch(e=>{if(!e||e.code!==409)toast(...)})`. Функция `gmAuto` и её вызов удалены; `startCall`/`rollEvent` остаются как ручной override (не помечают слоты `fired` — автобросок слота придёт позже и сработает, если GM не отменит; задокументировать в подписи кнопки). Индикатор победы: при `g.fired.win` на пульте и проекторе бейдж «условия победы выполнены — ждём Resolved от IC».

- [ ] **Step 1: Реализовать runAutopilot и удалить gmAuto**

Перенос логики событий ленты из `gmWrite` (маркировка времени игры) в общий хелпер `withEvents(g, events)`.

- [ ] **Step 2: Ручной прогон «Просроченного сертификата» (http, пульт + проектор + scout на второй вкладке)**

Звонок сам стартует на 2:00; d10 сам на 6:00; M-P1 после «Go» применяется сам через 90 с (паника/деньги по документу: −3 стабилизация, потери обнуляются); до 12:00 — стоп и FAILED, если не Resolved. Проектор открыт одновременно с пультом — эффекты не дублируются (одна запись в ленте).

- [ ] **Step 3: Ручной прогон «Фантомной сети» — расписание 4:00/7:00/15:00, M-D2→M-P3 даёт стабилизацию, T-POOL +2.**

- [ ] **Step 4: Автотесты**

Run: `node --test`
Expected: PASS

---

### Task 9: Учебный режим

**Files:**
- Modify: `war-room.html`

**Interfaces:**
- Produces: `effectivePack(pack, game)` — при `game.mode==='training'` мерджит `trainingOverrides` (глубокий мердж только `panic.*`); точки использования: `runAutopilot`, `currentRate`/`costMult`, рендер. Вкладка «Подсказки» у роли (training && `pack.hints[role]`): пункты чек-листа, текущий — первый по счётчикам (`received.length`, пины роли на стене, предложения роли); плашка «УЧЕБНЫЙ РЕЖИМ» на пульте и проекторе; лобби-переключатель (Task 7) уже передаёт `mode`.

- [ ] **Step 1: effectivePack + использование в автопилоте/экономике**

- [ ] **Step 2: Вкладка «Подсказки» и плашки**

- [ ] **Step 3: Ручная проверка**

Старт cert в учебном режиме: у scout вкладка с 4–6 пунктами, текущий подсвечен; авто-паника реже (360 с); плашки видны.

---

### Task 10: Архив и история игр

**Files:**
- Modify: `war-room.html`

**Interfaces:**
- Produces: `buildReport(state, pack)` и `buildFeed(state)` — чистые (принимают состояние, не глобалы). `resetAll`: сводка `{scenarioId, mode, status, endedSec, burned: ENGINE.burned(G()), at: new Date().toISOString()}` → `store.write({reset:true, archive:summary})`. «История игр» на home и пульте (только http): `fetch('/archive')` → список; клик → `fetch('/archive/'+file)` → read-only таймлайн + кнопки «Постмортем .md» (Blob из архивного состояния) и «Играть снова» (в лобби с этим пакетом). file://: секция скрыта.

- [ ] **Step 1: Чистые buildFeed/buildReport + правка экспорта**

- [ ] **Step 2: resetAll с архивацией**

- [ ] **Step 3: UI истории**

- [ ] **Step 4: Ручная проверка (Review Focus #4)**

Доиграть cert до Resolved → reset → файл в `archive/`, игра в «Истории», таймлайн совпадает, `.md` скачивается; то же с прерванной ACTIVE-игрой.

---

### Task 11: Финальная сверка

**Files:**
- Modify: при расхождениях — правки по результатам сверки.

**Interfaces:**
- Produces: отчёт о прогонах по критериям приёмки спека §11.

- [ ] **Step 1: Полный прогон автотестов**

Run: `node --test`
Expected: PASS

- [ ] **Step 2: Сверка пакетов с GM-документами**

Чек-лист: цены каждого артефакта (S/P/D/C-таблицы §3 обоих документов), ключи улик, пороги FAILED (10 млн/3 млн, 22/12 мин, паника 20×120 с/90 с), расписание (240/420/900 и 120/360), таблицы телеметрии (4.2 обоих документов). Расхождения — править пакет, не документ.

- [ ] **Step 3: Sweep `war-room.html`**

Grep: ни одной строки контента пакетов вне `scenarios/` (проверочные образцы: «HikariPool», «acq-gw», «renew-certs», «fallback_acquirer» — все только в `scenarios/`); нет ссылок на удалённые глобалы (`gmAuto`, `PANIC_TIERS`).

- [ ] **Step 4: Два полных ручных прогона**

По сценариям спека §11 п.2–3, включая учебный режим и file://-режим.
