require('dotenv').config();

const { app, BrowserWindow, Tray, Menu, session, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const zamekInstance = app.requestSingleInstanceLock();
if (!zamekInstance) {
    console.log('Aplikace už běží (podívejte se na ikonu u hodin). Tahle instance se ukončuje.');
    app.quit();
} else {
    app.on('second-instance', () => {
        const okno = BrowserWindow.getAllWindows()[0];
        if (okno) {
            if (okno.isMinimized()) okno.restore();
            okno.focus();
            return;
        }
        if (!jeNakonfigurovano()) vytvorPruvodce();
        else if (jeJenServer()) otevriSpravu();
        else vytvorKiosek();
    });
}

app.setPath('sessionData', path.join(app.getPath('userData'), 'session'));

app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'disable_non_proxied_udp');

const SLOZKA_APLIKACE = __dirname;
const SLOZKA_SERVERU = app.isPackaged
    ? path.join(process.resourcesPath, 'API_Server')
    : path.resolve(__dirname, '..', 'API_Server');

const KONFIG_DIR = app.getPath('userData');
try { fs.mkdirSync(KONFIG_DIR, { recursive: true }); } catch (e) {}

const APP_ENV_PATH = path.join(KONFIG_DIR, 'app.env');
const SERVER_ENV_PATH = path.join(KONFIG_DIR, 'server.env');
const THEME_PATH = path.join(KONFIG_DIR, 'theme.json');

function envPath(ktera) {
    return ktera === 'server' ? SERVER_ENV_PATH : APP_ENV_PATH;
}

let hlavniOkno = null;
let oknoSpravy = null;
let tray = null;
let serverProces = null;

function ctiEnvFile(cesta) {
    const out = {};
    if (!fs.existsSync(cesta)) return out;
    for (const line of fs.readFileSync(cesta, 'utf-8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i === -1) continue;
        out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
}

function zapisEnvFile(cesta, hodnoty) {
    try { fs.mkdirSync(path.dirname(cesta), { recursive: true }); } catch (e) {}
    const vysledek = { ...ctiEnvFile(cesta), ...hodnoty };
    const radky = Object.entries(vysledek)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(cesta, radky.join('\n') + '\n', 'utf-8');
    return cesta;
}

function migrujStareEnv() {
    try {
        const stareApp = path.join(SLOZKA_APLIKACE, '.env');
        if (fs.existsSync(stareApp)) {
            const stare = ctiEnvFile(stareApp);
            if (!fs.existsSync(APP_ENV_PATH)) {
                zapisEnvFile(APP_ENV_PATH, stare);
            } else {
                const aktualni = ctiEnvFile(APP_ENV_PATH);
                const doplnit = {};
                for (const [k, v] of Object.entries(stare)) {
                    if (v && (aktualni[k] === undefined || aktualni[k] === '')) doplnit[k] = v;
                }
                if (Object.keys(doplnit).length) zapisEnvFile(APP_ENV_PATH, doplnit);
            }
        }
    } catch (e) {}
    try {
        const stareSrv = path.join(SLOZKA_SERVERU, '.env');
        if (fs.existsSync(stareSrv)) {
            const stare = ctiEnvFile(stareSrv);
            if (!fs.existsSync(SERVER_ENV_PATH)) {
                zapisEnvFile(SERVER_ENV_PATH, stare);
            } else {
                const aktualni = ctiEnvFile(SERVER_ENV_PATH);
                const doplnit = {};
                for (const [k, v] of Object.entries(stare)) {
                    if (v && (aktualni[k] === undefined || aktualni[k] === '')) doplnit[k] = v;
                }
                if (Object.keys(doplnit).length) zapisEnvFile(SERVER_ENV_PATH, doplnit);
            }
        }
    } catch (e) {}
}

function jeNakonfigurovano() {
    const ea = ctiEnvFile(APP_ENV_PATH);
    return ea.NAKONFIGUROVANO === '1' || !!ea.API_KEY;
}

function rezimZarizeni() {
    return ctiEnvFile(APP_ENV_PATH).REZIM || '';
}
function jeJenServer() {
    return rezimZarizeni() === 'server';
}

function vzdalenyServer() {
    const ea = ctiEnvFile(APP_ENV_PATH);
    if (ea.SPUSTIT_SERVER === '1' || serverProces || jeJenServer()) return null;
    const host = ea.API_HOST;
    if (!host || host === '127.0.0.1' || host === 'localhost') return null;
    const es = ctiEnvFile(SERVER_ENV_PATH);
    return { host, port: Number(es.PORT || ea.PORT) || 3000, klic: ea.API_KEY || '' };
}

function zapisKlicDoSouboru(cesta, klic) {
    try {
        if (!fs.existsSync(cesta)) return false;
        let text = fs.readFileSync(cesta, 'utf-8');
        const bezpecny = klic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('^\\s*API_KEY\\s*=\\s*' + bezpecny + '\\s*$', 'm').test(text)) return false;
        if (/^\s*API_KEY\s*=.*$/m.test(text)) text = text.replace(/^\s*API_KEY\s*=.*$/m, 'API_KEY=' + klic);
        else text += (text.endsWith('\n') ? '' : '\n') + 'API_KEY=' + klic + '\n';
        fs.writeFileSync(cesta, text, 'utf-8');
        return true;
    } catch (e) { return false; }
}

function srovnejApiKlice() {
    try {
        const ea = ctiEnvFile(APP_ENV_PATH);
        const es = ctiEnvFile(SERVER_ENV_PATH);
        const oprava = {};
        const lokalniServer = ea.SPUSTIT_SERVER === '1'
            || !ea.API_HOST || ea.API_HOST === '127.0.0.1' || ea.API_HOST === 'localhost';
        if (es.API_KEY && lokalniServer && ea.API_KEY !== es.API_KEY) {
            oprava.API_KEY = es.API_KEY;
            console.log('API klíč aplikace se lišil od lokálního serveru – srovnán podle server.env.');
        }
        if (ea.SPUSTIT_SERVER === '1' && ea.API_HOST && ea.API_HOST !== '127.0.0.1' && ea.API_HOST !== 'localhost') {
            oprava.API_HOST = '127.0.0.1';
            console.log('API_HOST přepnut na 127.0.0.1 (server běží lokálně, adresa ' + ea.API_HOST + ' se nepoužije).');
        }
        if (Object.keys(oprava).length) zapisEnvFile(APP_ENV_PATH, oprava);
        if (es.API_KEY && lokalniServer) {
            if (zapisKlicDoSouboru(path.join(SLOZKA_APLIKACE, '.env'), es.API_KEY)) {
                console.log('API klíč sjednocen i v App_ELek/.env.');
            }
            if (zapisKlicDoSouboru(path.join(SLOZKA_SERVERU, '.env'), es.API_KEY)) {
                console.log('API klíč sjednocen i v API_Server/.env.');
            }
        }
    } catch (e) {}
}

function ctiTheme() {
    try { return JSON.parse(fs.readFileSync(THEME_PATH, 'utf-8')); } catch (e) { return {}; }
}

function argKonfigDir() {
    return '--konfig-dir=' + KONFIG_DIR;
}

function vytvorKiosek() {
    hlavniOkno = new BrowserWindow({
        width: 1280,
        height: 800,
        fullscreen: true,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            additionalArguments: [argKonfigDir()]
        }
    });
    hlavniOkno.removeMenu();
    if (process.env.DEBUG === '1') hlavniOkno.webContents.openDevTools();
    hlavniOkno.loadFile(path.join(SLOZKA_APLIKACE, 'www', 'index.html'));
    hlavniOkno.on('closed', () => { hlavniOkno = null; });
}

function vytvorPruvodce() {
    const okno = new BrowserWindow({
        width: 1000,
        height: 740,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            additionalArguments: [argKonfigDir()]
        }
    });
    okno.removeMenu();
    if (process.env.DEBUG === '1') okno.webContents.openDevTools();
    okno.loadFile(path.join(SLOZKA_APLIKACE, 'pruvodce.html'));
    return okno;
}

let oknoNastaveni = null;
function vytvorNastaveni() {
    if (oknoNastaveni && !oknoNastaveni.isDestroyed()) { oknoNastaveni.focus(); return oknoNastaveni; }
    oknoNastaveni = new BrowserWindow({
        width: 1360,
        height: 860,
        minWidth: 1080,
        minHeight: 680,
        autoHideMenuBar: true,
        title: 'Nastavení kiosku',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            additionalArguments: [argKonfigDir()]
        }
    });
    oknoNastaveni.removeMenu();
    if (process.env.DEBUG === '1') oknoNastaveni.webContents.openDevTools();
    oknoNastaveni.loadFile(path.join(SLOZKA_APLIKACE, 'nastaveni.html'));
    oknoNastaveni.on('closed', () => { oknoNastaveni = null; });
    return oknoNastaveni;
}

