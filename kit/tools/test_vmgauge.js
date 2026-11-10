'use strict';

// Smoke test: every VMGauge tab renders without throwing (stubbed diag/dids, demo mode).
//   node kit/tools/test_vmgauge.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'vmgauge', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'vmgauge', 'app.json'), 'utf8'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));

global.setInterval = () => 0;
let app = null;
class FakeDiag extends EventEmitter { constructor() { super(); this.available = false; } init() { return Promise.resolve(this); } }
class FakeReader { constructor() { this.raws = {}; this.pick = {}; } static label(c) { return c.did; } key(c) { return c.did; } async value() { return null; } }
const stubs = {
    './kit/mgu': { run(a) { app = a; } },
    './kit/diag': { Diag: FakeDiag, hex: require(path.join(KIT, 'diag')).hex },
    './kit/dids': { DidReader: FakeReader },
};
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

(async () => {
    delete require.cache[MAIN];
    require(MAIN);
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    S.demo = 'on';
    let frame = null;
    const ctx = {
        ui: { onClick() {}, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], onChange() {} },
        log: { info() {}, warn() {}, error() {} }, spec: SPEC, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-')),
        signals: { watch: () => Promise.resolve({}) },
        onTab(fn) { this.tab = fn; }, hideButton() {}, onScroll() {}, onTap(fn) { this.tap = fn; }, loop(n, fps, fn) { frame = fn; },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => { const cv = new Canvas(w, h); cv.own = true; return cv; },
    };
    await app.start(ctx);
    const TABS = ['main', 'power', 'hpfp', 'ign', 'fuelcool', 'elec', 'tcase', 'lap', 'more'];
    for (let i = 0; i < TABS.length; i++) {
        await ctx.tab(i);
        await frame();
        console.log('tab ok: ' + TABS[i]);
    }
    // tap handlers should not throw
    if (ctx.tap) { ctx.tap(800, 500); ctx.tap(800, 300); }
    console.log('VMGauge render smoke test passed (' + TABS.length + ' tabs).');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
