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

## Сборка (локально)

Сборка нуждается в **`oap-sdk`** — это проприетарный код BMW, поэтому его **нет в репозитории**
и его **нельзя публиковать**. Он извлекается один раз с вашего собственного головного устройства:

```sh
# 1) скопировать приложение-донор (x_call — есть на любой MGU):
scp root@<IP>:'/usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz' .
mkdir x_call && tar xzf x_call@*.tgz -C x_call

# 2) извлечь SDK в ./oap-sdk/:
node kit/tools/extract_sdk.js x_call/javascript/app.js

# 3) собрать:
python3 kit/tools/build.py vmgauge        # -> dist/vmgauge@<version>.mgu
python3 kit/tools/make_kit.py vmgauge     # -> dist/mgu-custom-apps.tar.gz
```

`oap-sdk/` и `dist/` в `.gitignore` — собранные артефакты и SDK никогда не коммитятся.

## Установка

Одна команда (скачает репозиторий, извлечёт SDK с машины, соберёт и установит). Требуются
на ноутбуке Python 3, Node.js и OpenSSH-клиент:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/daniloz095/vmgauge/main/deploy/install.ps1))) -HostName <IP-головки> -KeyPath <путь-к-id_rsa>
```

Или из клона репозитория (SDK уже извлечён в `./oap-sdk/`, сборка готова в `dist/`):

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\deploy\push-to-car.ps1 install -Key <путь-к-id_rsa> -Ip <IP-головки>
```

## Удаление (откат к стоку)

```powershell
.\deploy\push-to-car.ps1 restore -Key <путь-к-id_rsa> -Ip <IP-головки>
```

(просит набрать `YES` в терминале). То же напрямую на ГУ:
`ssh root@<IP> "cd /var/opt/mgu-custom-apps && sh deploy-car.sh restore"`. Остальные команды
на ГУ: `sh deploy-car.sh status`, `sh deploy-car.sh backups`.

## Установка через MGU Store (магазин на экране)

Можно ставить/обновлять/удалять прямо на экране машины через
[MGU Store](https://github.com/robertnisipeanu/mgu-store). Сначала один раз ставится сам Store:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) first-install --identity <путь-к-id_rsa>
```

Затем на машине: **Store → Settings → Add source → `daniloz095/vmgauge` → Branch `main` → Install**.
Store собирает приложение прямо на ГУ (нужен интернет в машине), SDK берёт из стокового
приложения-донора — проприетарный код BMW в репозиторий не попадает. Удалить Store и всё,
что он ставил: та же команда с `uninstall` вместо `first-install`.

## Калибровка DID

Не все DID подтверждены на конкретной машине. Причина отказа видна в логе приложения
(`data/vmgauge.log`, строки `DID <metric>: <причина>`). Список «что пробовать» — в
`CALIBRATION.md`.

## Атрибуция

Собрано на фреймворке **idrive7-apps** (kit) — https://github.com/cauliflowermossgrape/idrive7-apps
(лицензия GPL-3.0, см. `LICENSE`).