function dotazNaApi(cil, cesta, metoda, telo) {
    return new Promise((resolve, reject) => {
        const data = telo ? JSON.stringify(telo) : null;
        const req = http.request({
            method: metoda || 'GET', hostname: cil.host, port: cil.port, path: cesta,
            headers: {
                'x-api-key': cil.klic,
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
            },
            timeout: 6000
        }, res => {
            let text = '';
            res.on('data', d => text += d);
            res.on('end', () => {
                try { resolve(JSON.parse(text)); }
                catch (e) { reject(new Error('Server odpověděl nečekaně (' + res.statusCode + ').')); }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Server neodpovídá.')); });
        req.on('error', e => reject(e));
        if (data) req.write(data);
        req.end();
    });
}

async function adresaSpravy() {
    const es = ctiEnvFile(SERVER_ENV_PATH);
    const ea = ctiEnvFile(APP_ENV_PATH);
    const port = es.PORT || ea.PORT || 3000;
    const cesta = es.ADMIN_PATH || '/sprava';
    const cil = vzdalenyServer();
    if (!cil) return `http://127.0.0.1:${port}${cesta}`;
    const odpoved = await dotazNaApi(cil, '/api/sprava-adresa', 'GET');
    if (!odpoved.cesta) throw new Error('Server aktuální adresu správy nevrátil.');
    return `http://${cil.host}:${cil.port}${odpoved.cesta}`;
}

async function otevriSpravu() {
    if (oknoSpravy && !oknoSpravy.isDestroyed()) { oknoSpravy.focus(); return; }
    let adresa;
    try {
        adresa = await adresaSpravy();
    } catch (e) {
        dialog.showErrorBox('Správa není dostupná',
            'Nepodařilo se od serveru zjistit adresu správy.\n\n' + e.message
            + '\n\nZkontrolujte, že API server běží a kiosek je s ním spárovaný (Nastavení → Systém).');
        return;
    }
    oknoSpravy = new BrowserWindow({
        width: 1100,
        height: 780,
        autoHideMenuBar: true,
        title: 'Správa',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    oknoSpravy.removeMenu();
    oknoSpravy.loadURL(adresa).catch(() => {
        dialog.showErrorBox('Správa není dostupná', 'Server neběží nebo je jinde v síti. Zkontrolujte, že API server je spuštěný.');
    });
    oknoSpravy.on('closed', () => { oknoSpravy = null; });
}

let serverLog = [];
let serverPosledniChyba = null;

function pridejDoServerLogu(text) {
    for (const radek of String(text).split(/\r?\n/)) {
        if (!radek.trim()) continue;
        serverLog.push(radek.trim());
    }
    if (serverLog.length > 120) serverLog = serverLog.slice(-120);
}

function spustServer() {
    if (serverProces) return true;
    const serverJs = path.join(SLOZKA_SERVERU, 'server.js');
    if (!fs.existsSync(serverJs)) {
        serverPosledniChyba = 'Soubor server.js nebyl nalezen (' + serverJs + ').';
        return false;
    }
    serverPosledniChyba = null;
    const nodePath = [
        path.join(SLOZKA_SERVERU, 'node_modules'),
        path.join(SLOZKA_APLIKACE, 'node_modules'),
        process.env.NODE_PATH || ''
    ].filter(Boolean).join(path.delimiter);
    serverProces = spawn(process.execPath, [serverJs], {
        cwd: SLOZKA_SERVERU,
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            SERVER_ENV_PATH,
            NODE_PATH: nodePath
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProces.stdout.on('data', d => { const t = String(d).trim(); console.log('[server]', t); pridejDoServerLogu(t); });
    serverProces.stderr.on('data', d => {
        const t = String(d).trim();
        console.error('[server]', t);
        pridejDoServerLogu(t);
        const radky = t.split(/\r?\n/).filter(r => r.trim());
        if (radky.length) serverPosledniChyba = radky[radky.length - 1];
    });
    serverProces.on('exit', code => {
        console.log('[server] skoncil, kod', code);
        if (code !== 0 && !serverPosledniChyba) serverPosledniChyba = 'Server skončil s kódem ' + code + '.';
        serverProces = null;
    });
    return true;
}

function serverPort() {
    const es = ctiEnvFile(SERVER_ENV_PATH);
    return Number(es.PORT) || 3000;
}

function zkusZdravi(port) {
    return new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, res => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function pockejNaServer(maxMs = 10000) {
    const port = serverPort();
    const zacatek = Date.now();
    while (Date.now() - zacatek < maxMs) {
        if (await zkusZdravi(port)) return { ok: true, port };
        if (!serverProces) break;
        await new Promise(r => setTimeout(r, 400));
    }
    return {
        ok: false,
        port,
        chyba: serverPosledniChyba || (serverProces ? 'Server běží, ale neodpovídá na portu ' + port + '.' : 'Server se nespustil.'),
        log: serverLog.slice(-15)
    };
}

function zastavServer() {
    if (!serverProces) return;
    try { serverProces.kill('SIGINT'); } catch (e) {}
    serverProces = null;
}

function trayIkona() {
    const { nativeImage } = require('electron');
    const t = ctiTheme();
    const kandidati = [];
    if (t.logo && /\.(png|jpe?g)$/i.test(t.logo)) kandidati.push(t.logo);
    kandidati.push(
        path.join(SLOZKA_APLIKACE, 'www', 'ikona.png'),
        path.join(SLOZKA_APLIKACE, 'www', 'logo-lintech-dark.png')
    );
    for (const cesta of kandidati) {
        try {
            if (!fs.existsSync(cesta)) continue;
            const obrazek = nativeImage.createFromPath(cesta);
            if (obrazek.isEmpty()) continue;
            return obrazek.resize({ width: 22 });
        } catch (e) {}
    }
    return null;
}

function trayMenu() {
    const polozky = [];
    if (!jeJenServer()) {
        polozky.push({ label: 'Kiosek', click: () => { if (!hlavniOkno) vytvorKiosek(); else hlavniOkno.focus(); } });
    }
    polozky.push(
        { label: 'Nastavení', click: vytvorNastaveni },
        { label: 'Správa', click: otevriSpravu }
    );
    if (!jeNakonfigurovano()) polozky.push({ label: 'Průvodce instalací', click: vytvorPruvodce });
    polozky.push(
        { type: 'separator' },
        { label: 'Restartovat aplikaci', click: () => restartujAplikaci() },
        { label: 'Ukončit', click: () => app.quit() }
    );
    return Menu.buildFromTemplate(polozky);
}

function obnovTrayMenu() {
    if (tray) try { tray.setContextMenu(trayMenu()); } catch (e) {}
}

function vytvorTray() {
    try {
        const ikona = trayIkona();
        if (!ikona) return;
        tray = new Tray(ikona);
    } catch (e) { return; }
    const nazev = ctiTheme().companyName || 'GuestBook';
    tray.setToolTip(nazev + ' – GuestBook');
    tray.setContextMenu(trayMenu());
}

function stahniText(url, limit = 400000) {
    return new Promise((resolve, reject) => {
        const klient = url.startsWith('https') ? https : http;
        const req = klient.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (Kiosek setup)' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const dalsi = new URL(res.headers.location, url).href;
                res.resume();
                return stahniText(dalsi, limit).then(resolve, reject);
            }
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', ch => { data += ch; if (data.length > limit) { req.destroy(); resolve(data); } });
            res.on('end', () => resolve(data));
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Časový limit vypršel.')); });
        req.on('error', reject);
    });
}

function stahniBuffer(url) {
    return new Promise((resolve, reject) => {
        const klient = url.startsWith('https') ? https : http;
        const req = klient.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (Kiosek setup)' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const dalsi = new URL(res.headers.location, url).href;
                res.resume();
                return stahniBuffer(dalsi).then(resolve, reject);
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const kusy = [];
            res.on('data', ch => kusy.push(ch));
            res.on('end', () => resolve({ buffer: Buffer.concat(kusy), contentType: res.headers['content-type'] || '' }));
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Časový limit vypršel.')); });
        req.on('error', reject);
    });
}

function najdiBarvyZCss(html, css) {
    const text = html + '\n' + css;
    const pocty = new Map();
    const re = /#([0-9a-fA-F]{6})\b/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const hex = '#' + m[1].toLowerCase();
        pocty.set(hex, (pocty.get(hex) || 0) + 1);
    }
    const naRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const sytost = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
    const jas = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const kandidati = [...pocty.entries()]
        .map(([hex, n]) => { const rgb = naRgb(hex); return { hex, n, s: sytost(rgb), j: jas(rgb), rgb }; })
        .filter(k => k.s > 0.25 && k.j > 0.08 && k.j < 0.92)
        .sort((a, b) => b.n - a.n);
    let primarni = kandidati.length ? (kandidati.find(k => k.j < 0.5) || kandidati[0]).hex : '#00205B';
    let akcent = kandidati.map(k => k.hex).find(h => h !== primarni) || '#EE2737';
    return { primarni, akcent };
}

function najdiLogo(html, zakladUrl) {
    const vzory = [
        /property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
        /content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
        /rel=["'](?:icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["']/i,
        /<img[^>]*(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i,
        /<img[^>]*src=["']([^"']*logo[^"']*)["']/i
    ];
    for (const re of vzory) {
        const m = html.match(re);
        if (m) { try { return new URL(m[1], zakladUrl).href; } catch (e) {} }
    }
    return null;
}

function najdiNazevFirmy(html) {
    let m = html.match(/property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
    if (m) return m[1].trim();
    m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) return m[1].split(/[|\-–—·]/)[0].trim();
    return '';
}

function jeFontNazev(v) {
    return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 \-]{1,38}$/.test(v.trim())
        && !/^(sans-serif|serif|monospace|inherit|initial|unset|system-ui|arial|helvetica)$/i.test(v.trim());
}

function hexNaHsl(hex) {
    const m = String(hex).replace('#', '');
    const r = parseInt(m.slice(0, 2), 16) / 255;
    const g = parseInt(m.slice(2, 4), 16) / 255;
    const b = parseInt(m.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h * 360, s, l };
}

function hslNaHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const f = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
    }
    const x = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return '#' + x(r) + x(g) + x(b);
}

function upravPaletu(p) {
    let prim = hexNaHsl(p.primarni);
    if (prim.l > 0.42) prim = { h: prim.h, s: Math.min(prim.s, 0.85), l: 0.24 };
    else if (prim.l < 0.08) prim = { h: prim.h, s: prim.s, l: 0.15 };
    if (prim.s > 0.9) prim.s = 0.85;
    p.primarni = hslNaHex(prim.h, prim.s, prim.l);

    let ak = hexNaHsl(p.akcent);
    if (ak.l > 0.62) ak.l = 0.5;
    if (ak.l < 0.28) ak.l = 0.42;
    ak.s = Math.min(ak.s, 0.88);
    if (ak.s < 0.35) ak.s = 0.55;
    if (ak.h >= 60 && ak.h <= 200) {
        ak.s = Math.min(ak.s, 0.62);
        ak.l = Math.min(Math.max(ak.l, 0.34), 0.46);
    }
    p.akcent = hslNaHex(ak.h, ak.s, ak.l);

    const poz = jeHex(p.pozadi) ? hexNaHsl(p.pozadi) : null;
    if (!poz || poz.l < 0.93 || poz.s > 0.2) p.pozadi = '#f4f6f9';

    if (!jeHex(p.text) || hexNaHsl(p.text).l > 0.45) p.text = '#454142';
    return p;
}

function odvozenePalety(primarni) {
    const h = hexNaHsl(primarni).h;
    return [
        upravPaletu({ nazev: 'Decentní', primarni, akcent: hslNaHex(h, 0.45, 0.46), pozadi: '#f5f6f8', text: '#454142' }),
        upravPaletu({ nazev: 'S teplým akcentem', primarni, akcent: hslNaHex(16, 0.75, 0.5), pozadi: '#f7f5f2', text: '#454142' })
    ];
}

function screenshotWebu(url) {
    return new Promise((resolve) => {
        let hotovo = false;
        const okno = new BrowserWindow({
            width: 1280, height: 950, show: false,
            webPreferences: {
                offscreen: true,
                sandbox: true,
                nodeIntegration: false,
                contextIsolation: true,
                backgroundThrottling: false
            }
        });
        const konec = (img) => {
            if (hotovo) return;
            hotovo = true;
            try { okno.destroy(); } catch (e) {}
            resolve(img && !img.isEmpty() ? img : null);
        };
        const zachyt = async () => {
            try { konec(await okno.webContents.capturePage()); } catch (e) { konec(null); }
        };
        const pojistka = setTimeout(zachyt, 10000);
        okno.webContents.once('did-finish-load', () => setTimeout(() => { clearTimeout(pojistka); zachyt(); }, 2200));
        okno.webContents.once('did-fail-load', () => { clearTimeout(pojistka); konec(null); });
        okno.loadURL(url).catch(() => { clearTimeout(pojistka); konec(null); });
    });
}

function paletyZeSnimku(obraz) {
    try {
        const maly = obraz.resize({ width: 200 });
        const { width, height } = maly.getSize();
        const buf = maly.toBitmap(); 
        const kose = new Map();
        for (let i = 0; i < width * height; i++) {
            const b = buf[i * 4] / 255, g = buf[i * 4 + 1] / 255, r = buf[i * 4 + 2] / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const l = (max + min) / 2;
            const d = max - min;
            const s = l > 0.5 ? (d / (2 - max - min) || 0) : (d / (max + min) || 0);
            if (l < 0.08 || l > 0.92 || s < 0.22) continue;
            let h;
            if (d === 0) h = 0;
            else if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
            else if (max === g) h = ((b - r) / d + 2) / 6;
            else h = ((r - g) / d + 4) / 6;
            const kos = Math.round(h * 24) % 24;
            const z = kose.get(kos) || { pocet: 0, hx: 0, hy: 0, s: 0, l: 0 };
            const uhel = h * 2 * Math.PI;
            z.pocet++; z.hx += Math.cos(uhel); z.hy += Math.sin(uhel); z.s += s; z.l += l;
            kose.set(kos, z);
        }
        const barvy = [...kose.values()]
            .filter(z => z.pocet >= 6)
            .map(z => {
                let h = Math.atan2(z.hy, z.hx) / (2 * Math.PI) * 360;
                if (h < 0) h += 360;
                return { pocet: z.pocet, h, s: z.s / z.pocet, l: z.l / z.pocet };
            })
            .sort((a, b) => b.pocet - a.pocet);
        if (!barvy.length) return [];

        const palety = [];
        const hlavni = barvy[0];
        const jina = barvy.slice(1).find(z => {
            const rozdil = Math.abs(z.h - hlavni.h);
            const kruh = Math.min(rozdil, 360 - rozdil);
            return kruh > 35;
        });
        const akcentH = jina ? jina.h : (hlavni.h + 175) % 360;
        const akcentS = jina ? jina.s : 0.7;

        palety.push(upravPaletu({ nazev: 'Podle webu', primarni: hslNaHex(hlavni.h, Math.max(hlavni.s, 0.5), 0.26), akcent: hslNaHex(akcentH, Math.max(akcentS, 0.55), 0.5), pozadi: '#f5f6f9', text: '#454142' }));
        palety.push(upravPaletu({ nazev: 'Sladěná', primarni: hslNaHex(hlavni.h, Math.max(hlavni.s, 0.5), 0.24), akcent: hslNaHex((hlavni.h + 20) % 360, 0.68, 0.5), pozadi: '#f6f7f9', text: '#454142' }));
        if (barvy[1] && Math.min(Math.abs(barvy[1].h - hlavni.h), 360 - Math.abs(barvy[1].h - hlavni.h)) > 35) {
            palety.push(upravPaletu({ nazev: 'Alternativa', primarni: hslNaHex(barvy[1].h, Math.max(barvy[1].s, 0.5), 0.26), akcent: hslNaHex(hlavni.h, Math.max(hlavni.s, 0.55), 0.5), pozadi: '#f5f6f9', text: '#454142' }));
        }
        return palety;
    } catch (e) { return []; }
}

function dominantniBarvyZeSnimku(obraz) {
    const p = paletyZeSnimku(obraz);
    return p.length ? { primarni: p[0].primarni, akcent: p[0].akcent } : null;
}

function najdiFontZCss(html, css) {
    const text = html + '\n' + css;
    let m = text.match(/fonts\.googleapis\.com\/css2?\?[^"')]*family=([^&:"')]+)/i);
    if (m) {
        const f = decodeURIComponent(m[1]).replace(/\+/g, ' ').trim();
        if (jeFontNazev(f)) return f;
    }
    const pocty = new Map();
    const re = /font-family\s*:\s*([^;}"]+)/gi;
    while ((m = re.exec(text)) !== null) {
        const prvni = m[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
        if (!jeFontNazev(prvni)) continue;
        if (/^(Segoe UI|Times|Georgia|Verdana|Tahoma)$/i.test(prvni)) continue;
        pocty.set(prvni, (pocty.get(prvni) || 0) + 1);
    }
    const top = [...pocty.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
}

function jeHex(v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()); }


ipcMain.handle('cesty', () => ({
    aplikace: SLOZKA_APLIKACE,
    server: SLOZKA_SERVERU,
    konfig: KONFIG_DIR,
    serverExistuje: fs.existsSync(path.join(SLOZKA_SERVERU, 'server.js'))
}));

ipcMain.handle('env-cti', (e, ktera) => ctiEnvFile(envPath(ktera)));

ipcMain.handle('env-zapis', (e, ktera, hodnoty) => zapisEnvFile(envPath(ktera), hodnoty));

ipcMain.handle('klic', (e, delka) => crypto.randomBytes(delka || 24).toString('hex'));

ipcMain.handle('db-test', async (e, cfg) => {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port) || 3306, user: cfg.user, password: cfg.password, connectTimeout: 6000 });
    const [rows] = await conn.query('SHOW DATABASES');
    await conn.end();
    return rows.map(r => Object.values(r)[0]);
});

const SCHEMA_SQL = `
CREATE DATABASE IF NOT EXISTS \`__DB__\` CHARACTER SET utf8mb4 COLLATE utf8mb4_czech_ci;
USE \`__DB__\`;
CREATE TABLE IF NOT EXISTS navstevnici (
  id INT AUTO_INCREMENT PRIMARY KEY,
  jmeno VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  telefon VARCHAR(30) DEFAULT NULL,
  spolecnost VARCHAR(255) DEFAULT NULL,
  podpis_base64 LONGTEXT DEFAULT NULL,
  fss_encrypted LONGTEXT DEFAULT NULL,
  vytvoreno DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_jmeno (jmeno),
  INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_czech_ci;
CREATE TABLE IF NOT EXISTS dochazka (
  id INT AUTO_INCREMENT PRIMARY KEY,
  navstevnik_id INT NOT NULL,
  stav ENUM('Uvnitr','Odesel') NOT NULL DEFAULT 'Uvnitr',
  cas_prichodu DATETIME DEFAULT NULL,
  cas_odchodu DATETIME DEFAULT NULL,
  podpis_vstup_base64 LONGTEXT DEFAULT NULL,
  fss_encrypted LONGTEXT DEFAULT NULL,
  INDEX idx_navstevnik (navstevnik_id),
  INDEX idx_stav (stav),
  CONSTRAINT fk_dochazka_navstevnik FOREIGN KEY (navstevnik_id) REFERENCES navstevnici(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_czech_ci;
CREATE TABLE IF NOT EXISTS pravidla (
  id INT AUTO_INCREMENT PRIMARY KEY,
  obsah LONGTEXT NOT NULL,
  poradi INT NOT NULL DEFAULT 1,
  INDEX idx_poradi (poradi)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_czech_ci;
`;

ipcMain.handle('db-zaloz', async (e, cfg) => {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port) || 3306, user: cfg.user, password: cfg.password, multipleStatements: true, connectTimeout: 8000 });
    const nazev = String(cfg.database || 'evidence_navstev').replace(/[^a-zA-Z0-9_]/g, '');
    await conn.query(SCHEMA_SQL.split('__DB__').join(nazev));
    await conn.end();
    return nazev;
});

const MARIADB_VERZE = '11.4.5';
const MARIADB_URL = `https://archive.mariadb.org/mariadb-${MARIADB_VERZE}/winx64-packages/mariadb-${MARIADB_VERZE}-winx64.zip`;
const DB_DIR = path.join(KONFIG_DIR, 'mariadb');
const DB_DATA_DIR = path.join(KONFIG_DIR, 'mariadb-data');
let dbProces = null;

function dbMysqld() { return path.join(DB_DIR, 'bin', 'mysqld.exe'); }
function dbNainstalovana() { return fs.existsSync(dbMysqld()); }

function stahniSoubor(url, cil, priebeh, presmerovani = 0) {
    return new Promise((resolve, reject) => {
        if (presmerovani > 5) return reject(new Error('Příliš mnoho přesměrování.'));
        const soubor = fs.createWriteStream(cil);
        const req = https.get(url, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                soubor.close();
                return resolve(stahniSoubor(new URL(res.headers.location, url).href, cil, priebeh, presmerovani + 1));
            }
            if (res.statusCode !== 200) { soubor.close(); return reject(new Error('Stažení selhalo (HTTP ' + res.statusCode + ').')); }
            const celkem = Number(res.headers['content-length']) || 0;
            let stazeno = 0;
            res.on('data', d => { stazeno += d.length; if (celkem && priebeh) priebeh(Math.round(stazeno / celkem * 100)); });
            res.pipe(soubor);
            soubor.on('finish', () => soubor.close(resolve));
        });
        req.on('error', err => { soubor.close(); reject(err); });
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('Stažení vypršelo.')); });
    });
}

