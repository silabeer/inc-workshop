# Холл-режим v1.1: одна команда + роли + диаграммы — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** переделать холл-режим с дуэли команд на одну команду с ролями (по-русски) и добавить ручные диаграммы архитектуры в каждый кейс.

**Architecture:** движок упрощается (одна команда, нет чередования и победителя, валидация ролей и диаграмм); паки обрастают `roles`/`role`/`roleTask`/`diagram`; UI перекладывается под бейдж роли, командный счёт с ловушками и SVG-панель диаграммы.

**Tech Stack:** vanilla JS, node:test, без зависимостей.

**Spec:** `docs/superpowers/specs/2026-10-07-hall-mode-design.md` (v1.1 — binding).

## Global Constraints

- Git-репозитория нет — коммитов нет; верификация только `node --test --test-force-exit`.
- Тесты: `node:test` + `node:assert/strict`, имена на русском.
- `hall-engine.js` — UMD (глобал `HALL_ENGINE` / `module.exports`), как в `engine.js:3-6`.
- Сценарии — plain-скрипы без ES-модулей; регистрация через `HALL_SCENARIO(obj)`; в браузере коллектор определяет hall.html, в тестах — стаб.
- Весь UI-текст и имена ролей — только на русском.
- Очки: +2/+1/0/−1; «ловушки» = выборы с score < 0. Tension: старт 50, кламп 0–100.
- Роли кейса: commander «Командир инцидента», scout «Скаут наблюдаемости», platform «Инженер платформы», domain «Доменный специалист», comms «Связной». Все пять обязаны вести шаги в каждом кейсе.
- НЕ изменять: `war-room.html`, `server.js`, `engine.js`, `scenarios/phantom-network.js`, `scenarios/expired-cert.js`.

## Review Focus

1. `choose` после `ENDED` → исключение — тест в Task 1.
2. Tension кламп 0–100 — тест в Task 1.
3. Узел с неизвестной ролью / без роли / без `roleTask` → `validate` ловит — тест в Task 1.
4. Диаграмма: дубли id, ребро в никуда, нечисловые координаты, отсутствие диаграммы → `validate` ловит — тест в Task 1; оба пакета с диаграммами — Task 2.
5. В кейсе не все пять ролей ведут шаги → pack-тест падает — Task 2.

---

### Task 1: hall-engine.js — переход на одну команду + валидация ролей и диаграмм

**Files:**
- Modify: `hall-engine.js`
- Test: `test/hall-engine.test.js` (переписать)

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `validate(scn) → string[]` — все проверки v1.0 плюс: `нет блока roles`; у не-`end` узла нет/неизвестная `role` (`узел X: неизвестная роль Y` / `узел X: не указана роль`); пустой `roleTask`; нет `diagram`/`diagram.nodes` пустые; дубли id в `diagram.nodes`; ребро `A → B` с несуществующим концом; нечисловые `x`/`y`.
  - `createGame(scn, opts?) → state`: `opts.team?: string` (дефолт «Команда зала»). state: `{scenarioId, nodeId, team, score: 0, tension: 50, log: [], status: 'ACTIVE'}`; log-запись `{nodeId, choiceId, gained, tension}`.
  - `choose(state, choiceId) → {state, result}`; result `{choice, gained, tension}`; score растёт в одном счёте; `ENDED` без победителя; те же исключения; `_scn` неперечислим.

- [ ] **Step 1: Переписать `test/hall-engine.test.js` под v1.1**

Фикстура: 3 узла (старт 2 варианта → промежуточный → end) + блок `roles` (все 5 ролей) + `diagram` (3 узла, 2 ребра). Тесты:
- `validate(FIX)` → `[]`; битый `goto`; нет `start`; 1 вариант; недостижимый `end` (пережитки v1.0 — поведение не меняется).
- `validate`: нет блока `roles`; узел с неизвестной ролью; узел без `role`; пустой `roleTask`; без `diagram`; дубль id в `diagram.nodes`; ребро в никуда; `x` строкой.
- `createGame` → `team 'Команда зала'`, `score 0`, `tension 50`, `status 'ACTIVE'`; с `opts.team` — своё имя.
- `choose` → `score` растёт одним числом (два хода подряд: 2 + 1 = 3), `status` меняется, tension двигается.
- Иммутабельность входного state.
- Неизвестный `choiceId` → throws; `ENDED` → throws.
- Кламп: −100 и +200 → 0 и 100.
- Проход до `end` → `status 'ENDED'`, в state нет поля `winner`.

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `node --test --test-force-exit test/hall-engine.test.js`
Expected: FAIL (старый движок: state со `scores`/`turn`/`winner`, валидации ролей нет).

- [ ] **Step 3: Переписать `hall-engine.js`**

state v1.1, `choose` без чередования, `winner` убрать; `validate` — новые проверки ролей и диаграммы (с сообщениями из Produces).

- [ ] **Step 4: Прогнать — зелёно**

Run: `node --test --test-force-exit test/hall-engine.test.js`
Expected: PASS.

### Task 2: паки — roles, roleTask, диаграммы

