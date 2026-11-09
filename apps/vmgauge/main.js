'use strict';
/**
 * VMGauge — boost, temperatures, oil pressure, lambda, knock/misfire, electrical,
 * transfer case and lap timer, live from the car (idrive7-apps kit).
 */
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const fs = require('fs');
const path = require('path');

const W = 1600, H = 520;
const STALE_MS = 3000;
const PEAK_RESET_MS = 6000;
const TORQUE_MAP = [[600, 100], [1300, 450], [5000, 450], [7000, 380]];  // B58 torque curve

const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const pad2 = (n) => (n < 10 ? '0' : '') + n;

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;

        /* ---------------- state ---------------- */
        let gTab = 'main';
        const v = {};                       // live DID values
        const counters = { knock: 0, misfire: 0 };
        const power = { hp: null, nm: null, peakHp: null, peakNm: null, peakHpAt: 0, peakNmAt: 0, stamp: 0, hist: [] };
        let prevKnock = false;

        // lap timer
        const lap = { state: 'idle', startedAt: 0, crossed: {}, t100_200: null, maxes: {}, btnRect: null };
        let lapEma = null;
        const LAP_TARGETS = [100, 200];
        const LAP_METRICS = ['boost', 'fuelPres', 'iat', 'egt', 'speed'];

        // MORE sub-tabs
        let gMoreTab = 'boost';
        const MORE_TABS = ['boost', 'gearcorr', 'exhaust', 'logs', 'profiles'];
        const boostGauge = { peak: null, peakAt: 0 };
        const gearCorr = { events: [], total: 0 };
        let gcPrev = { t: 0, boost: null };
        const logState = { active: false, rows: 0, events: [], lastRowAt: 0 };

        const TABS = [
            { id: 'main', label: 'MAIN' }, { id: 'power', label: 'POWER' }, { id: 'hpfp', label: 'HPFP' },
            { id: 'ign', label: 'IGN' }, { id: 'fuelcool', label: 'FUEL/COOL' }, { id: 'elec', label: 'ELEC' },
            { id: 'tcase', label: 'TCASE' }, { id: 'lap', label: 'LAP' }, { id: 'more', label: 'MORE' },
        ];

        /* ---------------- signals (Car) ---------------- */
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque']);
        const d = () => car.data();

        /* ---------------- DME over UDS ---------------- */
        const dme = Object.assign({ ecu: 18 }, (ctx.spec.config && ctx.spec.config.dme) || {});
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

        const METRICS = ['oilPressAbs', 'boost', 'iat', 'egt', 'lambda', 'mixtureAdapt', 'knockRetard',
                         'loadDirect', 'fuelPresAct', 'fuelPresReq', 'ignAdv', 'fuelTemp', 'thermoPos',
                         'fanRpm', 'radTemp', 'gearbox', 'voltage', 'battCurrent', 'aluIst', 'aluTemp', 'tcClutchRaw'];
        const fail = {}, tried = {};
        let idx = 0;
        async function pollDme() {
            if (!link.available) return;
            const metric = METRICS[idx++ % METRICS.length];
            const list = dme[metric];
            if (!Array.isArray(list) || !list.length) return;
            if ((fail[metric] || 0) >= 3 && Date.now() - (tried[metric] || 0) < 30000) return;
            tried[metric] = Date.now();
            let val;
            if (metric === 'boost') { await freshBaro(); val = await rd.value('boost', dme.boost); if (val !== null) val = (val - baro) / 100; }
            else val = await rd.value(metric, list);
            if (val === null) {
                fail[metric] = (fail[metric] || 0) + 1;
                const c = list[rd.pick[metric] || 0] || list[0];
                const r = rd.raws[rd.key(c)];
                if (r && !r.logged && fail[metric] === 1) { r.logged = true; log.info('DID ' + metric + ': ' + (r.why || 'no value')); }
                return;
            }
            fail[metric] = 0;
            v[metric] = val;
            if (metric === 'oilPressAbs') v.oilPress = num(val) && num(baro) ? val - baro / 100 : null;
        }
        function pollLoop() { pollDme().finally(() => setTimeout(pollLoop, 250)); }
        pollLoop();

        /* ---------------- derived values ---------------- */
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (num(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? 'F' : 'C');
        const mph = () => settings.get('speedUnit') === 'mph';
        const spd = (kmh) => (num(kmh) ? (mph() ? kmh * 0.621371 : kmh) : null);
        const sU = () => (mph() ? 'mph' : 'km/h');

        const boostBar = () => num(v.boost) ? v.boost : null;                       // already relative bar
        const currentLambda = () => {
            if (!num(v.lambda)) return null;
            let l = v.lambda;
            if (num(v.mixtureAdapt)) l *= v.mixtureAdapt;
            return l;
        };
        const fuelPresAct = () => num(v.fuelPresAct) ? v.fuelPresAct : null;
        const fuelPresReq = () => num(v.fuelPresReq) ? v.fuelPresReq : null;
        const alternatorLoadPct = () => {
            if (!num(v.aluIst)) return null;
            const nom = (ctx.spec.config && ctx.spec.config.elec && ctx.spec.config.elec.alternatorMaxA) || 170;
            return clamp(v.aluIst / nom * 100, 0, 100);
        };
        const alternatorOutputA = () => {
            if (num(v.aluIst)) return v.aluIst;
            if (num(v.battCurrent) && v.battCurrent > 0) return v.battCurrent;
            return null;
        };
        // transfer-case lock-up: raw clutch current vs nominal, or a slip/accel estimate
        function tcaseLockPct() {
            if (num(v.tcLockPct)) return v.tcLockPct;
            if (num(v.tcClutchRaw)) {
                const nom = (ctx.spec.config && ctx.spec.config.tcase && ctx.spec.config.tcase.clutchMaxMa) || 2000;
                return clamp(v.tcClutchRaw / nom * 100, 0, 100);
            }
            return null;
        }
        // engine load fraction 0..~1.2
        function calcLoad() {
            if (num(v.loadDirect)) return clamp(v.loadDirect / 100, 0, 1.2);
            if (num(v.boost) && num(baro) && baro > 0) {
                let est = (num(v.boost) ? v.boost * 100 + baro : baro) / baro;   // absolute kPa / baro
                if (est > 1) est = 1 + (est - 1) * 1.5;
                return clamp(est, 0, 1.2);
            }
            return null;
        }
        function peakTorqueNm(rpm) {
            const m = TORQUE_MAP;
            if (rpm <= m[0][0]) return m[0][1];
            const last = m[m.length - 1];
            if (rpm >= last[0]) return last[1];
            for (let i = 1; i < m.length; i++) {
                if (rpm <= m[i][0]) {
                    const [x0, y0] = m[i - 1], [x1, y1] = m[i];
                    return y0 + (y1 - y0) * (rpm - x0) / (x1 - x0);
                }
            }
            return last[1];
        }
        function computePower(dd) {
            if (!num(dd.rpm) || dd.rpm < 400) return false;
            const load = calcLoad();
            if (!num(load)) return false;
            const tq = peakTorqueNm(dd.rpm) * load;
            if (!num(tq) || tq < 0) return false;
            const kw = tq * dd.rpm * 2 * Math.PI / 60 / 1000;
            power.nm = tq;
            power.hp = kw * 1.35962;         // metric PS
            power.stamp = Date.now();
            const now = Date.now(), ttl = settings.get('peakResetMs') || PEAK_RESET_MS;
            if (num(power.peakHp) && now - power.peakHpAt > ttl) power.peakHp = null;
            if (num(power.peakNm) && now - power.peakNmAt > ttl) power.peakNm = null;
            if (!num(power.peakHp) || power.hp > power.peakHp) { power.peakHp = power.hp; power.peakHpAt = now; }
            if (!num(power.peakNm) || power.nm > power.peakNm) { power.peakNm = power.nm; power.peakNmAt = now; }
            power.hist.push({ t: now, hp: power.hp, nm: power.nm });
            const cutoff = now - 30000;
            while (power.hist.length && power.hist[0].t < cutoff) power.hist.shift();
            if (power.hist.length > 400) power.hist.splice(0, power.hist.length - 400);
            return true;
        }
        // knock: rising edge of negative retard while boosting
        function handleKnock(dd) {
            const ret = v.knockRetard;
            const active = num(ret) && ret < -0.5;
            if (active && !prevKnock && num(boostBar()) && boostBar() > 0.5) counters.knock++;
            prevKnock = active;
        }

        /* ---------------- colors ---------------- */
        const C = (t, name) => ({
            background: t.panelTop, surface: t.panelTop, textPrimary: t.text, textSecondary: t.dim,
            textTertiary: t.dim, divider: t.track, accent: t.accent, alert: t.crit, ok: t.ok, warn: t.warn,
        }[name] || t.text);

        function tileColor(key, val) {
            if (!num(val)) return 'textTertiary';
            if (key === 'boost') return val > 0.05 ? 'textPrimary' : 'textTertiary';
            if (key === 'oilPress') return val < 1.2 ? 'alert' : 'textPrimary';
            return 'textPrimary';
        }

        /* ---------------- tiles ---------------- */
        const fmt = (key, val, dp) => (num(val) ? val.toFixed(dp) : '--');

        function drawTile(cv, t, x, y, tw, th, label, val, dp, col, bar) {
            cv.roundRect(x + 3, y + 3, tw - 6, th - 6, 10, C(t, 'background'));
            const pad = Math.round(th * 0.10);
            cv.text(label, x + pad, y + pad + Math.round(th * 0.13), Math.round(th * 0.14), C(t, 'textSecondary'), { font: 'bold', spacing: 1 });
            const cname = col || tileColorFor(label, val);
            const color = C(t, cname);
            const txt = fmt(label, val, dp);
            cv.text(txt, x + pad, y + Math.round(th * 0.55), Math.round(th * 0.34), num(val) ? color : C(t, 'textTertiary'), { font: 'num' });
            if (bar && num(val)) {
                const bx = x + pad, bw = tw - 2 * pad, by = y + th - Math.round(th * 0.15), bh = Math.max(4, Math.round(th * 0.07));
                cv.fillRect(bx, by, bw, bh, C(t, 'divider'));
                cv.fillRect(bx, by, Math.round(bw * clamp(val, 0, 100) / 100), bh, color);
            }
        }
        function tileColorFor(key, val) { return tileColor(key, val); }

        /* ---------------- tab strip ---------------- */
        function drawTabs(cv, t) {
            const tabH = Math.round(H * 0.09);
            const tw = Math.floor(W / TABS.length);
            for (let i = 0; i < TABS.length; i++) {
                const active = TABS[i].id === gTab;
                const x = i * tw;
                if (active) cv.fillRect(x, tabH - 3, tw, 3, C(t, 'accent'));
                cv.text(TABS[i].label, x + tw / 2, tabH / 2 + 8, 20, active ? C(t, 'textPrimary') : C(t, 'textSecondary'), { align: 'center', font: 'bold' });
            }
        }

        /* ---------------- tabs ---------------- */
        const valueByKey = (key, dd) => {
            switch (key) {
                case 'boost': return boostBar();
                case 'lambda': return currentLambda();
                case 'oilPress': return num(v.oilPress) ? v.oilPress : null;
                case 'iat': return num(v.iat) ? v.iat : null;
                case 'egt': return num(v.egt) ? v.egt : null;
                case 'coolant': return num(dd.coolant) ? dd.coolant : null;
                case 'oilTemp': return num(dd.oil) ? dd.oil : null;
                case 'gearbox': return num(v.gearbox) ? v.gearbox : null;
                case 'voltage': return num(v.voltage) ? v.voltage : null;
                case 'fuelPres': return fuelPresAct();
                case 'fuelPresReq': return fuelPresReq();
                case 'ignAdv': return num(v.ignAdv) ? v.ignAdv : null;
                case 'knockRetard': return num(v.knockRetard) ? v.knockRetard : null;
                case 'load': return calcLoad() === null ? null : calcLoad() * 100;
                case 'alternatorLoad': return alternatorLoadPct();
                case 'alternatorTemp': return num(v.aluTemp) ? v.aluTemp : null;
                case 'currentOut': return alternatorOutputA();
                case 'fuelTemp': return num(v.fuelTemp) ? v.fuelTemp : null;
                case 'thermoPos': return num(v.thermoPos) ? v.thermoPos : null;
                case 'fanRpm': return num(v.fanRpm) ? v.fanRpm : null;
                case 'radTemp': return num(v.radTemp) ? v.radTemp : null;
                case 'tcase': return tcaseLockPct();
                case 'slipRpm': return num(v.slipRpm) ? v.slipRpm : null;
                default: return null;
            }
        };

        function drawMain(cv, t, dd) {
            const tabH = Math.round(H * 0.09);
            const area = H - tabH;
            const rh = Math.floor(area / 4);
            const side = Math.floor((W - W / 2) / 2);
            const xs = [0, side, W - side, W];
            const layout = [
                [0, 0, 'boost', 2, 'bar'], [0, 1, 'lambda', 2, ''], [0, 2, 'oilPress', 1, 'bar'],
                [1, 0, 'iat', 0, tU()], [1, 2, 'egt', 0, tU()],
                [2, 0, 'coolant', 0, tU()], [2, 1, 'oilTemp', 0, tU()], [2, 2, 'gearbox', 0, tU()],
                [3, 0, 'voltage', 1, 'V'], [3, 1, 'knock', 0, ''], [3, 2, 'misfire', 0, ''],
            ];
            for (const [row, col, key, dp, unit] of layout) {
                const x = xs[col], w = xs[col + 1] - xs[col];
                const y = tabH + row * rh;
                let val, label;
                if (key === 'knock') { val = counters.knock; label = 'KNOCK'; }
                else if (key === 'misfire') { val = counters.misfire; label = 'MISFIRE'; }
                else { val = valueByKey(key, dd); label = key.toUpperCase(); }
                drawTile(cv, t, x, y, w, rh, label, val, dp, tileColor(key, val), false);
            }
            // logo cell (row 1, middle)
            const lx = xs[1], ly = tabH + 1 * rh, lw = xs[2] - xs[1];
            drawLogo(cv, t, lx, ly, lw, rh);
        }

        function drawLogo(cv, t, x, y, w, h) {
            cv.roundRect(x + 3, y + 3, w - 6, h - 6, 10, C(t, 'background'));
            const cx = x + w / 2, cy = y + h / 2;
            const R = Math.min(w, h) * 0.40;
            cv.circle(cx, cy, R, '#141414');
            const mc = ['#87c4e8', '#0f96d8', '#e8452c', '#1aa05a', '#87c4e8'];
            const stripes = [[0, 0.0, 0.5, 0], [0, 0.5, 1.0, 1], [1, 0.0, 0.5, 2], [2, 0.0, 0.5, 2], [3, 0.0, 0.5, 3]];
            for (const [q, f0, f1, ci] of stripes) {
                const qa = [-90, 0, 180, 90][q];
                const a0 = qa + f0 * 90, a1 = qa + f1 * 90;
                cv.arc(cx, cy, 0, R * 0.84, a0, a1, mc[ci]);
            }
            cv.text('M', cx, cy - R * 0.55, Math.round(R * 0.3), '#e6e6e6', { align: 'center', font: 'bold' });
            cv.text('M', cx, cy + R * 0.72, Math.round(R * 0.3), '#e6e6e6', { align: 'center', font: 'bold' });
        }

        function drawPower(cv, t, dd) {
            const tabH = Math.round(H * 0.09);
            const area = H - tabH;
            const numH = Math.round(area * 0.40);
            const fresh = num(power.hp) && (Date.now() - power.stamp) < STALE_MS;
            const half = Math.floor(W / 2);
            drawPowerTile(cv, t, 0, tabH, half, numH, 'POWER', fresh ? power.hp : null, fresh ? power.peakHp : null, C(t, 'accent'), 'hp');
            drawPowerTile(cv, t, half, tabH, W - half, numH, 'TORQUE', fresh ? power.nm : null, fresh ? power.peakNm : null, '#3aa0ff', 'Nm');
            // chart
            const gy = tabH + numH, gh = area - numH;
            cv.text('POWER / TORQUE', 40, gy + 26, 20, C(t, 'textSecondary'), { font: 'bold' });
            if (power.hist.length > 1) {
                const now = Date.now(), t0 = now - 30000;
                const maxN = Math.max(1, ...power.hist.map((p) => p.nm));
                const maxH = Math.max(1, ...power.hist.map((p) => p.hp));
                const X = (ts) => 40 + (W - 80) * (ts - t0) / 30000;
                const YN = (nm) => gy + 30 + (gh - 50) * (1 - nm / maxN);
                const YH = (hp) => gy + 30 + (gh - 50) * (1 - hp / maxH);
                const pn = power.hist.filter((p) => p.t >= t0).map((p) => [X(p.t), YN(p.nm)]);
                const ph = power.hist.filter((p) => p.t >= t0).map((p) => [X(p.t), YH(p.hp)]);
                if (pn.length > 1) cv.polyline(pn, 3, C(t, 'accent'));
                if (ph.length > 1) cv.polyline(ph, 3, '#3aa0ff');
            }
        }
        function drawPowerTile(cv, t, x, y, tw, th, label, cur, peak, col, unit) {
            cv.roundRect(x + 4, y + 4, tw - 8, th - 8, 12, C(t, 'surface'));
            const pad = Math.round(th * 0.12);
            cv.text(label, x + pad, y + pad + Math.round(th * 0.14), Math.round(th * 0.15), C(t, 'textSecondary'), { font: 'bold', spacing: 1 });
            const vtxt = num(cur) ? String(Math.round(cur)) : '--';
            cv.text(vtxt, x + pad, y + Math.round(th * 0.58), Math.round(th * 0.42), num(cur) ? col : C(t, 'textTertiary'), { font: 'num' });
            const ut = unit || '';
            if (ut) cv.text(ut, x + pad + cv.textWidth(vtxt, Math.round(th * 0.42), { font: 'num' }) + 10, y + Math.round(th * 0.58), Math.round(th * 0.18), C(t, 'textSecondary'));
            cv.text('peak ' + (num(peak) ? String(Math.round(peak)) : '--'), x + tw - pad, y + Math.round(th * 0.58), Math.round(th * 0.16), C(t, 'textSecondary'), { align: 'right' });
        }

        function drawHpfp(cv, t, dd) {
            const tabH = Math.round(H * 0.09);
            const area = H - tabH;
            const rh = Math.floor(area / 2);
            const act = fuelPresAct(), req = fuelPresReq();
            drawTile(cv, t, 0, tabH, W / 2, rh, 'RAIL ACTUAL', act === null ? null : act, 0, tileColor('fuelPres', act), false);
            drawTile(cv, t, W / 2, tabH, W / 2, rh, 'RAIL REQUESTED', req === null ? null : req, 0, tileColor('fuelPresReq', req), false);
        }

        function drawIgn(cv, t, dd) {
            const tabH = Math.round(H * 0.09);
            const area = H - tabH;
            const rh = Math.floor(area / 2);
            const cw = Math.floor(W / 2);
            drawTile(cv, t, 0, tabH, cw, rh, 'IGN ADVANCE', num(v.ignAdv) ? v.ignAdv : null, 1, null, false);
            drawTile(cv, t, cw, tabH, cw, rh, 'KNOCK RETARD', num(v.knockRetard) ? v.knockRetard : null, 1, null, false);
            drawTile(cv, t, 0, tabH + rh, cw, rh, 'LAMBDA', currentLambda(), 2, null, false);
            drawTile(cv, t, cw, tabH + rh, cw, rh, 'MIX ADAPT', num(v.mixtureAdapt) ? v.mixtureAdapt : null, 3, null, false);
        }

        function drawFuelCool(cv, t, dd) {
            const tabH = Math.round(H * 0.09);
            const area = H - tabH, cols = 3, rows = 2;
            const cw = Math.floor(W / cols), rh = Math.floor(area / rows);
            const tiles = [
                ['FUEL TEMP', valueByKey('fuelTemp', dd), 0, false], ['THERMO', valueByKey('thermoPos', dd), 0, true],
                ['FAN', valueByKey('fanRpm', dd), 0, false], ['RADIATOR', valueByKey('radTemp', dd), 0, false],
                ['EGT', valueByKey('egt', dd), 0, false], ['IAT', valueByKey('iat', dd), 0, false],
            ];
            tiles.forEach(([label, val, dp, bar], i) => {
                drawTile(cv, t, (i % cols) * cw, tabH + Math.floor(i / cols) * rh, cw, rh, label, val, dp, null, bar);
            });
        }

        function drawElec(cv, t, dd) {
            const tabH = Math.round(H * 0.09);
            const area = H - tabH, cols = 2, rows = 2;
            const cw = Math.floor(W / cols), rh = Math.floor(area / rows);
            const tiles = [
                ['VOLTAGE', valueByKey('voltage', dd), 1, false], ['ALT TEMP', valueByKey('alternatorTemp', dd), 0, false],
                ['ALT LOAD', valueByKey('alternatorLoad', dd), 0, true], ['OUTPUT', valueByKey('currentOut', dd), 0, false],
            ];
            tiles.forEach(([label, val, dp, bar], i) => {
                drawTile(cv, t, (i % cols) * cw, tabH + Math.floor(i / cols) * rh, cw, rh, label, val, dp, null, bar);
            });
        }

        function drawTcase(cv, t, dd) {
            const tabH = Math.round(H * 0.09);
            const area = H - tabH;
            const rh = Math.floor(area / 2);
            const lock = tcaseLockPct();
            drawTile(cv, t, 0, tabH, W / 2, rh, 'LOCK-UP', lock === null ? null : Math.round(lock), 0, null, true);
            drawTile(cv, t, W / 2, tabH, W / 2, rh, 'SLIP RPM', valueByKey('slipRpm', dd), 0, null, false);
        }

        /* ---------------- LAP ---------------- */
        function lapStep(dd) {
            const spd = num(dd.speed) ? dd.speed : null;
            if (num(spd)) lapEma = lapEma === null ? spd : lapEma + (spd - lapEma) * 0.5;
            lap.curSpeed = lapEma;
            if (lap.state !== 'running') return;
            const el = (Date.now() - lap.startedAt) / 1000;
            const s = num(lapEma) ? lapEma : 0;
            for (const tgt of LAP_TARGETS) {
                if (!num(lap.crossed[tgt]) && s >= tgt) { lap.crossed[tgt] = el; log.info('lap: 0-' + tgt + ' in ' + el.toFixed(2) + ' s'); }
            }
            if (num(lap.crossed[100]) && num(lap.crossed[200])) lap.t100_200 = lap.crossed[200] - lap.crossed[100];
            const vals = { boost: boostBar(), fuelPres: fuelPresAct(), iat: num(v.iat) ? v.iat : null, egt: num(v.egt) ? v.egt : null, speed: num(dd.speed) ? dd.speed : null };
            for (const key of LAP_METRICS) { const val = vals[key]; if (num(val) && (!num(lap.maxes[key]) || val > lap.maxes[key])) lap.maxes[key] = val; }
        }
        function lapToggle(dd) {
            if (lap.state === 'running') { lap.state = 'done'; log.info('lap stopped'); return; }
            if (lap.state === 'done') { lap.state = 'idle'; lap.crossed = {}; lap.t100_200 = null; lap.maxes = {}; return; }
            if (num(dd.speed) && dd.speed >= 3) return;   // standstill only
            lap.state = 'running'; lap.startedAt = Date.now(); lap.crossed = {}; lap.t100_200 = null; lap.maxes = {}; lapEma = null;
            log.info('lap started');
        }
        function drawLap(cv, t, dd) {
            const tabH = Math.round(H * 0.09), area = H - tabH;
            const padX = Math.round(W * 0.03), sideW = Math.round(W * 0.20);
            const midX = padX + sideW + Math.round(W * 0.03);
            const midW = W - 2 * (sideW + Math.round(W * 0.03)) - padX;
            const spd = num(dd.speed) ? dd.speed : null;
            const cy = tabH + Math.round(area * 0.30);
            cv.text(spd !== null ? String(Math.round(spd)) : '--', midX + midW / 2, cy, Math.round(area * 0.26), lap.state === 'running' ? C(t, 'accent') : C(t, 'textPrimary'), { align: 'center', font: 'num' });
            cv.text(sU(), midX + midW / 2, cy + Math.round(area * 0.20), Math.round(area * 0.07), C(t, 'textSecondary'), { align: 'center' });
            // START/STOP button
            const btnW = Math.round(midW * 0.42), btnH = Math.round(area * 0.16);
            const btnX = midX + Math.round((midW - btnW) / 2), btnY = tabH + area - btnH - Math.round(area * 0.06);
            lap.btnRect = [btnX, btnY, btnW, btnH];
            const running = lap.state === 'running';
            cv.roundRect(btnX, btnY, btnW, btnH, 14, running ? C(t, 'alert') : '#1aa05a');
            cv.text(running ? 'STOP' : 'START', btnX + btnW / 2, btnY + btnH / 2 + 8, Math.round(btnH * 0.4), '#ffffff', { align: 'center', font: 'bold' });
            const status = running ? 'REC ' + ((Date.now() - lap.startedAt) / 1000).toFixed(1) + ' s' : lap.state === 'done' ? 'RUN COMPLETE' : 'SPEED MUST BE 0 TO START';
            cv.text(status, btnX + btnW / 2, btnY - Math.round(area * 0.05), Math.round(area * 0.05), C(t, 'textTertiary'), { align: 'center' });
            // left: live metrics
            const colTop = tabH + Math.round(area * 0.04);
            const rowH = Math.floor((area - Math.round(area * 0.04) - Math.round(area * 0.26)) / LAP_METRICS.length);
            LAP_METRICS.forEach((key, i) => {
                const showMax = lap.state === 'done' && num(lap.maxes[key]);
                const live = { boost: boostBar(), fuelPres: fuelPresAct(), iat: num(v.iat) ? v.iat : null, egt: num(v.egt) ? v.egt : null, speed: num(dd.speed) ? dd.speed : null }[key];
                const val = showMax ? lap.maxes[key] : live;
                const y = colTop + i * rowH;
                cv.text((showMax ? 'MAX ' : '') + key.toUpperCase(), padX, y, Math.round(rowH * 0.24), C(t, 'textSecondary'), { font: 'bold' });
                cv.text(num(val) ? val.toFixed(key === 'boost' ? 2 : 0) : '--', padX, y + rowH * 0.4, Math.round(rowH * 0.4), showMax ? C(t, 'accent') : (num(val) ? C(t, 'textPrimary') : C(t, 'textTertiary')), { font: 'num' });
            });
            // right: times
            const rx = midX + midW + Math.round(W * 0.03);
            const lt = (tgt) => num(lap.crossed[tgt]) ? lap.crossed[tgt].toFixed(2) : (lap.state === 'running' ? ((Date.now() - lap.startedAt) / 1000).toFixed(2) : '0.00');
            const entries = [
                ['0-100', lt(100), num(lap.crossed[100])],
                ['0-200', lt(200), num(lap.crossed[200])],
                ['100-200', num(lap.t100_200) ? lap.t100_200.toFixed(2) : (lap.state === 'running' && num(lap.crossed[100]) ? ((Date.now() - lap.startedAt) / 1000 - lap.crossed[100]).toFixed(2) : '0.00'), num(lap.t100_200)],
            ];
            const eH = Math.floor((area - Math.round(area * 0.04) - Math.round(area * 0.26)) / entries.length);
            entries.forEach(([label, txt, got], j) => {
                const y = colTop + j * eH;
                cv.text(label, rx, y, Math.round(eH * 0.22), C(t, 'textSecondary'), { font: 'bold' });
                cv.text(txt + ' sec', rx, y + eH * 0.4, Math.round(eH * 0.44), got ? C(t, 'accent') : C(t, 'textPrimary'), { font: 'num' });
            });
        }

        /* ---------------- MORE ---------------- */
        function boostGaugeStep() {
            const now = Date.now(), b = boostBar();
            if (num(b) && (!num(boostGauge.peak) || b > boostGauge.peak)) { boostGauge.peak = b; boostGauge.peakAt = now; }
            if (num(boostGauge.peak) && now - boostGauge.peakAt > 8000) boostGauge.peak = null;
        }
        function gearCorrStep(dd) {
            const b = boostBar();
            const now = Date.now();
            if (num(b) && num(gcPrev.boost) && now - gcPrev.t > 60 && now - gcPrev.t < 1200) {
                const rate = (b - gcPrev.boost) / ((now - gcPrev.t) / 1000);
                if (rate < -2.2 && gcPrev.boost > 0.5 && b > 0.05) {
                    gearCorr.events.unshift({ t: now, boost: gcPrev.boost, dip: gcPrev.boost - b });
                    if (gearCorr.events.length > 20) gearCorr.events.pop();
                    gearCorr.total++;
                }
            }
            gcPrev.t = now; gcPrev.boost = b;
        }
        function logRow(dd) {
            const d = new Date();
            const iso = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
            return [iso, num(dd.rpm) ? Math.round(dd.rpm) : '', num(dd.speed) ? Math.round(dd.speed) : '', num(boostBar()) ? boostBar().toFixed(2) : '',
                num(v.oilPress) ? v.oilPress.toFixed(1) : '', num(currentLambda()) ? currentLambda().toFixed(2) : '', num(dd.oil) ? Math.round(dd.oil) : '',
                num(dd.coolant) ? Math.round(dd.coolant) : '', num(v.egt) ? Math.round(v.egt) : '', num(v.iat) ? Math.round(v.iat) : '',
                num(v.fuelPresAct) ? v.fuelPresAct.toFixed(1) : '', num(v.ignAdv) ? v.ignAdv.toFixed(1) : '', num(v.knockRetard) ? v.knockRetard.toFixed(1) : '',
                num(v.voltage) ? v.voltage.toFixed(1) : '', alternatorLoadPct() === null ? '' : Math.round(alternatorLoadPct()), tcaseLockPct() === null ? '' : Math.round(tcaseLockPct()),
                counters.knock, counters.misfire].join(',');
        }
        function loggingStep(dd) {
            if (!logState.active) return;
            const now = Date.now();
            if (now - logState.lastRowAt < 500) return;
            logState.lastRowAt = now;
            const line = logRow(dd);
            try {
                const f = path.join(ctx.dataDir, 'vmgauge_log.csv');
                const head = 't_iso,rpm,speed,boost,oil_press,lambda,oil_temp,coolant,egt,iat,rail_act,ign_adv,knock_ret,voltage,alt_load,tc_lock,knock_ev,misfire_ev\n';
                if (!fs.existsSync(f)) fs.writeFileSync(f, head);
                fs.appendFileSync(f, line + '\n');
                logState.rows++;
            } catch (e) { log.warn('log write: ' + e); }
        }
        function drawMore(cv, t, dd) {
            const tabH = Math.round(H * 0.09);
            const mTh = Math.round(H * 0.075);
            const w = Math.floor(W / MORE_TABS.length);
            cv.fillRect(0, tabH, W, mTh, C(t, 'surface'));
            MORE_TABS.forEach((id, i) => {
                const active = id === gMoreTab;
                const x = i * w;
                cv.text(id.toUpperCase(), x + w / 2, tabH + mTh * 0.6, Math.round(mTh * 0.42), active ? C(t, 'accent') : C(t, 'textSecondary'), { align: 'center', font: active ? 'bold' : 'label' });
                if (active) cv.fillRect(x + w * 0.2, tabH + mTh - 3, w * 0.6, 3, C(t, 'accent'));
            });
            const mTop = tabH + mTh;
            if (gMoreTab === 'boost') drawBoostGauge(cv, t, mTop);
            else if (gMoreTab === 'gearcorr') drawGearCorr(cv, t, mTop);
            else if (gMoreTab === 'exhaust') drawExhaust(cv, t, mTop);
            else if (gMoreTab === 'logs') drawLogs(cv, t, mTop);
            else drawProfiles(cv, t, mTop);
        }
        function drawBoostGauge(cv, t, top) {
            const area = H - top;
            const maxB = 2.5;
            const cur = boostBar();
            const cx = W / 2, cy = top + Math.round(area * 0.78);
            const R = Math.min(Math.round(area * 0.62), Math.round(W * 0.30));
            cv.roundRect(cx - R - 40, top + 8, 2 * R + 80, area - 16, 14, C(t, 'surface'));
            const a0 = 180, a1 = 360;   // degrees clockwise from 12 o'clock
            const ang = (val) => a0 + (a1 - a0) * clamp(val / maxB, 0, 1);
            cv.arc(cx, cy, R - 6, R, a0, a1, C(t, 'divider'));
            cv.arc(cx, cy, R - 6, R, ang(0), ang(maxB * 0.6), '#1aa05a');
            cv.arc(cx, cy, R - 6, R, ang(maxB * 0.8), ang(maxB), '#e8452c');
            // ticks + numbers
            for (let i = 0; i <= Math.round(maxB / 0.5); i++) {
                const tv = i * 0.5, ta = ang(tv) * Math.PI / 180;
                const rIn = R - (tv % 1 === 0 ? R * 0.16 : R * 0.09);
                cv.line(cx + R * Math.cos(ta), cy + R * Math.sin(ta), cx + rIn * Math.cos(ta), cy + rIn * Math.sin(ta), tv % 1 === 0 ? 3 : 1, tv % 1 === 0 ? C(t, 'textSecondary') : C(t, 'textTertiary'));
                if (tv % 1 === 0) cv.text(tv.toFixed(0), cx + (R * 0.78) * Math.cos(ta), cy + (R * 0.78) * Math.sin(ta), Math.round(R * 0.11), C(t, 'textSecondary'), { align: 'center' });
            }
            // needle
            const nv = num(cur) ? Math.max(0, cur) : 0, na = ang(nv) * Math.PI / 180;
            cv.line(cx - R * 0.08 * Math.cos(na), cy - R * 0.08 * Math.sin(na), cx + R * 0.92 * Math.cos(na), cy + R * 0.92 * Math.sin(na), Math.max(3, R * 0.035), C(t, 'textPrimary'));
            cv.circle(cx, cy, Math.max(5, R * 0.05), C(t, 'accent'));
            cv.text(num(cur) ? cur.toFixed(2) : '--', cx, cy + R * 0.10, Math.round(R * 0.22), num(cur) ? (cur > maxB * 0.8 ? '#e8452c' : C(t, 'textPrimary')) : C(t, 'textTertiary'), { align: 'center', font: 'num' });
            cv.text('BOOST', cx, cy + R * 0.34, Math.round(R * 0.10), C(t, 'textSecondary'), { align: 'center' });
            // peak
            cv.text('PEAK ' + (num(boostGauge.peak) ? boostGauge.peak.toFixed(2) : '--') + ' bar', cx - R - 20, top + Math.round(area * 0.10), Math.round(area * 0.06), C(t, 'textSecondary'), { font: 'bold' });
        }
        function drawGearCorr(cv, t, top) {
            const area = H - top;
            cv.text('GEAR CORRECTIONS', 40, top + 40, 28, C(t, 'textPrimary'), { font: 'bold' });
            cv.text('total ' + gearCorr.total, 40, top + 80, 22, C(t, 'textSecondary'));
            gearCorr.events.slice(0, 8).forEach((e, i) => {
                const y = top + 130 + i * 44;
                cv.text('dip ' + e.dip.toFixed(2) + ' bar', 40, y, 24, C(t, 'warn'), { font: 'num' });
                cv.text(new Date(e.t).toLocaleTimeString(), 300, y, 20, C(t, 'dim'));
            });
        }
        function drawExhaust(cv, t, top) {
            const area = H - top;
            cv.text('EXHAUST FLAP', 40, top + 40, 28, C(t, 'textPrimary'), { font: 'bold' });
            cv.text('UDS write (flap open/close) — not wired yet', 40, top + 90, 22, C(t, 'textTertiary'));
        }
        function drawLogs(cv, t, top) {
            const area = H - top;
            cv.text('LOGGING', 40, top + 40, 28, C(t, 'textPrimary'), { font: 'bold' });
            const btnW = 300, btnH = 70, bx = 40, by = top + 90;
            logState.btnRect = [bx, by, btnW, btnH];
            cv.roundRect(bx, by, btnW, btnH, 12, logState.active ? C(t, 'alert') : '#1aa05a');
            cv.text(logState.active ? 'STOP' : 'REC', bx + btnW / 2, by + btnH / 2 + 8, 26, '#ffffff', { align: 'center', font: 'bold' });
            cv.text('rows: ' + logState.rows + '  ->  ' + path.join(ctx.dataDir, 'vmgauge_log.csv'), 40, by + btnH + 30, 20, C(t, 'textSecondary'));
        }
        function drawProfiles(cv, t, top) {
            const area = H - top;
            cv.text('PROFILES', 40, top + 40, 28, C(t, 'textPrimary'), { font: 'bold' });
            cv.text('save / load settings — coming', 40, top + 90, 22, C(t, 'textTertiary'));
        }

        /* ---------------- render ---------------- */
        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const dd = d();
            v.rpm = dd.rpm; v.coolant = dd.coolant; v.oilTemp = dd.oil; v.speed = dd.speed;
            computePower(dd);
            handleKnock(dd);
            lapStep(dd);
            boostGaugeStep();
            gearCorrStep(dd);
            loggingStep(dd);
            drawTabs(cv, t);
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
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 4, render);

        // taps: tab strip, LAP button, MORE sub-tabs, logs REC
        const inRect = (r, x, y) => r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
        ctx.onTap((x, y) => {
            const tabH = Math.round(H * 0.09);
            if (y <= tabH) {
                const i = clamp(Math.floor(x / (W / TABS.length)), 0, TABS.length - 1);
                gTab = TABS[i].id;
                return;
            }
            if (gTab === 'lap') {
                if (inRect(lap.btnRect, x, y)) lapToggle(d());
                return;
            }
            if (gTab === 'more') {
                const mTh = Math.round(H * 0.075);
                if (y <= tabH + mTh) {
                    const i = clamp(Math.floor(x / (W / MORE_TABS.length)), 0, MORE_TABS.length - 1);
                    gMoreTab = MORE_TABS[i];
                    return;
                }
                if (gMoreTab === 'logs' && inRect(logState.btnRect, x, y)) {
                    logState.active = !logState.active;
                    logState.rows = 0;
                    log.info(logState.active ? 'logging on' : 'logging off');
                }
            }
        });

        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