function spustPrikaz(prikaz, argumenty, moznosti = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(prikaz, argumenty, { windowsHide: true, ...moznosti });
        let vystup = '';
        p.stdout && p.stdout.on('data', d => { vystup += d; });
        p.stderr && p.stderr.on('data', d => { vystup += d; });
        p.on('error', reject);
        p.on('exit', kod => kod === 0 ? resolve(vystup) : reject(new Error('Příkaz skončil s kódem ' + kod + ': ' + vystup.slice(-400))));
    });
}

function volnyPort(start) {
    const net = require('net');
    const zkus = port => new Promise(resolve => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => s.close(() => resolve(true)));
        s.listen(port, '127.0.0.1');
    });
    return (async () => {
        for (let p = start; p < start + 10; p++) if (await zkus(p)) return p;
        return start;
    })();
}

function pockejNaPort(port, maxMs = 20000) {
    const net = require('net');
    const start = Date.now();
    return new Promise(resolve => {
        (function zkus() {
            const s = net.connect({ host: '127.0.0.1', port, timeout: 1200 }, () => { s.destroy(); resolve(true); });
            s.on('error', () => { s.destroy(); Date.now() - start < maxMs ? setTimeout(zkus, 500) : resolve(false); });
            s.on('timeout', () => { s.destroy(); Date.now() - start < maxMs ? setTimeout(zkus, 500) : resolve(false); });
        })();
    });
}

