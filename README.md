# VMGauge

Живые показатели автомобиля на головном экране BMW MGU (iDrive 7) — буст, температуры,
давление масла, лямбда, детонация/пропуски, бортовая сеть, раздатка и лаг-таймер.

Данные читаются напрямую с машины: SOME/IP-сигналы (CDS / Vehicle2 / FES) и UDS-запросы
DID к DME, КПП и раздатке. Масштабирование и список DID-кандидатов — в `apps/vmgauge/app.json`
(`config.dme`, `config.scaling`): кандидаты перебираются по порядку, первое правдоподобное
значение попадает на плитку, сырые ответы пишутся в лог для калибровки.

## Вкладки

| Вкладка | Что показывает |
|---|---|
| **MAIN** | сетка 4×3: буст, лямбда, давление масла, впуск, EGT, t° ОЖ/масла/КПП, напряжение, knock/misfire |
| **POWER** | мощность и момент (текущие + пики) с графиком |
| **HPFP** | давление в топливной рампе: факт / запрос |
| **IGN** | угол опережения, коррекция по детонации, лямбда, адаптация смеси |
| **FUEL/COOL** | t° топлива, термостат, вентилятор, радиатор, EGT, впуск |
| **ELEC** | напряжение, t° генератора, нагрузка, ток |
| **TCASE** | блокировка раздатки xDrive |
| **LAP** | лаг-таймер: 0-100 / 0-200 / 100-200, live-метрики и максимумы |
| **MORE** | boost-шкала с пиком, детект коррекций КПП, логи CSV |

## Сборка

```sh
python3 kit/tools/build.py vmgauge          # -> dist/vmgauge@<version>.mgu
python3 kit/tools/make_kit.py vmgauge       # -> dist/mgu-custom-apps.tar.gz (кит для машины)
```

## Установка

Windows (root SSH к головному устройству через ENET, ключ из idrive7-8-ssh-root):

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\deploy\push-to-car.ps1 install -Key <путь-к-id_rsa> -Ip <IP-головки>
```

Либо через **mgu-store**: Store → Settings → Add source → `daniloz095/vmgauge` (Releases).

## Калибровка DID

Не все DID подтверждены на конкретной машине. Причина отказа видна в логе приложения
(`data/vmgauge.log`, строки `DID <metric>: <причина>`). Список «что пробовать» — в
`CALIBRATION.md`.

## Атрибуция

Собрано на фреймворке **idrive7-apps** (kit) — https://github.com/cauliflowermossgrape/idrive7-apps.
SDK (`oap-sdk`) — проприетарный код BMW, извлекается с собственного головного устройства
(`kit/tools/extract_sdk.js`) и в репозиторий не коммитится.
