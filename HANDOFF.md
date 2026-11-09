# Handoff: портирование VMGauge на фреймворк idrive7-apps

## Цель

Довести порт приложения **VMGauge** (BMW MGU / iDrive 7: буст, температуры, давление масла,
лямбда, детонация/пропуски, электрика, раздатка, лап-таймер) на фреймворк **idrive7-apps** до
полного паритета с оригиналом и починить то, что падает.

**Ключевое требование (от пользователя):** там, где у нас что-то падает, но работает в эталонном
приложении `car_vitals` (M Vitals), — **копировать логику оттуда** (DID-кандидаты, обработку
сигналов, масштабирование, приёмы работы с kit). Наша целевая логика (математика, раскладка
вкладок, DID-таблицы) — в оригинальном `main.js`/`app.json`, её переносить 1:1.

## Контекст / что выяснено

- Проект «VMG-Utility»: `D:\Code\VMG-Utility`. Оригинал `apps/vmgauge/` (`main.js` ~3500 строк, `app.json`).
- Оригинал собран на **неверном** рантайме (`require('os')`, `require('signals')`, `require('settings')`,
  `require('diagnostic')`, `require('log')` через шимы + самодельный `build.py`) — на реальном MGU это не работает.
- Правильный рантайм — **idrive7-apps «kit»**: `mgu.run({ async start(ctx) {...} })`, доступ к машине через
  `require('oap-sdk')` → `OnlineApp`, `ctx.ui/settings/log/signals/canvas/loop/theme`.
- На машине пользователя уже стоят рабочие приложения этого фреймворка: `car_vitals`, `live_data`,
  `redline`, `draggy`, `gforce`, `zf8hp` и др. `car_vitals` — эталон, с него копируем.

## Расположение файлов

- Фреймворк (склонирован): `C:\Users\dmpol\AppData\Local\Temp\opencode\idrive7-apps`
  - `apps/car_vitals/` — эталон (app.json + main.js + demo.js + icon.png).
  - `apps/vmgauge/` — НАШЕ портированное приложение (app.json + main.js) — редактируем только его.
  - `kit/runtime/` — kit: `mgu.js`, `canvas.js`, `car.js`, `diag.js`, `dids.js`, `gauges.js`, `signals.js`,
    `engine.js`, `themes.js`, `display.js`, `i18n.js`.
  - `kit/tools/build.py` (сборка), `kit/tools/make_kit.py` (упаковка кита), `deploy/push-to-car.ps1` +
    `deploy/mgu-app-install.sh` (деплой).
  - `oap-sdk/` — BMW SDK (извлечён из `car_vitals.tgz`).
- Оригинал для копирования логики: `D:\Code\VMG-Utility\apps\vmgauge\main.js` и `app.json`.

## Что уже сделано и работает

1. `oap-sdk` скопирован в `idrive7-apps/oap-sdk/` (из `car_vitals.tgz` → `node_modules/oap-sdk/{index.js,package.json}`).
2. `apps/vmgauge/app.json` — в формате idrive7-apps: наш `config` (scaling + dme + elec + tcase, 28 метрик),
   сигналы CDS/Vehicle2/FES + **`com.harman...tasu...InternalTasu`** (обязателен для UDS!), настройки (`toggle`→`bool`).
3. `apps/vmgauge/main.js` — портирована вкладка MAIN: `Car` (сигналы rpm/coolant/oil/speed) +
   `Diag`/`DidReader` (UDS: oilPressAbs, boost, baro, iat, egt, lambda).
4. Сборка проходит: `python kit/tools/build.py vmgauge` → `dist/vmgauge@0.1.1.mgu`.
5. Деплой работает (см. команды ниже). Приложение на машине: uid **12450**, `PREINSTALLED`, `/var/opt/public/oap/oap_12450/`.

## Статус на машине (что падает — это и чинить)

- ✅ **rpm, coolant, oil temp** — показываются (сигналы через `Car` работают).
- ✅ **intake (IAT)** — показывает (DID `580F` работает, TASU-канал UDS живой).
- ⚠️ **boost / baro** — переведены на OBD-кандидаты `car_vitals` (`F470`/`F487`/`F40B`/`0B` и `F433`/`33`); должны
  заработать после перезагрузки HU (не подтверждено пользователем).
- ❌ **lambda** (`5889`/`5640`/`24`) и **oil pressure** (`586F`/`4436`) — `--`; `car_vitals` их **не читает**, т.е.
  наши DID неверны для этой машины (B58). Нужно найти верные DID или понять, что метрики недоступны.
- ❌ **Пустой экран после переустановки**: в логе `openEntryState failed ... INVALID_UUID` — известная особенность
  kit при перезаливке; лечится полной перезагрузкой HU (`ssh ... "reboot"`), не пересборкой.

## Команды (Windows PowerShell)

```powershell
cd C:\Users\dmpol\AppData\Local\Temp\opencode\idrive7-apps

# сборка
python kit/tools/build.py vmgauge

# упаковка кита (на вопрос про renderer ответить y; пайпом — продолжить)
"y" | python kit/tools/make_kit.py vmgauge

# деплой на машину
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\deploy\push-to-car.ps1 install -Key "C:\Users\dmpol\Downloads\MGU-SSH\data\enrollments\WBA6K71050FJ55634\id_rsa" -Ip 169.254.102.111

# лог приложения на машине (диагностика DID и ошибок)
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -i "C:\Users\dmpol\Downloads\MGU-SSH\data\enrollments\WBA6K71050FJ55634\id_rsa" root@169.254.102.111 "cat /var/opt/public/oap/oap_12450/data/vmgauge.log | tail -40"

# перезагрузка HU (при INVALID_UUID / пустом экране после перезаливки)
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -i "C:\Users\dmpol\Downloads\MGU-SSH\data\enrollments\WBA6K71050FJ55634\id_rsa" root@169.254.102.111 "reboot"
```

