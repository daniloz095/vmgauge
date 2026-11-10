'use strict';

// Dump each VMGauge tab as a PNG (software rasterization) for a visual check.
//   node kit/tools/dump_vmgauge.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'vmgauge', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'vmgauge', 'app.json'), 'utf8'));
const { Recorder } = require(path.join(KIT, 'record'));
const { Canvas } = require(path.join(KIT, 'canvas'));
const { play } = require(path.join(KIT, 'record'));
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
    let frame = null, last = null;
    const ctx = {
        ui: { onClick() {}, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], onChange() {} },
        log: { info() {}, warn() {}, error() {} }, spec: SPEC, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-')),
        signals: { watch: () => Promise.resolve({}) },
        onTab(fn) { this.tab = fn; }, hideButton() {}, onScroll() {}, onTap() {}, loop(n, fps, fn) { frame = fn; },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => { last = new Recorder(w, h); last.extra = 0; return last; },
    };
    await app.start(ctx);
    const out = path.join(os.tmpdir(), 'vmg-dump');
    fs.mkdirSync(out, { recursive: true });
    const TABS = ['main', 'power', 'hpfp', 'ign', 'fuelcool', 'elec', 'tcase', 'lap', 'more'];
    for (let i = 0; i < TABS.length; i++) {
        await ctx.tab(i);
        await frame();
        const real = new Canvas(1600, 520);
        play(last.words(), real);
        fs.writeFileSync(path.join(out, TABS[i] + '.png'), real.png());
        console.log('dumped ' + TABS[i] + '.png');
    }
    console.log('PNGs in ' + out);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
