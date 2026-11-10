'use strict';
/**
 * VMGauge — boost, temperatures, oil pressure, lambda, knock, fuel, electrical,
 * transfer case and lap timer, drawn in the M Vitals style (kit/gauges).
 */
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const fs = require('fs');
const path = require('path');

const W = 1600, H = 520;
const num = G.isNum;
const clamp = G.clamp;

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;

        /* ---------------- state ---------------- */
        const TABS = [
            { id: 'main', label: 'Main' }, { id: 'power', label: 'Power' }, { id: 'hpfp', label: 'HPFP' },
            { id: 'ign', label: 'Ign' }, { id: 'fuelcool', label: 'Fuel/Cool' }, { id: 'elec', label: 'Elec' },
            { id: 'tcase', label: 'TCase' }, { id: 'lap', label: 'Lap' }, { id: 'more', label: 'More' },
        ];
        let gTab = 'main';
        const v = {};                          // live DID values
        const counters = { knock: 0 };
        const power = { hp: null, nm: null, peakHp: null, peakNm: null, peakAt: 0, stamp: 0, hist: [], lastPush: 0 };
        const fuelHist = [], fuelPush = { last: 0 };
        let prevKnock = false;
        const boostPeak = { peak: null, peakAt: 0 };

        // lap timer: armed by default, starts the moment the car moves
        const lap = { state: 'idle', startedAt: 0, crossed: {}, t100_200: null, maxes: {}, btnRect: null };
        let lapEma = null;
        const LAP_TARGETS = [100, 200];
        const LAP_METRICS = ['boost', 'fuelPres', 'iat', 'egt', 'speed'];

        // CSV logging
        const logState = { active: false, rows: 0, lastRowAt: 0, btnRect: null };

        /* ---------------- signals (Car) ---------------- */
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque']);
        const d = () => car.data();

        /* ---------------- DME over UDS ---------------- */
        const spec = ctx.spec.config || {};
        const dme = Object.assign({ ecu: 18 }, spec.dme || {});
        const xcfg = Object.assign({ front: [] }, spec.xdrive || {});
        const link = new Diag(ctx.signals, log);
        link.quiet = true;
        const rd = new DidReader(link, { ecu: dme.ecu });
        link.init().catch((e) => log.warn('diag init: ' + e));

        let baro = 101.3, baroT = 0;
        async function freshBaro() {
            if (Date.now() - baroT > 60000) {
                baroT = Date.now();
                const b = await rd.value('baro', dme.baro);
                if (b !== null) baro = b;
            }
        }

        // Every DID metric; 'tcase' reads the transfer case (xcfg.front), not the DME.
        const ALL = ['oilPressAbs', 'boost', 'iat', 'egt', 'lambda', 'mixtureAdapt', 'knockRetard',
            'loadDirect', 'fuelPresAct', 'fuelPresReq', 'ignAdv', 'fuelTemp', 'thermoPos',
            'fanRpm', 'radTemp', 'gearbox', 'voltage', 'battCurrent', 'aluIst', 'aluTemp', 'tcase'];
        // The values the current tab shows, polled fast (~2-3/s) so nothing looks frozen.
        const TAB_METRICS = {
            main: ['boost', 'oilPressAbs', 'lambda', 'iat', 'gearbox', 'voltage', 'egt', 'loadDirect'],
            power: ['loadDirect', 'boost'],
            hpfp: ['fuelPresAct', 'fuelPresReq'],
            ign: ['ignAdv', 'knockRetard', 'lambda', 'mixtureAdapt'],
            fuelcool: ['iat', 'egt', 'gearbox', 'fuelTemp', 'radTemp', 'thermoPos', 'fanRpm'],
            elec: ['voltage', 'aluIst', 'aluTemp', 'battCurrent'],
            tcase: ['tcase'],
            lap: ['boost', 'fuelPresAct', 'iat', 'egt'],
            more: ['boost', 'lambda'],
        };

        const fail = {}, tried = {}, rawLog = {}, rawCount = {};
        let fastIdx = 0, slowIdx = 0, tickNo = 0;

        async function readMetric(metric) {
            const list = metric === 'tcase' ? xcfg.front : dme[metric];
            if (!Array.isArray(list) || !list.length) return;
            if ((fail[metric] || 0) >= 3 && Date.now() - (tried[metric] || 0) < 30000) return;
            tried[metric] = Date.now();
            let val;
            if (metric === 'boost') { await freshBaro(); val = await rd.value('boost', dme.boost); if (val !== null) val = (val - baro) / 100; }
            else if (metric === 'tcase') val = await rd.value('tcase', xcfg.front);
            else val = await rd.value(metric, list);
            // log each candidate's raw reply, at most a few distinct shapes each (for calibration)
            const chosen = rd.pick[metric] || 0;
            list.forEach((c, i) => {
                const r = rd.raws[rd.key(c)];
                if (!r || (!r.bytes && !r.why)) return;
                const shape = (c.obd ? 'OBD ' + c.obd : c.did) + '|' + (r.bytes || r.why);
                const k = metric + '|' + i + '|' + shape;
                if (rawLog[k]) return;
                rawLog[k] = true;
                rawCount[metric + '|' + i] = (rawCount[metric + '|' + i] || 0) + 1;
                if (rawCount[metric + '|' + i] <= 6) {
                    const lbl = c.obd ? 'OBD ' + String(c.obd).toUpperCase() : c.did;
                    log.info('DID ' + metric + ' [' + lbl + ']' + (i === chosen ? ' *' : '') + ': ' + (r.bytes || r.why) + (r.value !== null && r.value !== undefined ? ' = ' + r.value : ''));
                }
            });
            if (val === null) { fail[metric] = (fail[metric] || 0) + 1; return; }
            fail[metric] = 0;
            v[metric] = val;
            if (metric === 'oilPressAbs') v.oilPress = num(val) && num(baro) ? val - baro / 100 : null;
        }

        async function pollLoop() {
            for (;;) {
                if (link.available) {
                    tickNo++;
                    const fast = TAB_METRICS[gTab];
                    const doSlow = tickNo % 15 === 0;
                    const queue = (doSlow || !fast || !fast.length) ? ALL : fast;
                    const idx = doSlow ? slowIdx++ : fastIdx++;
                    try { await readMetric(queue[idx % queue.length]); } catch (e) { log.warn('poll ' + queue[idx % queue.length] + ': ' + e); }
                }
                await new Promise((res) => setTimeout(res, link.available ? 350 : 1000));
            }
        }
        pollLoop();

        /* ---------------- derived values ---------------- */
        const F = () => settings.get('unitsTemp') === 'F';
        const T = (c) => (num(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');
        const mph = () => settings.get('speedUnits') === 'mph';
        const spd = (k) => (num(k) ? (mph() ? k * 0.621371 : k) : null);
        const sU = () => (mph() ? 'mph' : 'km/h');

        const boostBar = () => num(v.boost) ? v.boost : null;
        const currentLambda = () => {
            if (!num(v.lambda)) return null;
            let l = v.lambda;
            if (num(v.mixtureAdapt)) l *= v.mixtureAdapt;
            return l;
        };
        const oilPress = () => num(v.oilPress) ? v.oilPress : null;
        const fuelPresAct = () => num(v.fuelPresAct) ? v.fuelPresAct : null;
        const fuelPresReq = () => num(v.fuelPresReq) ? v.fuelPresReq : null;
        const loadPct = () => num(v.loadDirect) ? clamp(v.loadDirect, 0, 191.25) : null;
        const alternatorLoadPct = () => {
            if (!num(v.aluIst)) return null;
            const nom = (spec.elec && spec.elec.alternatorMaxA) || 170;
            return clamp(v.aluIst / nom * 100, 0, 100);
        };
        const alternatorOutputA = () => {
            if (num(v.aluIst)) return v.aluIst;
            if (num(v.battCurrent) && v.battCurrent > 0) return v.battCurrent;
            return null;
        };

        function computePower(dd) {
            if (!num(dd.rpm) || dd.rpm < 400) return;
            let nm = num(dd.torque) ? dd.torque : null;
            if (nm === null) {
                const load = num(v.loadDirect) ? v.loadDirect / 100 : null;
                if (!num(load)) return;
                nm = peakTorqueNm(dd.rpm) * load;
            }
            if (!num(nm) || nm < 0) return;
            const kw = nm * dd.rpm * 2 * Math.PI / 60 / 1000;
            power.nm = nm;
            power.hp = kw * 1.35962;         // metric PS
            power.stamp = Date.now();
            const now = Date.now(), ttl = settings.get('peakResetMs') || 6000;
            if (num(power.peakHp) && now - power.peakAt > ttl) { power.peakHp = null; power.peakNm = null; }
            if (!num(power.peakHp) || power.hp > power.peakHp) { power.peakHp = power.hp; power.peakNm = power.nm; power.peakAt = now; }
            if (now - power.lastPush > 200) {
                power.lastPush = now;
                power.hist.push({ t: now, hp: power.hp, nm: power.nm });
                const cutoff = now - 30000;
                while (power.hist.length && power.hist[0].t < cutoff) power.hist.shift();
                if (power.hist.length > 600) power.hist.splice(0, power.hist.length - 600);
            }
            const fp = fuelPresAct();
            if (num(fp) && now - fuelPush.last > 200) {
                fuelPush.last = now;
                fuelHist.push({ t: now, bar: fp });
                const fc = now - 30000;
                while (fuelHist.length && fuelHist[0].t < fc) fuelHist.shift();
                if (fuelHist.length > 600) fuelHist.splice(0, fuelHist.length - 600);
            }
        }
        function peakTorqueNm(rpm) {
            const m = [[600, 100], [1300, 450], [5000, 450], [7000, 380]];
            if (rpm <= m[0][0]) return m[0][1];
            const last = m[m.length - 1];
            if (rpm >= last[0]) return last[1];
            for (let i = 1; i < m.length; i++) {
                if (rpm <= m[i][0]) {
                    const x0 = m[i - 1][0], y0 = m[i - 1][1], x1 = m[i][0], y1 = m[i][1];
                    return y0 + (y1 - y0) * (rpm - x0) / (x1 - x0);
                }
            }
            return last[1];
        }
        function handleKnock() {
            const ret = v.knockRetard;
            const active = num(ret) && ret < -0.5;
            if (active && !prevKnock && num(boostBar()) && boostBar() > 0.5) counters.knock++;
            prevKnock = active;
        }

        function boostGaugeStep() {
            const now = Date.now(), b = boostBar();
            if (num(b) && (!num(boostPeak.peak) || b > boostPeak.peak)) { boostPeak.peak = b; boostPeak.peakAt = now; }
            if (num(boostPeak.peak) && now - boostPeak.peakAt > 8000) boostPeak.peak = null;
        }

        /* ---------------- "why is this tile empty" ---------------- */
        function fuelWhy(k) {
            if (!link.p) return 'no diagnostic link';
            if (!link.available) return 'diagnostic link down';
            const list = k === 'tcase' ? xcfg.front : dme[k];
            const r = (list || []).map((c) => rd.raws[rd.key(c)]).filter(Boolean);
            if (!r.length) return 'reading...';
            if (r.every((x) => /NRC 31|NRC 11|NRC 12/.test(x.why))) return 'not available on this car';
            return /NRC|refused|reply/.test((r[0] || {}).why || '') ? 'no reading from the engine unit' : (r[0] || {}).why || 'no data';
        }

        /* ---------------- layout helpers ---------------- */
        function header(cv, t) { G.frame(cv, t, TABS.map((x) => x.label), TABS.findIndex((x) => x.id === gTab), []); }
        function grid(n) {
            const per = n <= 2 ? Math.max(1, n) : n <= 4 ? 2 : n <= 6 ? 3 : 4, rows = Math.ceil(n / per), gap = 16;
            const h = (G.BOTTOM - G.TOP - gap * (rows - 1)) / rows, out = [];
            for (let r = 0; r < rows; r++) {
                const k = Math.min(per, n - r * per), w = (1552 - 24 * (k - 1)) / k;
                for (let c = 0; c < k; c++) out.push({ x: 24 + c * (w + 24), y: G.TOP + r * (h + gap), w, h });
            }
            return out;
        }
        function drawTiles(cv, t, tiles) {
            grid(tiles.length).forEach((b, i) => {
                const g = tiles[i];
                if (g && g.draw) g.draw(cv, t, b.x, b.y, b.w, b.h);
                else if (g) G.stat(cv, t, b.x, b.y, b.w, b.h, Object.assign({ size: b.h > 200 ? 96 : 64 }, g));
            });
        }

        /* ---------------- tabs ---------------- */
        function drawMain(cv, t, dd) {
            drawTiles(cv, t, [
                { label: 'Boost', value: boostBar(), unit: 'bar', decimals: 2, zones: [{ from: 0.05, to: 99, color: 'ok' }] },
                { label: 'Lambda', value: currentLambda(), decimals: 2 },
                { label: 'Oil pressure', value: oilPress(), unit: 'bar', decimals: 1, zones: [{ from: -99, to: 1.2, color: 'crit' }] },
                { label: 'Intake air', value: T(v.iat), unit: tU(), decimals: 0, zones: [{ from: T(65), to: 999, color: 'crit' }] },
                { label: 'Coolant', value: T(dd.coolant), unit: tU(), decimals: 0, zones: [{ from: T(112), to: 999, color: 'crit' }, { from: -99, to: T(60), color: 'cold' }] },
                { label: 'Engine oil', value: T(dd.oil), unit: tU(), decimals: 0, color: 'oil', zones: [{ from: T(125), to: 999, color: 'crit' }] },
                { label: 'Gearbox oil', value: T(v.gearbox), unit: tU(), decimals: 0, zones: [{ from: T(120), to: 999, color: 'warn' }] },
                { label: 'Voltage', value: v.voltage, unit: 'V', decimals: 1, zones: [{ from: -99, to: 12, color: 'warn' }, { from: 15.5, to: 99, color: 'warn' }] },
                { label: 'Knock count', value: counters.knock, decimals: 0 },
                { label: 'EGT', value: T(v.egt), unit: tU(), decimals: 0, zones: [{ from: T(950), to: 999, color: 'crit' }] },
                { label: 'Air charge', value: loadPct(), unit: '%', decimals: 0 },
                { label: 'Fuel rail', value: fuelPresAct(), unit: 'bar', decimals: 0, zones: [{ from: -99, to: 20, color: 'crit' }] },
            ]);
        }

        function drawPower(cv, t, dd) {
            const fresh = num(power.hp) && Date.now() - power.stamp < 3000;
            const hp = fresh ? power.hp : null, nm = fresh ? power.nm : null;
            const barH = 110, gap = 12;
            G.bar(cv, t, 24, G.TOP, 1552, barH, { label: 'Power', value: hp, unit: 'hp', decimals: 0, niceMax: true, ramp: 'hot', peak: power.peakHp });
            G.bar(cv, t, 24, G.TOP + barH + gap, 1552, barH, { label: 'Torque', value: nm, unit: 'Nm', decimals: 0, niceMax: true, peak: power.peakNm });
            const y = G.TOP + 2 * (barH + gap), h = G.BOTTOM - y;
            const now = Date.now(), t0 = now - 30000;
            const hs = power.hist.filter((p) => p.t >= t0);
            const maxV = Math.max(1, hs.length ? Math.max.apply(null, hs.map((p) => Math.max(p.hp, p.nm))) : 1);
            const yMax = Math.max(100, Math.ceil(maxV / 50) * 50);
            G.chart(cv, t, 24, y, 1552, h, {
                xMin: t0, xMax: now, yMin: 0, yMax,
                xStep: 10000, xFmt: (xx) => Math.round((xx - now) / 1000) + 's',
                yUnit: 'hp · Nm', yFmt: (yy) => String(Math.round(yy)),
                series: [
                    { pts: hs.map((p) => [p.t, p.hp]), color: 'accent', width: 2.5, fill: 0.12 },
                    { pts: hs.map((p) => [p.t, p.nm]), color: '#3aa0ff', width: 2 },
                ],
                empty: 'no power data — drive the car',
            });
        }

        function chartFuel(cv, t, y, h) {
            const now = Date.now(), t0 = now - 30000;
            const hs = fuelHist.filter((p) => p.t >= t0);
            G.chart(cv, t, 24, y, 1552, h, {
                xMin: t0, xMax: now, yMin: 0, yMax: 300,
                xStep: 10000, xFmt: (xx) => Math.round((xx - now) / 1000) + 's',
                yUnit: 'bar', yFmt: (yy) => String(Math.round(yy)),
                series: [{ pts: hs.map((p) => [p.t, p.bar]), color: 'accent', width: 2.5, fill: 0.14 }],
                empty: 'no rail pressure data',
            });
        }
        function drawHpfp(cv, t, dd) {
            const act = fuelPresAct(), req = fuelPresReq();
            const th = Math.round((G.BOTTOM - G.TOP) * 0.42);
            const w2 = Math.round((1552 - 24) / 2);
            G.stat(cv, t, 24, G.TOP, w2, th, { label: 'Rail pressure', value: act, unit: 'bar', decimals: 0, zones: [{ from: -99, to: 20, color: 'crit' }], sub: num(act) ? 'high-pressure fuel (actual)' : fuelWhy('fuelPresAct') });
            G.stat(cv, t, 24 + w2 + 24, G.TOP, w2, th, { label: 'Rail requested', value: req, unit: 'bar', decimals: 0, sub: num(req) ? 'target rail pressure' : fuelWhy('fuelPresReq') });
            chartFuel(cv, t, G.TOP + th + 16, G.BOTTOM - G.TOP - th - 16);
        }

        function drawIgn(cv, t, dd) {
            drawTiles(cv, t, [
                { label: 'Ignition timing', value: num(v.ignAdv) ? v.ignAdv : null, unit: '°', decimals: 1, sub: num(v.ignAdv) ? 'before TDC, cyl 1' : fuelWhy('ignAdv') },
                { label: 'Knock retard', value: num(v.knockRetard) ? v.knockRetard : null, unit: '°', decimals: 1, zones: [{ from: -99, to: -0.5, color: 'warn' }] },
                { label: 'Lambda', value: currentLambda(), decimals: 3 },
                { label: 'Mixture adapt', value: num(v.mixtureAdapt) ? v.mixtureAdapt : null, decimals: 3 },
            ]);
        }

        function drawFuelCool(cv, t, dd) {
            drawTiles(cv, t, [
                { label: 'Coolant', value: T(dd.coolant), unit: tU(), decimals: 0, zones: [{ from: T(112), to: 999, color: 'crit' }, { from: -99, to: T(60), color: 'cold' }] },
                { label: 'Intake air', value: T(v.iat), unit: tU(), decimals: 0, zones: [{ from: T(65), to: 999, color: 'crit' }] },
                { label: 'EGT', value: T(v.egt), unit: tU(), decimals: 0, zones: [{ from: T(950), to: 999, color: 'crit' }] },
                { label: 'Gearbox oil', value: T(v.gearbox), unit: tU(), decimals: 0, zones: [{ from: T(120), to: 999, color: 'warn' }] },
                { label: 'Fuel temp', value: T(v.fuelTemp), unit: tU(), decimals: 0, sub: num(v.fuelTemp) ? undefined : fuelWhy('fuelTemp') },
                { label: 'Radiator', value: T(v.radTemp), unit: tU(), decimals: 0, sub: num(v.radTemp) ? undefined : fuelWhy('radTemp') },
            ]);
        }

        function drawElec(cv, t, dd) {
            drawTiles(cv, t, [
                { label: 'Voltage', value: v.voltage, unit: 'V', decimals: 1, zones: [{ from: -99, to: 12, color: 'warn' }, { from: 15.5, to: 99, color: 'warn' }] },
                { label: 'Alt load', value: alternatorLoadPct(), unit: '%', decimals: 0, sub: num(alternatorLoadPct()) ? 'alternator output' : fuelWhy('aluIst') },
                { label: 'Output', value: alternatorOutputA(), unit: 'A', decimals: 0, sub: num(alternatorOutputA()) ? 'alternator current' : fuelWhy('aluIst') },
                { label: 'Alt temp', value: T(v.aluTemp), unit: tU(), decimals: 0, sub: num(v.aluTemp) ? undefined : fuelWhy('aluTemp') },
            ]);
        }

        function drawTcase(cv, t, dd) {
            const ft = num(v.tcase) ? v.tcase : null;
            drawTiles(cv, t, [
                { label: 'Front axle torque', value: ft, unit: 'Nm', decimals: 0, sub: num(ft) ? 'transfer case (LMV)' : fuelWhy('tcase') },
                { label: 'Engine torque', value: num(dd.torque) ? dd.torque : null, unit: 'Nm', decimals: 0, sub: num(dd.torque) ? 'crankshaft' : 'no torque signal' },
            ]);
        }

        /* ---------------- LAP ---------------- */
        function lapStep(dd) {
            const s = num(dd.speed) ? dd.speed : null;
            if (num(s)) lapEma = lapEma === null ? s : lapEma + (s - lapEma) * 0.5;
            lap.curSpeed = lapEma;
            if (lap.state === 'idle' && num(lapEma) && lapEma >= 3) {
                lap.state = 'running'; lap.startedAt = Date.now();
                lap.crossed = {}; lap.t100_200 = null; lap.maxes = {}; lapEma = null;
                log.info('lap started');
            }
            if (lap.state !== 'running') return;
            const el = (Date.now() - lap.startedAt) / 1000;
            const cur = num(lapEma) ? lapEma : 0;
            for (const tgt of LAP_TARGETS) if (!num(lap.crossed[tgt]) && cur >= tgt) { lap.crossed[tgt] = el; log.info('lap: 0-' + tgt + ' in ' + el.toFixed(2) + ' s'); }
            if (num(lap.crossed[100]) && num(lap.crossed[200])) lap.t100_200 = lap.crossed[200] - lap.crossed[100];
            const vals = { boost: boostBar(), fuelPres: fuelPresAct(), iat: num(v.iat) ? v.iat : null, egt: num(v.egt) ? v.egt : null, speed: num(dd.speed) ? dd.speed : null };
            for (const key of LAP_METRICS) { const val = vals[key]; if (num(val) && (!num(lap.maxes[key]) || val > lap.maxes[key])) lap.maxes[key] = val; }
        }
        function lapToggle() {
            if (lap.state === 'running') { lap.state = 'done'; log.info('lap stopped'); return; }
            // idle / done -> arm (results cleared, starts on the next movement)
            lap.state = 'idle'; lap.crossed = {}; lap.t100_200 = null; lap.maxes = {}; lapEma = null; lap.startedAt = 0;
            log.info('lap armed (starts when the car moves)');
        }
        function drawLap(cv, t, dd) {
            const sp = num(dd.speed) ? dd.speed : null;
            const running = lap.state === 'running';
            const el = running ? (Date.now() - lap.startedAt) / 1000 : (lap.state === 'done' && lap.startedAt ? (Date.now() - lap.startedAt) / 1000 : 0);
            // big speed
            const speedY = G.TOP + 60;
            cv.text(sp !== null ? String(Math.round(sp)) : '--', 800, speedY, 120, running ? t.accent : t.text, { align: 'center', font: 'num' });
            cv.text(sU(), 800, speedY + 40, 30, t.dim, { align: 'center' });
            // times (right)
            const rx = 1000;
            const lt = (tgt) => num(lap.crossed[tgt]) ? lap.crossed[tgt].toFixed(2) : (running ? el.toFixed(2) : '0.00');
            const rows = [
                ['0-100 km/h', lt(100), num(lap.crossed[100])],
                ['0-200 km/h', lt(200), num(lap.crossed[200])],
                ['100-200 km/h', num(lap.t100_200) ? lap.t100_200.toFixed(2) : (running && num(lap.crossed[100]) ? (el - lap.crossed[100]).toFixed(2) : '0.00'), num(lap.t100_200)],
            ];
            let ry = G.TOP + 30;
            rows.forEach(([label, txt, got]) => {
                cv.text(label, rx, ry, 22, t.dim, { font: 'bold' });
                cv.text(txt + ' s', rx, ry + 30, 40, got ? t.accent : t.text, { font: 'num' });
                ry += 92;
            });
            // live metrics (left)
            let ly = G.TOP + 30;
            const live = { boost: boostBar(), fuelPres: fuelPresAct(), iat: num(v.iat) ? v.iat : null, egt: num(v.egt) ? v.egt : null, speed: sp };
            LAP_METRICS.forEach((key) => {
                const showMax = lap.state === 'done' && num(lap.maxes[key]);
                const val = showMax ? lap.maxes[key] : live[key];
                cv.text((showMax ? 'MAX ' : '') + key.toUpperCase(), 40, ly, 22, t.dim, { font: 'bold' });
                cv.text(num(val) ? val.toFixed(key === 'boost' ? 2 : 0) : '--', 40, ly + 30, 40, showMax ? t.accent : (num(val) ? t.text : t.dim), { font: 'num' });
                ly += 92;
            });
            // arm / stop button
            const btnW = 260, btnH = 64, bx = 800 - btnW / 2, by = G.BOTTOM - btnH - 20;
            lap.btnRect = [bx, by, btnW, btnH];
            cv.roundRect(bx, by, btnW, btnH, 14, running ? t.crit : '#1aa05a');
            cv.text(running ? 'STOP' : 'ARM', bx + btnW / 2, by + btnH / 2 + 9, 28, '#ffffff', { align: 'center', font: 'bold' });
            const status = running ? 'REC ' + el.toFixed(1) + ' s' : lap.state === 'done' ? 'run complete' : 'armed — starts when the car moves';
            cv.text(status, bx + btnW / 2, by - 18, 20, t.dim, { align: 'center' });
        }

        /* ---------------- MORE (boost gauge + logging) ---------------- */
        function drawMore(cv, t, dd) {
            // radial boost gauge
            const area = G.BOTTOM - G.TOP;
            const cx = 800, cy = G.TOP + area * 0.56;
            const R = Math.min(Math.round(area * 0.34), 200);
            const maxB = 2.5;
            G.radial(cv, t, cx, cy, R, {
                label: 'Boost', unit: 'bar', decimals: 2, min: 0, max: maxB, ticks: 10, majorEvery: 2, tickDiv: 1, tickDecimals: 1,
                value: boostBar(), peak: boostPeak.peak, color: 'accent',
                zones: [{ from: maxB * 0.85, to: maxB, color: 'crit' }], limit: maxB * 0.85,
            });
            // REC button
            const btnW = 240, btnH = 60, bx = 40, by = G.BOTTOM - btnH - 20;
            logState.btnRect = [bx, by, btnW, btnH];
            cv.roundRect(bx, by, btnW, btnH, 12, logState.active ? t.crit : '#1aa05a');
            cv.text(logState.active ? 'STOP' : 'REC', bx + btnW / 2, by + btnH / 2 + 8, 26, '#ffffff', { align: 'center', font: 'bold' });
            cv.text('rows: ' + logState.rows + '  →  vmgauge_log.csv', bx, by + btnH + 24, 20, t.dim);
        }

        /* ---------------- CSV logging ---------------- */
        function loggingStep(dd) {
            if (!logState.active) return;
            const now = Date.now();
            if (now - logState.lastRowAt < 500) return;
            logState.lastRowAt = now;
            const dt = new Date();
            const pad2 = (n) => (n < 10 ? '0' : '') + n;
            const iso = dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()) + ' ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes()) + ':' + pad2(dt.getSeconds());
            const line = [iso, num(dd.rpm) ? Math.round(dd.rpm) : '', num(dd.speed) ? Math.round(dd.speed) : '', num(boostBar()) ? boostBar().toFixed(2) : '',
                num(oilPress()) ? oilPress().toFixed(1) : '', num(currentLambda()) ? currentLambda().toFixed(2) : '', num(dd.oil) ? Math.round(dd.oil) : '',
                num(dd.coolant) ? Math.round(dd.coolant) : '', num(v.egt) ? Math.round(v.egt) : '', num(v.iat) ? Math.round(v.iat) : '',
                num(fuelPresAct()) ? fuelPresAct().toFixed(1) : '', num(v.ignAdv) ? v.ignAdv.toFixed(1) : '', num(v.knockRetard) ? v.knockRetard.toFixed(1) : '',
                num(v.voltage) ? v.voltage.toFixed(1) : '', num(alternatorLoadPct()) ? Math.round(alternatorLoadPct()) : '', num(v.tcase) ? Math.round(v.tcase) : '',
                counters.knock].join(',');
            try {
                const f = path.join(ctx.dataDir, 'vmgauge_log.csv');
                const head = 't_iso,rpm,speed,boost,oil_press,lambda,oil_temp,coolant,egt,iat,rail_act,ign_adv,knock_ret,voltage,alt_load,tc_front,knock_ev\n';
                if (!fs.existsSync(f)) fs.writeFileSync(f, head);
                fs.appendFileSync(f, line + '\n');
                logState.rows++;
            } catch (e) { log.warn('log write: ' + e); }
        }

        /* ---------------- render ---------------- */
        async function render() {
            const t = ctx.theme();
            const dd = d();
            v.rpm = dd.rpm; v.coolant = dd.coolant; v.oilTemp = dd.oil; v.speed = dd.speed;
            computePower(dd);
            handleKnock();
            lapStep(dd);
            boostGaugeStep();
            loggingStep(dd);
            const cv = ctx.canvas(W, H).clear(t.bg);
            switch (gTab) {
                case 'main': drawMain(cv, t, dd); break;
                case 'power': drawPower(cv, t, dd); break;
                case 'hpfp': drawHpfp(cv, t, dd); break;
                case 'ign': drawIgn(cv, t, dd); break;
                case 'fuelcool': drawFuelCool(cv, t, dd); break;
                case 'elec': drawElec(cv, t, dd); break;
                case 'tcase': drawTcase(cv, t, dd); break;
                case 'lap': drawLap(cv, t, dd); break;
                case 'more': drawMore(cv, t, dd); break;
            }
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 10, render);

        ctx.onTab((i) => { if (i >= 0 && i < TABS.length) gTab = TABS[i].id; });
        const inRect = (r, x, y) => r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
        ctx.onTap((x, y) => {
            if (gTab === 'lap' && inRect(lap.btnRect, x, y)) { lapToggle(); return; }
            if (gTab === 'more' && inRect(logState.btnRect, x, y)) {
                logState.active = !logState.active;
                logState.rows = 0;
                log.info(logState.active ? 'logging on' : 'logging off');
            }
        });

        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