**Files:**
- Modify: `scenarios/hall-phantom-network.js`
- Modify: `scenarios/hall-expired-cert.js`
- Modify: `test/hall-packs.test.js`

**Interfaces:**
- Consumes: `HALL_ENGINE.validate` (Task 1).
- Produces: паки с `roles` (5 ролей, русские имена по Global Constraints), `diagram`, тегами `role`/`roleTask` на каждом не-`end` узле; Task 3 читает `diagram` и `roles` в UI.

- [ ] **Step 1: Обновить `test/hall-packs.test.js`**

- оба пакета → `validate` пусто;
- прохождение первым вариантом до `end` → `ENDED`, сумма `log[].gained` == `score`;
- множество ролей не-`end` узлов == множеству ключей `roles` (все пять в деле).

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `node --test --test-force-exit test/hall-packs.test.js`
Expected: FAIL (паки без roles/diagram — validate вернёт ошибки).

- [ ] **Step 3: Дописать `scenarios/hall-phantom-network.js`**

`roles` — пять ролей, имена/короткие/описания из `scenarios/phantom-network.js` (roles там, перевести имена). `diagram` (viewBox 640×320, руками): клиенты 5.8 → edge-gateway(RED, «5xx 92%») → order-service(RED, «CrashLoop 137»); order-service → pgbouncer(YELLOW, «cl_waiting 70») → postgres; order-service → payment-proxy(серый, «48 in-flight висят») → acq-gw(RED, «молчит: нет FIN/RST»); nspk — маленький узел около proxy (GREEN, «200 за 90 мс»). Теги `role`: p1 commander, p2 scout, p3 platform, p4 domain, p5 platform, p6 comms, p7 scout, p8 comms, p9 commander, p10 commander. `roleTask` — по 1–2 предложения из `hints` исходного пака под каждый шаг.

- [ ] **Step 4: Прогнать — упадёт на cert-паке**

Run: `node --test --test-force-exit test/hall-packs.test.js`
Expected: FAIL (cert-пак ещё без roles/diagram).

- [ ] **Step 5: Дописать `scenarios/hall-expired-cert.js`**

`roles` — аналогично (из `scenarios/expired-cert.js`). `diagram`: приложение 6.2(pinning) → edge-nginx(RED, «серт истёк 12:00:00») → api-service(GREEN) → postgresql(GREEN); отдельный пунктирный узел renew-certs.sh (GRAY, «cron отключён 7 дней») → edge. Теги `role`: c1 commander, c2 scout, c3 domain, c4 platform, c5 comms, c6 comms, c7 commander, c8 commander. `roleTask` — из hints пака.

- [ ] **Step 6: Прогнать — зелёно**

Run: `node --test --test-force-exit test/hall-packs.test.js`
Expected: PASS.

### Task 3: hall.html — одна команда, бейдж роли, диаграмма

**Files:**
- Modify: `hall.html`
- Test: `test/hall-ui.test.js`

**Interfaces:**
- Consumes: state v1.1 (`team`, `score`, без `winner`), `scn.roles`, `scn.diagram` (Task 2).

- [ ] **Step 1: Дописать failing-тесты в `test/hall-ui.test.js`**

- html содержит `createElementNS` (SVG-рендер диаграммы) и строку `'diagram'`;
- html НЕ содержит `nameB` (второе поле команды ушло);
- html не содержит `'winner'` (вердикт победителя ушёл).

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `node --test --test-force-exit test/hall-ui.test.js`
Expected: FAIL (текущий html — дуэльный).

- [ ] **Step 3: Переложить `hall.html`**

Лобби: карточки кейсов (title + brief + мини-диаграмма, масштабированная копия SVG), одно поле имени команды. Игровой экран: бейдж «Шаг: <roles[role].name>»; счёт одной команды + счётчик ловушек (`log` gained<0); tension-полоса; карточка узла; варианты 1–4; **панель диаграммы справа** — `renderDiagram(scn)` строит SVG (viewBox 0 0 640 320): прямоугольники по `x,y` (130×44, скруглённые, заливка по `color`: red/yellow/green/gray), подпись `label` и мелко `note`, линии-рёбра со стрелками (marker) и подписью `label`; в углу мелко `say` и `roleTask`. Последствия: outcome, «+N очков», дельта tension, hint. Финал: текст end-узла + метрики (очки, ловушки, напряжение) + «Заново». Клавиши: 1–4, Enter/→, R с guard на INPUT/TEXTAREA.

- [ ] **Step 4: Прогнать — зелёно**

Run: `node --test --test-force-exit test/hall-ui.test.js`
Expected: PASS.

### Task 4: финальная сверка

**Files:**
- Modify: нет.

- [ ] **Step 1: Полный прогон**

Run: `node --test --test-force-exit`
Expected: все зелёные (обновлённые hall-* + 31 старый).
- [ ] **Step 2: Проверка границ**

`war-room.html`, `server.js`, `engine.js`, исходные паки без изменений; stray-файлов нет.
- [ ] **Step 3: Ручная демо-проверка (пользователь)**

Открыть `hall.html` двойным кликом: оба кейса до конца, диаграмма и бейджи ролей видны, клавиатура работает.