- IP машины: **`169.254.102.111`** (MGU IP из `ssh_enable`; gateway `169.254.111.73` НЕ использовать).
- Ключ root: `C:\Users\dmpol\Downloads\MGU-SSH\data\enrollments\WBA6K71050FJ55634\id_rsa`.
- После `reboot` SSH может слететь — заново `ssh_enable enable` (gateway 169.254.111.73, `--persist`).

## Краткий API kit (чтобы не переучивать)

- Точка входа: `mgu.run({ async start(ctx) { ... } })`.
- `ctx` = `{ app, ui, settings, log, spec, dataDir, display, widget, signals, theme(), canvas(w,h), loop(state,fps,fn), onTab, onTap, onScroll, onLayout, controller, sheet }`.
- `ctx.spec.config.dme` — наши DID-таблицы; `ctx.spec.config.scaling` — масштабирование сигналов.
- Канвас: `ctx.canvas(W,H).clear(t.bg)`; методы `cv.text(str,x,y,size,color,{font:'num'|'bold'|'label',align,spacing})` (y — базовая линия), `cv.roundRect`, `cv.fillRect`, `cv.strokeRoundRect`, `cv.arc`, `cv.line`, `cv.polyline`, `cv.rampRect`, `cv.card`, `cv.circle`.
- Цвета `ctx.theme()`: `bg, text, dim, panelTop, panelBottom, panelEdge, accent, accent2, warn, crit, cold, ok, track, tick, oil, bar, hang, sel, marker, glow, ramp, hotRamp` (НЕТ `tile`!).
- Рендер: `ctx.loop('MAIN', fps, render)`, где `render()` возвращает `ui.image('MAIN_GFX', cv)`.
- Сигналы: `const car = new Car(ctx, ['rpm','speed','temps','torque'])`; `car.data()` → `{ rpm, speed, coolant, oil, gear, torque, demo }`; `car.onSample(fn)`; `car.setRedline(rpm)`.
- UDS: `const dme = Object.assign({ ecu: 18 }, ctx.spec.config.dme)`; `const link = new Diag(ctx.signals, ctx.log)`; `link.init()` (async); `const rd = new DidReader(link, { ecu: dme.ecu })`; `await rd.value('metric', dme.metric)`.
- Кандидат DID: `{ ecu, did:'580F', bytes, at, factor, offset, min, max, signed, obd:'0F' }` — наш `config.dme` уже в этом формате.
- **Опрос DME делать последовательно** (не `setInterval` на 300 мс): каждый DID-запрос до 4 с таймаута, накладывающиеся запросы «залипают».
- `car_vitals` логирует raw: `const c = (dme[x]||[])[rd.pick[x]||0]; const r = c && rd.raws[rd.key(c)]; logRaw(x, r.bytes || r.why)` — взять этот приём для диагностики.

## Требуемые исправления (продолжить с этого)

1. **lambda и oil pressure** — выяснить верные DID. Сначала лог (`DID lambda: ...`, `DID oilPressAbs: ...`) — там причина (`NRC 31 out of range` / `no reply` / `reply too short`). Сравнить с `car_vitals` (он их не читает). Если на B58 этих данных нет по UDS — либо найти верный DID, либо заменить метрику на то, что `car_vitals` читает (fuel pressure, ignition advance и т.п.).
2. **Перенести остальные вкладки** из оригинального `main.js`: POWER, HPFP, IGNITION, FUEL/COOL, ELEC, TCASE, LAP, MORE (boost gauge, gear correction, exhaust flap, logs, profiles). Логику расчётов копировать 1:1 из оригинала (там уже исправлены баги):
   - мощность: `kw = tq*rpm*2π/60/1000`; `hp = kw*1.35962` (PS);
   - передача: `ratio = rpm/(spd*1000/60/GEAR_WHEEL_KM)/GEAR_FINAL` (GEAR_WHEEL_KM=2.05 м);
   - наддув относительный: `(boost − baro)/100` (оба в kPa);
   - давление масла: `oilPressAbs − baro/100` (abs в bar, baro в kPa);
   - прочие расчёты (alternator load %, tcase lock %, load fraction, knock/misfire счётчики) — как в оригинале.
3. **Расширить опрос DME** до полного набора `config.dme` (fuelPresAct/Req, knockRetard, loadDirect, ignAdv,
   fuelTemp, thermoPos, fanRpm, radTemp, gearbox, voltage, battCurrent, aluIst, aluTemp, tcClutchRaw, misfire).
4. **Где падает, а в `car_vitals` работает — брать оттуда**: DID-кандидаты (`boost`, `baro`, `iat`, `egt`,
   `fuelPresAct`, `fuelPresReq`, `ignAdv` у `car_vitals` проверенные — см. `apps/car_vitals/app.json` → `config.dme`),
   масштабирование (`config.scaling`), приёмы работы с `Diag`/`DidReader` (выбор кандидата, лог raw, обработка NRC).

## Правила

- Редактировать только `apps/vmgauge/` (наше). НЕ трогать `apps/car_vitals/`, `kit/`, `oap-sdk/`, `deploy/`.
- Каждый шаг проверять: `node --check apps/vmgauge/main.js` + `python kit/tools/build.py vmgauge`.
- Деплой для проверки на машине: `make_kit.py` + `push-to-car.ps1 install` (+ `reboot` HU при `INVALID_UUID`).
- Переносить оригинальную логику 1:1; где расходится с реальной машиной — сверяться с `car_vitals`.
