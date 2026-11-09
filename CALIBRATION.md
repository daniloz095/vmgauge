# Калибровка DID для метрик, которых нет в car_vitals

Каждая метрика имеет список кандидатов DID; `DidReader` пробует по порядку, первый правдоподобный
выигрывает. Причина отказа видна в логе машины: `DID <metric>: NRC 31 out of range / no reply / ...`.

## Как диагностировать

```powershell
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -i "C:\Users\dmpol\Downloads\MGU-SSH\data\enrollments\WBA6K71050FJ55634\id_rsa" root@169.254.102.111 "grep -E 'DID |raw' /var/opt/public/oap/oap_12450/data/vmgauge.log | tail -60"
```

## Метрики и что пробовать

### Уже исправлены (взято из car_vitals — проверенные)
| Метрика | Кандидаты |
|---|---|
| boost | F470 / F487 / F40B / obd 0B |
| baro | F433 / obd 33 |
| fuelPresAct (рампа, факт) | F423 / F459 / obd 23 |
| ignAdv (угол опережения) | obd 0E / F40E |
| loadDirect (нагрузка %) | 5813 |
| gearbox (t° КПП) | 6000 / DA12 (ecu 24) |
| misfire | OBD service 06 (MID A2.., tid 0C) |

### Есть стандартный OBD-PID — должен работать, проверить лог
| Метрика | Наш кандидат | Стандарт OBD |
|---|---|---|
| lambda | obd 24 | PID 0x24 = эквив. соотношение (raw/32768) — должен работать |
| voltage | obd 42 | PID 0x42 = напряжение модуля (raw/1000) — должен работать |

Если `obd 24`/`obd 42` дают `NRC 31` — DME отказывает OBD-запросу, тогда искать BMW-DID.

### Только BMW-DID (нет в car_vitals) — калибровать по логу
| Метрика | Наш DID | Замечание |
|---|---|---|
| oil pressure | 586F (OELDRUCK) / 4436 | нет стандартного OBD-PID; возможно недоступно на B58 |
| mixture adaptation | 4A9D (KORR_MULT_GEMISCHADAP) | проверить по raw |
| knock retard | 554C (MITTELW_ZYLIND_ZWSPAET_KR) | проверить по raw |
| EGT | 5896 (TEMP_NACH_KAT) / 582F / 579B | проверить по raw |
| fuel temp | 449D / 5639 | проверить по raw |
| thermostat | 5893 / 447F | проверить по raw |
| fan rpm | 5873 / 4457 | проверить по raw |
| radiator temp | 5815 / 4431 | проверить по raw |
| battery current | 5854 (IBS_STROM) | проверить по raw |
| alternator current | 4469 / 589C | проверить по raw |
| alternator temp | 58A1 | проверить по raw |
| tcase clutch % | 58F0 / 58F1 | car_vitals вместо этого читает момент на переднюю ось `DB32` (xdrive.front) |

## Стратегия

1. Сначала посмотреть лог — у каждой упавшей метрики будет `DID <metric>: <причина>`.
2. `NRC 31 out of range` = DME не знает этот DID → менять DID.
3. `no reply` = DID есть, но не отвечает (другой ECU/сессия) → менять ECU или DID.
4. Стандартные OBD-PID (lambda 0x24, voltage 0x42) если падают с NRC 31 — DME закрыт для OBD, тогда
   подбирать BMW-DID из SGBD (DME8FF_R).
5. Для tcase — рассмотреть переход на `xdrive.front` (DB32, момент на переднюю ось) как у car_vitals.