function spustDatabazi() {
    if (dbProces || !dbNainstalovana()) return !!dbProces;
    const es = ctiEnvFile(SERVER_ENV_PATH);
    const port = Number(es.DB_PORT) || 3306;
    dbProces = spawn(dbMysqld(), [
        '--basedir=' + DB_DIR,
        '--datadir=' + DB_DATA_DIR,
        '--port=' + port,
        '--bind-address=127.0.0.1',
        '--console'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    dbProces.stdout.on('data', d => console.log('[db]', String(d).trim()));
    dbProces.stderr.on('data', d => console.log('[db]', String(d).trim()));
    dbProces.on('exit', kod => { console.log('[db] skoncila, kod', kod); dbProces = null; });
    return true;
}

async function zastavDatabazi() {
    if (!dbProces) return;
    const es = ctiEnvFile(SERVER_ENV_PATH);
    const mysqladmin = path.join(DB_DIR, 'bin', 'mysqladmin.exe');
    try {
        await spustPrikaz(mysqladmin, [
            '-u', es.DB_USER || 'root',
            '--password=' + (es.DB_PASSWORD || ''),
            '--host=127.0.0.1',
            '--port=' + (Number(es.DB_PORT) || 3306),
            'shutdown'
        ]);
    } catch (e) {
        try { dbProces.kill(); } catch (er) {}
    }
    dbProces = null;
}

ipcMain.handle('db-instaluj', async (e) => {
    if (process.platform !== 'win32') throw new Error('Automatická instalace databáze je zatím jen pro Windows.');
    const hlas = (text, procenta) => { try { e.sender.send('db-instalace-stav', { text, procenta }); } catch (er) {}; console.log('[db-instalace]', text); };

    const port = await volnyPort(3306);
    const heslo = crypto.randomBytes(12).toString('base64url');

    if (!dbNainstalovana()) {
        const zip = path.join(KONFIG_DIR, 'mariadb.zip');
        hlas('Stahuji MariaDB ' + MARIADB_VERZE + ' (~90 MB)…', 0);
        await stahniSoubor(MARIADB_URL, zip, p => hlas('Stahuji MariaDB… ' + p + ' %', p));

        hlas('Rozbaluji…', null);
        const rozbaleno = path.join(KONFIG_DIR, 'mariadb-rozbaleni');
        fs.rmSync(rozbaleno, { recursive: true, force: true });
        await spustPrikaz('powershell', ['-NoProfile', '-Command',
            `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${rozbaleno}' -Force`]);
        const vnitrek = fs.readdirSync(rozbaleno).find(s => s.startsWith('mariadb'));
        if (!vnitrek) throw new Error('Rozbalený archiv nemá očekávaný obsah.');
        fs.rmSync(DB_DIR, { recursive: true, force: true });
        fs.renameSync(path.join(rozbaleno, vnitrek), DB_DIR);
        fs.rmSync(rozbaleno, { recursive: true, force: true });
        fs.rmSync(zip, { force: true });
    } else {
        hlas('MariaDB už je stažená, přeskakuji stahování.', null);
    }

    if (!fs.existsSync(path.join(DB_DATA_DIR, 'mysql'))) {
        hlas('Připravuji datové soubory a účet…', null);
        fs.mkdirSync(DB_DATA_DIR, { recursive: true });
        await spustPrikaz(path.join(DB_DIR, 'bin', 'mysql_install_db.exe'), [
            '--datadir=' + DB_DATA_DIR,
            '--password=' + heslo
        ]);
        zapisEnvFile(SERVER_ENV_PATH, { DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: 'root', DB_PASSWORD: heslo, DB_NAME: 'evidence_navstev' });
    } else {
        hlas('Datové soubory už existují, použije se dřívější účet.', null);
    }
    zapisEnvFile(APP_ENV_PATH, { SPUSTIT_DB: 1 });

    hlas('Spouštím databázi…', null);
    spustDatabazi();
    if (!(await pockejNaPort(Number(ctiEnvFile(SERVER_ENV_PATH).DB_PORT) || port))) {
        throw new Error('Databáze se nepodařilo nastartovat – zkuste to znovu, případně restartujte počítač.');
    }
    const es = ctiEnvFile(SERVER_ENV_PATH);
    hlas('Databáze běží.', 100);
    return { host: '127.0.0.1', port: Number(es.DB_PORT) || port, user: es.DB_USER || 'root', password: es.DB_PASSWORD || heslo, database: es.DB_NAME || 'evidence_navstev' };
});

ipcMain.handle('db-stav', async () => {
    const es = ctiEnvFile(SERVER_ENV_PATH);
    return { nainstalovana: dbNainstalovana(), bezi: !!dbProces, port: Number(es.DB_PORT) || 3306 };
});

async function dataSpojeni() {
    const es = ctiEnvFile(SERVER_ENV_PATH);
    const mysql = require('mysql2/promise');
    return mysql.createConnection({
        host: es.DB_HOST || '127.0.0.1',
        port: Number(es.DB_PORT) || 3306,
        user: es.DB_USER || 'root',
        password: es.DB_PASSWORD || '',
        database: es.DB_NAME || 'evidence_navstev',
        connectTimeout: 6000
    });
}

async function overTabulku(conn, tabulka) {
    const [rows] = await conn.query('SHOW TABLES');
    const nazvy = rows.map(r => Object.values(r)[0]);
    if (!nazvy.includes(tabulka)) throw new Error('Neznámá tabulka.');
    return nazvy;
}

const DLOUHE_TYPY = /text|blob|json/i;

ipcMain.handle('data-tabulky', async () => {
    const conn = await dataSpojeni();
    try {
        const [rows] = await conn.query('SHOW TABLES');
        const tabulky = [];
        for (const r of rows) {
            const nazev = Object.values(r)[0];
            const [[pocet]] = await conn.query('SELECT COUNT(*) AS n FROM ??', [nazev]);
            tabulky.push({ nazev, pocet: pocet.n });
        }
        return tabulky;
    } finally { await conn.end(); }
});

ipcMain.handle('data-radky', async (e, { tabulka, strana = 0, naStranu = 20, hledat = '' }) => {
    const conn = await dataSpojeni();
    try {
        await overTabulku(conn, tabulka);
        const [popis] = await conn.query('DESCRIBE ??', [tabulka]);
        const sloupce = popis.map(s => ({
            nazev: s.Field,
            typ: s.Type,
            pk: s.Key === 'PRI',
            dlouhy: DLOUHE_TYPY.test(s.Type)
        }));
        const pk = (sloupce.find(s => s.pk) || {}).nazev || null;

        let where = '', params = [tabulka];
        hledat = String(hledat || '').trim();
        if (hledat) {
            const hledatelne = sloupce.filter(s => !s.dlouhy).map(s => s.nazev);
            where = ' WHERE ' + hledatelne.map(() => '?? LIKE ?').join(' OR ');
            for (const sl of hledatelne) params.push(sl, '%' + hledat + '%');
        }
        const [[celkem]] = await conn.query('SELECT COUNT(*) AS n FROM ??' + where, params);
        const [radkyRaw] = await conn.query(
            'SELECT * FROM ??' + where + (pk ? ' ORDER BY ?? DESC' : '') + ' LIMIT ? OFFSET ?',
            pk ? [...params, pk, Number(naStranu), Number(strana) * Number(naStranu)]
               : [...params, Number(naStranu), Number(strana) * Number(naStranu)]
        );
        const radky = radkyRaw.map(r => {
            const out = {};
            for (const s of sloupce) {
                let v = r[s.nazev];
                if (v instanceof Date) v = v.toISOString().slice(0, 19).replace('T', ' ');
                if (s.dlouhy && v) out[s.nazev] = { dlouhy: true, nahled: String(v).slice(0, 40) + '…' };
                else out[s.nazev] = v === null ? null : String(v);
            }
            return out;
        });
        return { sloupce, radky, celkem: celkem.n, pk };
    } finally { await conn.end(); }
});

ipcMain.handle('data-uprav', async (e, { tabulka, pk, pkHodnota, sloupec, hodnota }) => {
    const conn = await dataSpojeni();
    try {
        await overTabulku(conn, tabulka);
        const [popis] = await conn.query('DESCRIBE ??', [tabulka]);
        const cil = popis.find(s => s.Field === sloupec);
        const klic = popis.find(s => s.Field === pk && s.Key === 'PRI');
        if (!cil || !klic) throw new Error('Neplatný sloupec.');
        if (DLOUHE_TYPY.test(cil.Type)) throw new Error('Dlouhá data (podpisy) se tady upravovat nedají.');
        await conn.query('UPDATE ?? SET ?? = ? WHERE ?? = ?', [tabulka, sloupec, hodnota === '' ? null : hodnota, pk, pkHodnota]);
        return true;
    } finally { await conn.end(); }
});

ipcMain.handle('data-smaz', async (e, { tabulka, pk, pkHodnota }) => {
    const conn = await dataSpojeni();
    try {
        await overTabulku(conn, tabulka);
        const [popis] = await conn.query('DESCRIBE ??', [tabulka]);
        if (!popis.find(s => s.Field === pk && s.Key === 'PRI')) throw new Error('Tabulka nemá primární klíč.');
        await conn.query('DELETE FROM ?? WHERE ?? = ?', [tabulka, pk, pkHodnota]);
        return true;
    } finally { await conn.end(); }
});

function logoDataUrl(cesta) {
    try {
        if (!cesta || !fs.existsSync(cesta)) return null;
        const buf = fs.readFileSync(cesta);
        if (buf.length > 4 * 1024 * 1024) return null;
        const ext = path.extname(cesta).toLowerCase();
        const mime = ext === '.svg' ? 'image/svg+xml'
            : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
            : ext === '.webp' ? 'image/webp'
            : ext === '.ico' ? 'image/x-icon'
            : 'image/png';
        return 'data:' + mime + ';base64,' + buf.toString('base64');
    } catch (e) { return null; }
}

ipcMain.handle('logo-data', (e, cesta) => logoDataUrl(cesta));

ipcMain.handle('logo-vyber-soubor', async () => {
    const r = await dialog.showOpenDialog({
        title: 'Vyberte logo firmy',
        filters: [{ name: 'Obrázky', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] }],
        properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const ext = (path.extname(src) || '.png').toLowerCase();
    const cil = path.join(KONFIG_DIR, 'logo-vlastni' + ext);
    fs.copyFileSync(src, cil);
    return { cesta: cil, nazev: path.basename(src), dataUrl: logoDataUrl(cil) };
});

ipcMain.handle('vzhled-z-webu', async (e, cfg) => {
    let url = String(cfg.url || '').trim();
    if (!url) throw new Error('Zadejte adresu webu firmy.');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    const html = await stahniText(url);
    const companyName = najdiNazevFirmy(html);

    let logoCesta = null;
    const logoUrl = najdiLogo(html, url);
    if (logoUrl) {
        try {
            const { buffer, contentType } = await stahniBuffer(logoUrl);
            let ext = (logoUrl.split('?')[0].match(/\.(png|jpg|jpeg|svg|webp|ico)$/i) || [null, ''])[1].toLowerCase();
            if (!ext) ext = /svg/.test(contentType) ? 'svg' : /jpe?g/.test(contentType) ? 'jpg' : 'png';
            logoCesta = path.join(KONFIG_DIR, 'logo-vlastni.' + ext);
            fs.writeFileSync(logoCesta, buffer);
        } catch (er) { }
    }

    let css = '';
    const cssOdkazy = [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map(m => m[1]).slice(0, 2);
    for (const odkaz of cssOdkazy) {
        try { css += await stahniText(new URL(odkaz, url).href, 200000); } catch (er) {}
    }

    const snimek = await screenshotWebu(url);

    let palety = [], font = null, zdrojBarev = 'css';

    const zPixelu = snimek ? paletyZeSnimku(snimek) : [];
    if (zPixelu.length) { palety.push(...zPixelu); zdrojBarev = 'snimek'; }

    if (!palety.length) {
        const bCss = najdiBarvyZCss(html, css);
        palety.push(upravPaletu({ nazev: 'Barvy webu', primarni: bCss.primarni, akcent: bCss.akcent, pozadi: '#f4f6f9', text: '#454142' }));
    }
    palety.push(odvozenePalety(palety[0].primarni)[0]);
    const videne = new Set();
    palety = palety.filter(p => {
        const klic = p.primarni + p.akcent;
        if (videne.has(klic)) return false;
        videne.add(klic);
        return true;
    }).slice(0, 5);
    const barvy = { primarni: palety[0].primarni, akcent: palety[0].akcent, pozadi: palety[0].pozadi, text: palety[0].text };
    if (!font) font = najdiFontZCss(html, css);

    return {
        ...barvy,
        palety,
        font: font || null,
        logo: logoCesta,
        logoNahled: logoDataUrl(logoCesta),
        companyName,
        zdroj: url,
        zdrojBarev,
    };
});

ipcMain.handle('tablet-obrazek-vyber', async () => {
    const r = await dialog.showOpenDialog({
        title: 'Vyberte obrázek na displej tabletu',
        filters: [{ name: 'Obrázky', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const ext = (path.extname(src) || '.png').toLowerCase();
    const cil = path.join(KONFIG_DIR, 'tablet-obrazek' + ext);
    fs.copyFileSync(src, cil);
    return { cesta: cil, nazev: path.basename(src), dataUrl: logoDataUrl(cil) };
});

function cilProVzhled() {
    const vzdaleny = vzdalenyServer();
    if (vzdaleny && vzdaleny.klic) return vzdaleny;
    const ea = ctiEnvFile(APP_ENV_PATH);
    const es = ctiEnvFile(SERVER_ENV_PATH);
    if ((serverProces || ea.SPUSTIT_SERVER === '1' || jeJenServer()) && es.API_KEY) {
        return { host: '127.0.0.1', port: Number(es.PORT || ea.PORT) || 3000, klic: es.API_KEY };
    }
    return null;
}

let posledniVzhledVerze = 0;

function posliVzhledNaServer() {
    const cil = cilProVzhled();
    if (!cil || !cil.klic) return;
    let t;
    try { t = JSON.parse(fs.readFileSync(THEME_PATH, 'utf-8')); } catch (e) { return; }
    const telo = {
        verze: Number(t.verze) || 0,
        primarni: t.primarni, akcent: t.akcent, pozadi: t.pozadi, text: t.text,
        companyName: t.companyName, font: t.font || null,
        tabletText1: t.tabletText1, tabletText2: t.tabletText2
    };
    try {
        if (t.logo && fs.existsSync(t.logo) && fs.statSync(t.logo).size < 3 * 1024 * 1024) {
            telo.logoData = logoDataUrl(t.logo);
        }
    } catch (e) {}
    try {
        if (t.tabletObrazek && fs.existsSync(t.tabletObrazek) && fs.statSync(t.tabletObrazek).size < 3 * 1024 * 1024) {
            telo.tabletObrazekData = logoDataUrl(t.tabletObrazek);
        }
    } catch (e) {}
    const data = JSON.stringify(telo);
    const req = http.request({
        method: 'POST', hostname: cil.host, port: cil.port, path: '/api/kiosek-vzhled',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-api-key': cil.klic },
        timeout: 6000
    }, res => {
        if (res.statusCode >= 400) console.warn('vzhled se serveru nepodarilo predat (HTTP ' + res.statusCode + ')');
        res.resume();
    });
    req.on('timeout', () => { req.destroy(); console.warn('vzhled se serveru nepodarilo predat (timeout)'); });
    req.on('error', (er) => console.warn('vzhled se serveru nepodarilo predat:', er.message));
    req.write(data);
    req.end();
}

function prevezmiVzhled(data) {
    try {
        const t = ctiTheme();
        const hex = v => /^#[0-9a-fA-F]{6}$/.test(String(v || ''));
        for (const k of ['primarni', 'akcent', 'pozadi', 'text']) if (hex(data[k])) t[k] = data[k];
        if (typeof data.companyName === 'string') t.companyName = data.companyName.slice(0, 120);
        if (typeof data.font === 'string' && data.font.length < 40) t.font = data.font;
        if (typeof data.tabletText1 === 'string') t.tabletText1 = data.tabletText1.slice(0, 80);
        if (typeof data.tabletText2 === 'string') t.tabletText2 = data.tabletText2.slice(0, 80);
        const ulozObrazek = (dataUrl, zaklad) => {
            const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|svg\+xml|webp|x-icon|vnd\.microsoft\.icon);base64,([A-Za-z0-9+/=]+)$/);
            if (!m) return null;
            const pripona = m[1] === 'svg+xml' ? '.svg' : m[1] === 'jpeg' ? '.jpg' : (m[1] === 'x-icon' || m[1] === 'vnd.microsoft.icon') ? '.ico' : '.' + m[1];
            const cil = path.join(KONFIG_DIR, zaklad + pripona);
            fs.writeFileSync(cil, Buffer.from(m[2], 'base64'));
            return cil;
        };
        if (typeof data.logoData === 'string' && data.logoData.length < 4 * 1024 * 1024) {
            const cesta = ulozObrazek(data.logoData, 'logo-ze-serveru');
            if (cesta) t.logo = cesta;
        }
        if (typeof data.tabletObrazekData === 'string' && data.tabletObrazekData.length < 4 * 1024 * 1024) {
            const cesta = ulozObrazek(data.tabletObrazekData, 'tablet-ze-serveru');
            if (cesta) t.tabletObrazek = cesta;
        }
        t.verze = Number(data.verze) || Date.now();
        posledniVzhledVerze = t.verze;
        fs.writeFileSync(THEME_PATH, JSON.stringify(t, null, 2), 'utf-8');
        if (hlavniOkno && !hlavniOkno.isDestroyed()) hlavniOkno.reload();
        if (oknoNastaveni && !oknoNastaveni.isDestroyed()) oknoNastaveni.reload();
        console.log('vzhled prevzat' + (t.companyName ? ' (' + t.companyName + ')' : ''));
    } catch (e) { console.warn('vzhled se nepodarilo prevzit:', e.message); }
}

function stahniVzhledZeServeru() {
    const cil = vzdalenyServer();
    if (!cil || !cil.klic) return;
    const req = http.request({
        method: 'GET', hostname: cil.host, port: cil.port, path: '/api/vzhled',
        headers: { 'x-api-key': cil.klic }, timeout: 5000
    }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
            try {
                const v = JSON.parse(data);
                const mistni = Number(ctiTheme().verze) || 0;
                if (Number(v.verze) > mistni) prevezmiVzhled(v);
            } catch (e) {}
        });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.end();
}

fs.watchFile(THEME_PATH, { interval: 2000 }, () => {
    try {
        const verze = Number(ctiTheme().verze) || 0;
        if (!verze || verze === posledniVzhledVerze) return;
        posledniVzhledVerze = verze;
        if (hlavniOkno && !hlavniOkno.isDestroyed()) hlavniOkno.reload();
        if (oknoNastaveni && !oknoNastaveni.isDestroyed()) oknoNastaveni.reload();
    } catch (e) {}
});

ipcMain.handle('vzhled-uloz', (e, vzhled) => {
    vzhled.verze = Date.now();
    posledniVzhledVerze = vzhled.verze;
    fs.writeFileSync(THEME_PATH, JSON.stringify(vzhled, null, 2), 'utf-8');
    posliVzhledNaServer();
    return THEME_PATH;
});

ipcMain.handle('vzhled-cti', () => ctiTheme());

ipcMain.handle('parovani-vytvor', () => {
    const es = ctiEnvFile(SERVER_ENV_PATH);
    if (!es.API_KEY) return null;
    const os = require('os');
    let ip = '127.0.0.1';
    for (const sit of Object.values(os.networkInterfaces())) {
        for (const r of sit || []) {
            if (r.family === 'IPv4' && !r.internal) { ip = r.address; break; }
        }
    }
    return Buffer.from(JSON.stringify({ host: ip, port: Number(es.PORT || 3000), apiKey: es.API_KEY })).toString('base64');
});

ipcMain.handle('parovani-pouzij', (e, kod) => {
    const data = JSON.parse(Buffer.from(String(kod).trim(), 'base64').toString('utf-8'));
    if (!data.host || !data.apiKey) throw new Error('Neplatný párovací kód.');
    zapisEnvFile(APP_ENV_PATH, { API_HOST: data.host, PORT: data.port || 3000, API_KEY: data.apiKey });
    return data.host;
});

ipcMain.handle('server-start', async () => {
    if (ctiEnvFile(APP_ENV_PATH).SPUSTIT_DB === '1' && !dbProces) {
        spustDatabazi();
        await pockejNaPort(Number(ctiEnvFile(SERVER_ENV_PATH).DB_PORT) || 3306, 15000);
    }
    spustServer();
    return pockejNaServer();
});

ipcMain.handle('server-stav', async () => {
    const port = serverPort();
    if (await zkusZdravi(port)) return { ok: true, port };
    return { ok: false, port, chyba: serverPosledniChyba, log: serverLog.slice(-15) };
});

ipcMain.handle('discord-test', async (e, url) => {
    url = String(url || '').trim();
    if (!/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//i.test(url)) {
        throw new Error('Tohle nevypadá jako adresa Discord webhooku.');
    }
    return new Promise((resolve, reject) => {
        const telo = JSON.stringify({ content: 'Kiosek: zkušební zpráva z průvodce nastavením. Hlášení o provozu budou chodit sem.' });
        const u = new URL(url);
        const req = https.request({
            method: 'POST',
            hostname: u.hostname,
            path: u.pathname + u.search,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(telo) },
            timeout: 8000
        }, res => {
            res.resume();
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
            else reject(new Error('Discord vrátil HTTP ' + res.statusCode + ' – zkontrolujte adresu webhooku.'));
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Discord neodpovídá (timeout).')); });
        req.on('error', reject);
        req.write(telo);
        req.end();
    });
});
ipcMain.handle('autostart', (e, zapnout) => {
    app.setLoginItemSettings({ openAtLogin: !!zapnout });
    return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('autostart-stav', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('dokoncit-pruvodce', (e, spustitKiosek) => {
    zapisEnvFile(APP_ENV_PATH, { NAKONFIGUROVANO: 1 });
    const eaDok = ctiEnvFile(APP_ENV_PATH);
    if (eaDok.SPUSTIT_DB === '1') spustDatabazi();
    if (eaDok.SPUSTIT_SERVER === '1') spustServer();
    if (!tray) { try { vytvorTray(); } catch (er) {} }
    obnovTrayMenu();
    setTimeout(posliVzhledNaServer, 3000);
    if (spustitKiosek) {
        if (!hlavniOkno) vytvorKiosek();
        BrowserWindow.getAllWindows().forEach(w => { if (w !== hlavniOkno) w.close(); });
    }
    return true;
});
ipcMain.handle('otevri-spravu', () => { otevriSpravu(); return true; });

ipcMain.handle('otevri-nastaveni', () => { vytvorNastaveni(); return true; });
ipcMain.handle('otevri-pruvodce', () => { vytvorPruvodce(); return true; });
function restartujAplikaci() {
    if (process.platform === 'linux') {
        const cesta = process.env.APPIMAGE || process.execPath;
        const argumenty = process.argv.slice(1);
        try {
            spawn('/bin/sh', ['-c', 'sleep 2; exec "$0" "$@"', cesta, ...argumenty],
                { detached: true, stdio: 'ignore' }).unref();
        } catch (e) { app.relaunch(); }
        app.exit(0);
        return;
    }
    if (process.env.APPIMAGE) app.relaunch({ execPath: process.env.APPIMAGE, args: process.argv.slice(1) });
    else app.relaunch();
    app.exit(0);
}
ipcMain.handle('restart-aplikace', () => { restartujAplikaci(); });
ipcMain.handle('otevri-odkaz', (e, url) => {
    url = String(url || '');
    if (/^https:\/\//i.test(url)) require('electron').shell.openExternal(url);
    return true;
});

const SSH_DIR = path.join(KONFIG_DIR, 'ssh');
const SSH_KLIC = path.join(SSH_DIR, 'guestbook_key');
const SSH_KLIC_VEREJNY = SSH_KLIC + '.pub';

function rozdelSshCil(cil) {
    const s = String(cil || '').trim();
    if (!s) return null;
    const m = s.match(/^([^@\s]+)@([^:\s]+)(?::(\d+))?$/);
    if (!m) return null;
    return { ucet: m[1] + '@' + m[2], uzivatel: m[1], host: m[2], port: m[3] || '' };
}

function sshDostupny() {
    try {
        require('child_process').execSync(process.platform === 'win32' ? 'where ssh' : 'which ssh', { stdio: 'ignore' });
        return true;
    } catch (e) { return false; }
}

function otevriCmdOkno(nazev, radky) {
    const skript = path.join(KONFIG_DIR, nazev);
    fs.writeFileSync(skript, '@echo off\r\n' + radky.join('\r\n') + '\r\n', 'utf-8');
    spawn('cmd', ['/c', 'start', '', skript], { detached: true });
}

function otevriTerminal() {
    const ea = ctiEnvFile(APP_ENV_PATH);
    const cil = rozdelSshCil(ea.SSH_CIL);
    const slozka = KONFIG_DIR;
    let sshCmd = null;
    if (cil) {
        const casti = ['ssh'];
        if (fs.existsSync(SSH_KLIC)) casti.push('-i', '"' + SSH_KLIC + '"');
        if (cil.port) casti.push('-p', cil.port);
        casti.push(cil.ucet);
        sshCmd = casti.join(' ');
    }
    try {
        if (process.platform === 'win32') {
            if (sshCmd) otevriCmdOkno('guestbook-terminal.cmd', [
                'echo Pripojuji se na ' + cil.ucet + '...',
                sshCmd,
                'cmd /k'
            ]);
            else otevriCmdOkno('guestbook-terminal.cmd', ['cd /d "' + slozka + '"', 'cmd /k']);
        } else if (process.platform === 'darwin') {
            const prikaz = sshCmd || 'cd "' + slozka + '"';
            spawn('osascript', ['-e', `tell application "Terminal" to do script "${prikaz}"`,
                '-e', 'tell application "Terminal" to activate'], { detached: true });
        } else {
            const emulator = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].find(t => {
                try { require('child_process').execSync('which ' + t, { stdio: 'ignore' }); return true; } catch (e) { return false; }
            });
            if (!emulator) return;
            if (sshCmd) spawn(emulator, ['-e', 'bash', '-c', sshCmd + '; exec bash'], { detached: true });
            else spawn(emulator, [], { cwd: slozka, detached: true });
        }
    } catch (e) { console.warn('terminal se nepodarilo otevrit:', e.message); }
}
ipcMain.handle('otevri-terminal', () => { otevriTerminal(); return true; });

ipcMain.handle('ssh-stav', () => {
    const ea = ctiEnvFile(APP_ENV_PATH);
    return {
        klient: sshDostupny(),
        klic: fs.existsSync(SSH_KLIC),
        cil: ea.SSH_CIL || '',
        klicNaServeru: ea.SSH_KLIC_NAHRAN === '1'
    };
});

ipcMain.handle('ssh-instaluj', async () => {
    if (sshDostupny()) return { klient: true };
    if (process.platform !== 'win32') throw new Error('Na tomhle systému bývá ssh součástí instalace – doinstalujte balíček openssh-client.');
    const psSkript = "$p = Start-Process powershell -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command','Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0' -Verb RunAs -Wait -PassThru; exit $p.ExitCode";
    await new Promise((resolve, reject) => {
        const p = spawn('powershell', ['-NoProfile', '-Command', psSkript], { windowsHide: true });
        let out = '';
        const limit = setTimeout(() => {
            try { p.kill(); } catch (er) {}
            reject(new Error('Instalace trvá déle než 4 minuty – služba Windows Update je nejspíš zaneprázdněná. Nechte počítač chvíli běžet a zkuste to znovu.'));
        }, 4 * 60 * 1000);
        p.stdout.on('data', d => out += d);
        p.stderr.on('data', d => out += d);
        p.on('exit', kod => {
            clearTimeout(limit);
            if (kod === 0) return resolve();
            if (kod === 1223 || /canceled by the user|operaci zrušil/i.test(out)) {
                return reject(new Error('Povolení správce bylo odmítnuto. Klikněte na 1. znovu a v okně Windows potvrďte „Ano" – bez toho systém OpenSSH nezapne.'));
            }
            reject(new Error('Instalace se nepovedla (kód ' + kod + '). ' + out.slice(-160)));
        });
        p.on('error', e => { clearTimeout(limit); reject(e); });
    });
    if (!sshDostupny()) throw new Error('SSH se nainstaloval, ale systém ho ještě nevidí – restartujte počítač.');
    return { klient: true };
});

ipcMain.handle('ssh-klic-vytvor', async () => {
    if (!sshDostupny()) throw new Error('Nejdřív nainstalujte SSH klienta.');
    fs.mkdirSync(SSH_DIR, { recursive: true });
    if (fs.existsSync(SSH_KLIC)) return { klic: true, verejny: fs.readFileSync(SSH_KLIC_VEREJNY, 'utf-8').trim() };
    await spustPrikaz('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'guestbook', '-f', SSH_KLIC]);
    return { klic: true, verejny: fs.readFileSync(SSH_KLIC_VEREJNY, 'utf-8').trim() };
});

ipcMain.handle('ssh-klic-nahraj', async (e, cilText) => {
    const cil = rozdelSshCil(cilText);
    if (!cil) throw new Error('Adresa musí být ve tvaru uzivatel@server, např. pi@192.168.0.50.');
    if (!fs.existsSync(SSH_KLIC_VEREJNY)) throw new Error('Nejdřív vytvořte přihlašovací klíč.');
    zapisEnvFile(APP_ENV_PATH, { SSH_CIL: cilText.trim() });

    const portArg = cil.port ? ' -p ' + cil.port : '';
    const unixPrikaz = 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys';
    const psSkript = [
        "$k=[Console]::In.ReadToEnd().Trim()",
        "$d=Join-Path $env:USERPROFILE '.ssh'",
        "New-Item -Force -ItemType Directory $d | Out-Null",
        "Add-Content -Path (Join-Path $d 'authorized_keys') -Value $k",
        "try {",
        "  $ad='C:\\ProgramData\\ssh'",
        "  if (Test-Path $ad) {",
        "    $f=Join-Path $ad 'administrators_authorized_keys'",
        "    Add-Content -Path $f -Value $k",
        "    icacls $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null",
        "  }",
        "} catch {}",
        "Write-Output 'GUESTBOOK-KLIC-OK'"
    ].join('\n');
    const winPrikaz = 'powershell -NoProfile -EncodedCommand ' + Buffer.from(psSkript, 'utf16le').toString('base64');

    if (process.platform === 'win32') {
        otevriCmdOkno('guestbook-nahraj-klic.cmd', [
            'echo Nahravam pristupovy klic na server ' + cil.ucet + '.',
            'echo Az se server zepta, zadejte heslo uctu na serveru (pri psani se nezobrazuje).',
            'echo.',
            'type "' + SSH_KLIC_VEREJNY + '" | ssh -o StrictHostKeyChecking=accept-new' + portArg + ' ' + cil.ucet + ' "' + unixPrikaz + '"',
            'if not errorlevel 1 goto ok',
            'echo.',
            'echo Server nerozumi linuxovym prikazum - vypada to na Windows server.',
            'echo Zadejte heslo jeste jednou, klic se zapise jejich zpusobem.',
            'echo.',
            'type "' + SSH_KLIC_VEREJNY + '" | ssh -o StrictHostKeyChecking=accept-new' + portArg + ' ' + cil.ucet + ' ' + winPrikaz,
            'if not errorlevel 1 goto ok',
            'echo.',
            'echo Nahrani se NEPOVEDLO - zkontrolujte adresu serveru a heslo a zkuste to znovu.',
            'goto konec',
            ':ok',
            'echo.',
            'echo Klic nahran, okno muzete zavrit a pokracovat krokem 4.',
            ':konec',
            'pause'
        ]);
        return true;
    }

    const portSsh = cil.port ? ' -p ' + cil.port : '';
    const radky = [
        '#!/bin/sh',
        'PUB="' + SSH_KLIC_VEREJNY + '"',
        'CIL="' + cil.ucet + '"',
        'CTL="/tmp/guestbook-ssh-ctl.$$"',
        'echo "Nahravam pristupovy klic na server $CIL."',
        'echo "Zadejte heslo uctu na serveru (pri psani se nezobrazuje)."',
        'echo',
        'ssh -o ControlMaster=yes -o ControlPath="$CTL" -o ControlPersist=120 -o StrictHostKeyChecking=accept-new' + portSsh + ' -fN "$CIL"',
        'if [ $? -ne 0 ]; then',
        '  echo; echo "Pripojeni se nepovedlo - zkontrolujte adresu a heslo a zkuste to znovu."',
        '  echo "Okno zavrete klavesou Enter."; read x; exit 1',
        'fi',
        'OS=$(ssh -o ControlPath="$CTL"' + portSsh + ' "$CIL" ver 2>/dev/null)',
        'case "$OS" in',
        '  *Windows*|*windows*) TYP=windows ;;',
        '  *) TYP=unix ;;',
        'esac',
        'if [ "$TYP" = "windows" ]; then',
        '  echo "Server bezi na Windows - klic zapisuji jejich zpusobem."',
        '  cat "$PUB" | ssh -o ControlPath="$CTL"' + portSsh + ' "$CIL" "' + winPrikaz + '"',
        '  V=$?',
        'else',
        '  cat "$PUB" | ssh -o ControlPath="$CTL"' + portSsh + ' "$CIL" \'' + unixPrikaz + '\'',
        '  V=$?',
        '  if [ $V -ne 0 ]; then',
        '    echo "Server nerozumi linuxovym prikazum - zkousim zapis pro Windows server."',
        '    cat "$PUB" | ssh -o ControlPath="$CTL"' + portSsh + ' "$CIL" "' + winPrikaz + '"',
        '    V=$?',
        '  fi',
        'fi',
        'ssh -O exit -o ControlPath="$CTL"' + portSsh + ' "$CIL" 2>/dev/null',
        'echo',
        'if [ $V -eq 0 ]; then',
        '  echo "Klic nahran, okno muzete zavrit a pokracovat krokem 4."',
        'else',
        '  echo "Nahrani se NEPOVEDLO - zkontrolujte adresu serveru a heslo a zkuste to znovu."',
        'fi',
        'echo "Okno zavrete klavesou Enter."',
        'read x'
    ];
    const skript = path.join(KONFIG_DIR, 'guestbook-nahraj-klic.sh');
    fs.writeFileSync(skript, radky.join('\n') + '\n', { encoding: 'utf-8', mode: 0o755 });

    if (process.platform === 'darwin') {
        spawn('osascript', ['-e', `tell application "Terminal" to do script "bash '${skript}'"`,
            '-e', 'tell application "Terminal" to activate'], { detached: true });
    } else {
        const emulator = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm', 'lxterminal'].find(t => {
            try { require('child_process').execSync('which ' + t, { stdio: 'ignore' }); return true; } catch (er) { return false; }
        });
        if (!emulator) throw new Error('Nenašel jsem žádný terminál (gnome-terminal, xterm…). Doinstalujte ho a zkuste to znovu.');
        spawn(emulator, ['-e', 'bash', '-c', "bash '" + skript + "'"], { detached: true });
    }
    return true;
});

ipcMain.handle('ssh-test', async (e, cilText) => {
    const cil = rozdelSshCil(cilText);
    if (!cil) throw new Error('Adresa musí být ve tvaru uzivatel@server, např. pi@192.168.0.50.');
    if (!sshDostupny()) throw new Error('Nejdřív nainstalujte SSH klienta.');

    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8'];
    if (fs.existsSync(SSH_KLIC)) args.push('-i', SSH_KLIC);
    if (cil.port) args.push('-p', cil.port);
    args.push(cil.ucet, 'echo guestbook-ok');

    const vysledek = await new Promise(resolve => {
        const p = spawn('ssh', args, { windowsHide: true });
        let out = '';
        p.stdout.on('data', d => out += d);
        p.stderr.on('data', d => out += d);
        p.on('error', () => resolve({ ok: false, vystup: 'ssh se nepodařilo spustit' }));
        p.on('exit', kod => resolve({ ok: kod === 0 && /guestbook-ok/.test(out), vystup: out }));
        setTimeout(() => { try { p.kill(); } catch (er) {} }, 15000);
    });

    if (vysledek.ok) {
        zapisEnvFile(APP_ENV_PATH, { SSH_CIL: cilText.trim(), SSH_KLIC_NAHRAN: 1 });
        return { ok: true, zprava: 'Připojení funguje – terminál se na server přihlásí sám, bez hesla.' };
    }
    const v = vysledek.vystup;
    let rada;
    if (/Permission denied|publickey/i.test(v)) rada = 'Server odmítl klíč – klikněte na „Nahrát klíč na server" a v okně zadejte heslo serverového účtu.';
    else if (/could not resolve|name or service not known|nodename/i.test(v)) rada = 'Adresu serveru se nepodařilo najít – zkontrolujte ji (např. pi@192.168.0.50).';
    else if (/connection refused/i.test(v)) rada = 'Server na téhle adrese SSH nepřijímá – ověřte, že na něm SSH běží a sedí port.';
    else if (/timed out|timeout/i.test(v)) rada = 'Server neodpovídá – zkontrolujte, že je zapnutý a ve stejné síti.';
    else rada = 'Připojení se nepovedlo: ' + v.trim().split('\n').pop();
    return { ok: false, zprava: rada };
});

ipcMain.handle('ssh-uloz', (e, cil) => {
    zapisEnvFile(APP_ENV_PATH, { SSH_CIL: String(cil || '').trim() });
    return true;
});

ipcMain.handle('ssh-zrus', () => {
    zapisEnvFile(APP_ENV_PATH, { SSH_CIL: '', SSH_KLIC_NAHRAN: 0 });
    return true;
});

function mistniIpAdresa() {
    const os = require('os');
    for (const sit of Object.values(os.networkInterfaces())) {
        for (const r of sit || []) {
            if (r.family === 'IPv4' && !r.internal) return r.address;
        }
    }
    return '127.0.0.1';
}

ipcMain.handle('ssh-server-stav', async () => {
    const os = require('os');
    const vysledek = {
        podporovano: process.platform === 'win32',
        nainstalovan: false,
        bezi: false,
        adresa: os.userInfo().username + '@' + mistniIpAdresa()
    };
    if (process.platform !== 'win32') {
        try {
            const out = require('child_process').execSync('systemctl is-active ssh sshd 2>/dev/null || true', { encoding: 'utf-8' });
            vysledek.podporovano = true;
            vysledek.bezi = /\bactive\b/.test(out);
            vysledek.nainstalovan = vysledek.bezi || /inactive|failed/.test(out);
        } catch (e) {}
        return vysledek;
    }
    try {
        const out = require('child_process').execSync('sc query sshd', { encoding: 'utf-8', windowsHide: true });
        vysledek.nainstalovan = true;
        vysledek.bezi = /RUNNING/.test(out);
    } catch (e) {}
    return vysledek;
});

ipcMain.handle('ssh-server-zapni', async () => {
    if (process.platform !== 'win32') {
        throw new Error('Na tomhle systému zapněte SSH server ručně: sudo apt install openssh-server');
    }
    const skript = [
        "$c = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'",
        "if ($c.State -ne 'Installed') { Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null }",
        "Set-Service -Name sshd -StartupType Automatic",
        "Start-Service sshd",
        "if (-not (Get-NetFirewallRule -Name 'GuestBook-SSH' -ErrorAction SilentlyContinue)) {",
        "  New-NetFirewallRule -Name 'GuestBook-SSH' -DisplayName 'GuestBook SSH server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null",
        "}"
    ].join('; ');
    await new Promise((resolve, reject) => {
        const p = spawn('powershell', ['-NoProfile', '-Command', skript], { windowsHide: true });
        let out = '';
        p.stdout.on('data', d => out += d);
        p.stderr.on('data', d => out += d);
        p.on('exit', kod => kod === 0 ? resolve()
            : reject(new Error('Zapnutí se nepovedlo. Spusťte GuestBook jako správce a zkuste to znovu. ' + out.trim().slice(-200))));
        p.on('error', reject);
    });
    return true;
});

ipcMain.handle('existuje-heslo-spravy', async () => {
    if (ctiEnvFile(SERVER_ENV_PATH).ADMIN_HESLO) return true;
    const cil = vzdalenyServer();
    if (!cil || !cil.klic) return false;
    try { return !!(await dotazNaApi(cil, '/api/heslo-existuje', 'GET')).existuje; }
    catch (e) { return true; } 
});
ipcMain.handle('over-heslo-spravy', async (e, heslo) => {
    const ulozene = ctiEnvFile(SERVER_ENV_PATH).ADMIN_HESLO || '';
    if (ulozene) {
        const a = Buffer.from(String(heslo || ''));
        const b = Buffer.from(ulozene);
        return a.length === b.length && require('crypto').timingSafeEqual(a, b);
    }
    const cil = vzdalenyServer();
    if (!cil || !cil.klic) return true; 
    try { return !!(await dotazNaApi(cil, '/api/over-heslo', 'POST', { heslo: String(heslo || '') })).ok; }
    catch (er) { throw new Error('Server je teď nedostupný, heslo nejde ověřit. Zkuste to za chvíli.'); }
});

function provedPovel(povel) {
    if (!povel || Date.now() - (povel.cas || 0) > 60000) return;
    console.log('povel ze spravy:', povel.akce);
    if (povel.akce === 'restart') restartujAplikaci();
    else if (povel.akce === 'nastaveni') vytvorNastaveni();
    else if (povel.akce === 'terminal') otevriTerminal();
    else if (povel.akce === 'vzhled') prevezmiVzhled(povel.data || {});
}

const POVEL_SOUBOR = path.join(KONFIG_DIR, 'guestbook-povel.json');
setInterval(() => {
    try {
        if (!fs.existsSync(POVEL_SOUBOR)) return;
        const povel = JSON.parse(fs.readFileSync(POVEL_SOUBOR, 'utf-8'));
        fs.unlinkSync(POVEL_SOUBOR);
        if (jeJenServer()) return;
        provedPovel(povel);
    } catch (e) {}
}, 2500);

setInterval(() => {
    stahniVzhledZeServeru();
    const cil = vzdalenyServer();
    if (!cil || !cil.klic) return;
    const req = http.request({
        method: 'GET', hostname: cil.host, port: cil.port, path: '/api/kiosek-povel',
        headers: { 'x-api-key': cil.klic }, timeout: 4000
    }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { try { provedPovel(JSON.parse(data).povel); } catch (e) {} });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.end();
}, 5000);

ipcMain.handle('server-restart', async () => {
    if (serverProces) {
        zastavServer();
        await new Promise(r => setTimeout(r, 800));
    }
    spustServer();
    return pockejNaServer();
});

ipcMain.handle('obnov-kiosek', () => {
    if (hlavniOkno && !hlavniOkno.isDestroyed()) { hlavniOkno.reload(); return true; }
    return false;
});

app.whenReady().then(() => {
    if (!zamekInstance) return;
    migrujStareEnv();
    srovnejApiKlice();

    session.defaultSession.setDevicePermissionHandler((details) => {
        if (details.deviceType === 'hid' && details.device.vendorId === 0x056A) return true;
        return false;
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === 'hid');
    session.defaultSession.on('select-hid-device', (event, details, callback) => {
        event.preventDefault();
        const pad = details.deviceList.find(d => d.vendorId === 0x056A);
        callback(pad ? pad.deviceId : null);
    });

    vytvorTray();

    const arg = process.argv.find(a => ['--pruvodce', '--sprava', '--server', '--nastaveni'].includes(a));
    if (arg === '--pruvodce') { vytvorPruvodce(); return; }
    if (arg === '--sprava') { otevriSpravu(); return; }
    if (arg === '--server') { spustServer(); return; }
    if (arg === '--nastaveni') { vytvorNastaveni(); return; }

    if (!jeNakonfigurovano()) { vytvorPruvodce(); return; }

    const eaStart = ctiEnvFile(APP_ENV_PATH);
    if (eaStart.SPUSTIT_DB === '1') spustDatabazi();
    if (eaStart.SPUSTIT_SERVER === '1') spustServer();
    if (!jeJenServer()) vytvorKiosek();
    setTimeout(posliVzhledNaServer, 8000);
});

function ohlasVypnuti() {
    return new Promise((resolve) => {
        try {
            const ea = ctiEnvFile(APP_ENV_PATH);
            const es = ctiEnvFile(SERVER_ENV_PATH);
            const host = (!ea.API_HOST || ea.SPUSTIT_SERVER === '1') ? '127.0.0.1' : ea.API_HOST;
            const port = Number(es.PORT || ea.PORT) || 3000;
            const klic = String(ea.API_KEY || es.API_KEY || '');
            if (!klic) return resolve();
            const telo = JSON.stringify({ vypnuto: true });
            const req = http.request({
                method: 'POST', hostname: host, port, path: '/api/stav-kiosku',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(telo), 'x-api-key': klic },
                timeout: 800
            }, res => { res.resume(); res.on('end', resolve); });
            req.on('timeout', () => { req.destroy(); resolve(); });
            req.on('error', () => resolve());
            req.write(telo);
            req.end();
        } catch (e) { resolve(); }
    });
}

let ukoncovani = false;
app.on('before-quit', (udalost) => {
    if (ukoncovani) return;
    ukoncovani = true;
    udalost.preventDefault();
    ohlasVypnuti().then(() => {
        zastavServer();
        return dbProces ? zastavDatabazi() : null;
    }).catch(() => {}).finally(() => app.exit(0));
});
app.on('window-all-closed', () => { if (!tray) app.quit(); });