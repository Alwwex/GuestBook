const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ENV_PATH = process.env.SERVER_ENV_PATH || path.join(__dirname, '.env');

function loadEnv() {
    const envPath = ENV_PATH;
    const out = {};
    if (!fs.existsSync(envPath)) return out;
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i === -1) continue;
        let v = t.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        out[t.slice(0, i).trim()] = v;
    }
    return out;
}
const ENV = loadEnv();

const CONFIG = {
    PORT: Number(ENV.PORT) || 3000,
    HOST: process.env.SERVER_HOST_OVERRIDE || ENV.HOST || '127.0.0.1',
    ADMIN_PATH: (ENV.ADMIN_PATH || '/sprava').replace(/\/+$/, ''),
    ADMIN_HESLO: ENV.ADMIN_HESLO || '',
    DISCORD_WEBHOOK: ENV.DISCORD_WEBHOOK_URL || '',
    API_KEY: ENV.API_KEY || '',
    FSS_KEY: ENV.FSS_ENCRYPTION_KEY || '',
    DB: {
        host: ENV.DB_HOST || '127.0.0.1',
        port: Number(ENV.DB_PORT) || 3306,
        user: ENV.DB_USER || 'root',
        password: ENV.DB_PASSWORD || '',
        database: ENV.DB_NAME || 'evidence_navstev',
        waitForConnections: true,
        connectionLimit: 10,
        charset: 'utf8mb4'
    },
    SIGNATURES_DIR: path.join(__dirname, 'signatures'),
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_MAX: 120,
    RATE_LIMIT_MAX_STRICT: 10,
};

if (!CONFIG.API_KEY || CONFIG.API_KEY.length < 16) {
    console.error('Chybí nebo je příliš krátký API_KEY v .env (min. 16 znaků).');
    console.error('   Zkopírujte .env.example jako .env vedle server.js a vyplňte hodnoty.');
    process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(CONFIG.FSS_KEY)) {
    console.error('Chybí platný FSS_ENCRYPTION_KEY v .env (64 hex znaků = 32 bajtů).');
    console.error('   Vygenerujte: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
}
let FSS_KEY_BUF = Buffer.from(CONFIG.FSS_KEY, 'hex');

let hesloPraveVygenerovano = false;
if (!CONFIG.ADMIN_HESLO) {
    CONFIG.ADMIN_HESLO = crypto.randomBytes(9).toString('base64url');
    hesloPraveVygenerovano = true;
    try {
        fs.appendFileSync(ENV_PATH, `\nADMIN_HESLO=${CONFIG.ADMIN_HESLO}\n`);
        console.log('vygenerovano nove heslo do spravy a ulozeno do .env');
    } catch (e) {
        console.warn('heslo do spravy se nepodarilo zapsat do .env, plati jen do restartu');
    }
}

const app = express();

if (!fs.existsSync(CONFIG.SIGNATURES_DIR)) {
    fs.mkdirSync(CONFIG.SIGNATURES_DIR, { recursive: true });
}

function encryptFss(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', FSS_KEY_BUF, iv);
    const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf-8')), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function decryptFss(payloadB64) {
    const buf = Buffer.from(payloadB64, 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', FSS_KEY_BUF, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf-8');
}

const pool = mysql.createPool(CONFIG.DB);
async function dbQuery(sql, params = []) {
    const conn = await pool.getConnection();
    try { const [rows] = await conn.execute(sql, params); return rows; }
    finally { conn.release(); }
}

async function dbQueryId(sql, params = []) {
    const conn = await pool.getConnection();
    try { const [rows] = await conn.query(sql, params); return rows; }
    finally { conn.release(); }
}

const rateLimitMap = new Map();
function rateLimit(maxRequests, windowMs = 60000) {
    return (req, res, next) => {
        const key = req.ip + ':' + req.path;
        const now = Date.now();
        const windowStart = now - windowMs;
        if (!rateLimitMap.has(key)) rateLimitMap.set(key, []);
        const timestamps = rateLimitMap.get(key).filter(t => t > windowStart);
        if (timestamps.length >= maxRequests) {
            return res.status(429).json({ error: 'Příliš mnoho požadavků. Zkuste to znovu za chvíli.' });
        }
        timestamps.push(now);
        rateLimitMap.set(key, timestamps);
        if (timestamps.length === 1) setTimeout(() => rateLimitMap.delete(key), windowMs * 5);
        next();
    };
}

function jePrivatniIP(addr) {
    const ip = String(addr).replace(/^::ffff:/, '');
    if (ip === '127.0.0.1' || ip === '::1') return true;
    if (/^10\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    if (/^169\.254\./.test(ip)) return true;
    return false;
}
const LAN_ONLY = ENV.LAN_ONLY === '1' || ENV.LAN_ONLY === 'true';
app.set('trust proxy', true);
app.use((req, res, next) => {
    const remoteAddr = req.socket.remoteAddress || '';
    if (CONFIG.HOST === '127.0.0.1') {
        const isLocalhost = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddr);
        if (!isLocalhost) {
            console.warn(`odmitnut pristup z ${remoteAddr} na ${req.path}`);
            return res.status(403).json({ error: 'Přístup odmítnut.' });
        }
    } else if (LAN_ONLY && !jePrivatniIP(remoteAddr)) {
        console.warn(`odmitnut pristup z verejne IP ${remoteAddr} na ${req.path}`);
        return res.status(403).json({ error: 'Přístup odmítnut.' });
    }
    next();
});

app.use(cors({
    origin: CONFIG.HOST === '127.0.0.1'
        ? ['http://localhost:' + CONFIG.PORT, 'http://127.0.0.1:' + CONFIG.PORT, 'null']
        : true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Admin-Token'],
    credentials: false
}));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
});

app.use(express.json({ limit: '40mb' }));
app.use('/api/', rateLimit(CONFIG.RATE_LIMIT_MAX));

const adminTokeny = new Map();
function overAdminToken(t) {
    if (!t) return false;
    const z = adminTokeny.get(t);
    if (!z) return false;
    if (Date.now() - z > 30 * 60 * 1000) { adminTokeny.delete(t); return false; }
    adminTokeny.set(t, Date.now());
    return true;
}

const PRIJIMANE_KLICE = [CONFIG.API_KEY];
try {
    const legacyEnv = path.join(__dirname, '.env');
    if (fs.existsSync(legacyEnv) && path.resolve(legacyEnv) !== path.resolve(ENV_PATH)) {
        for (const line of fs.readFileSync(legacyEnv, 'utf-8').split(/\r?\n/)) {
            const m = line.match(/^\s*API_KEY\s*=\s*(.+)\s*$/);
            if (!m) continue;
            const k = m[1].trim().replace(/^["']|["']$/g, '');
            if (k && k.length >= 16 && k !== CONFIG.API_KEY) {
                PRIJIMANE_KLICE.push(k);
                console.log('prijimam i starsi API klic z API_Server/.env (zacina ' + k.slice(0, 6) + '…)');
            }
            break;
        }
    }
} catch (e) {}

function overApiKlic(poslany) {
    const a = Buffer.from(String(poslany || ''));
    for (const klic of PRIJIMANE_KLICE) {
        const b = Buffer.from(klic);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
    return false;
}

app.use('/api/', (req, res, next) => {
    if (overApiKlic(req.headers['x-api-key']) || overAdminToken(req.headers['x-admin-token'])) return next();
    const poslany = String(req.headers['x-api-key'] || '');
    console.warn(`neplatna autorizace od ${req.ip} na ${req.path}`
        + (poslany ? ` (poslany klic zacina ${poslany.slice(0, 6)}…, ocekavam ${CONFIG.API_KEY.slice(0, 6)}…)` : ' (klic chybi)'));
    return res.status(401).json({ error: 'Neautorizovaný přístup.' });
});

app.use('/api/', (req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ← ${req.ip}`);
    next();
});

function sanitizeString(str, maxLen = 255) {
    if (str === null || str === undefined) return null;
    return String(str).trim().substring(0, maxLen);
}
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function ulozWacomSouborNaDisk(base64Data, navstevnikId, typ) {
    try {
        const matches = base64Data.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) throw new Error('Neplatný base64 formát');
        const buffer = Buffer.from(matches[2], 'base64');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 8);
        const filename = `podpis_${typ}_nav${navstevnikId || 'neznamy'}_${timestamp}_${hash}.png`;
        fs.writeFileSync(path.join(CONFIG.SIGNATURES_DIR, filename), buffer);
        console.log(`Podpis (PNG) uložen: ${filename}`);
        return filename;
    } catch (e) {
        console.error('Chyba ukládání PNG podpisu:', e.message);
        return null;
    }
}

function ulozFss(fssText, navstevnikId, typ) {
    if (!fssText || typeof fssText !== 'string' || fssText.length < 32) return { encB64: null, filename: null };
    if (fssText.length > 4 * 1024 * 1024) { console.warn('FSS příliš velký, ignoruji.'); return { encB64: null, filename: null }; }
    try {
        const encB64 = encryptFss(fssText);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const hash = crypto.createHash('sha256').update(fssText).digest('hex').substring(0, 8);
        const filename = `fss_${typ}_nav${navstevnikId || 'neznamy'}_${timestamp}_${hash}.fss.enc`;
        fs.writeFileSync(path.join(CONFIG.SIGNATURES_DIR, filename), encB64, 'utf-8');
        console.log(`FSS (šifrovaný) uložen: ${filename}`);
        return { encB64, filename };
    } catch (e) {
        console.error('Chyba ukládání FSS:', e.message);
        return { encB64: null, filename: null };
    }
}

app.get('/api/hledej/:jmeno', rateLimit(30), async (req, res) => {
    try {
        const jmeno = sanitizeString(req.params.jmeno, 100);
        if (!jmeno || jmeno.length < 2) return res.json([]);
        const rows = await dbQuery(
            `SELECT n.id, n.jmeno, n.email, n.spolecnost, n.telefon,
                    (SELECT d2.stav FROM dochazka d2 WHERE d2.navstevnik_id = n.id ORDER BY d2.cas_prichodu DESC LIMIT 1) AS posledni_stavy
             FROM navstevnici n WHERE n.jmeno LIKE ? LIMIT 10`,
            [`%${jmeno}%`]
        );
        res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/zkontroluj-duplicitu', rateLimit(30), async (req, res) => {
    try {
        const email = sanitizeString(req.body.email) || '';
        const cistyTelefon = req.body.telefon ? String(req.body.telefon).replace(/\s+/g, '') : '';
        if (!email && !cistyTelefon) return res.json({ duplicitni: false });

        const rows = await dbQuery(
            `SELECT id, email, REPLACE(IFNULL(telefon,''), ' ', '') AS tel FROM navstevnici
             WHERE (? <> '' AND LOWER(email) = LOWER(?)) OR (? <> '' AND REPLACE(IFNULL(telefon,''), ' ', '') = ?)
             LIMIT 1`,
            [email, email, cistyTelefon, cistyTelefon]
        );
        if (!rows.length) return res.json({ duplicitni: false });
        const shodaEmail = email && rows[0].email.toLowerCase() === email.toLowerCase();
        res.json({ duplicitni: true, pole: shodaEmail ? 'email' : 'telefon' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/smaz-osobu', rateLimit(20), async (req, res) => {
    try {
        const id = Number(req.body.id);
        if (!id || isNaN(id)) return res.status(400).json({ error: 'Neplatné ID osoby.' });

        const navst = await dbQuery('SELECT id, jmeno FROM navstevnici WHERE id = ?', [id]);
        if (!navst.length) return res.status(404).json({ error: 'Osoba nenalezena.' });

        await dbQuery('DELETE FROM dochazka WHERE navstevnik_id = ?', [id]);
        await dbQuery('DELETE FROM navstevnici WHERE id = ?', [id]);

        console.log(`Osoba smazána: #${id} ${navst[0].jmeno} (včetně docházky)`);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/uloz-navstevnika', rateLimit(CONFIG.RATE_LIMIT_MAX_STRICT), async (req, res) => {
    try {
        const { jmeno, email, telefon, spolecnost, podpis, fss } = req.body;

        if (!jmeno || !email) return res.status(400).json({ error: 'Jméno a email jsou povinné.' });
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Neplatná e-mailová adresa.' });
        if (!podpis || !podpis.startsWith('data:image/')) return res.status(400).json({ error: 'Chybí podpis.' });

        const cistyTelefon = telefon ? String(telefon).replace(/\s+/g, '') : '';
        const konflikt = await dbQuery(
            `SELECT id, email, REPLACE(IFNULL(telefon,''), ' ', '') AS tel FROM navstevnici
             WHERE LOWER(email) = LOWER(?) OR (? <> '' AND REPLACE(IFNULL(telefon,''), ' ', '') = ?)
             LIMIT 1`,
            [String(email).trim(), cistyTelefon, cistyTelefon]
        );
        if (konflikt.length) {
            const shodaEmail = konflikt[0].email.toLowerCase() === String(email).trim().toLowerCase();
            return res.status(409).json({
                error: shodaEmail
                    ? 'Tento e-mail už je v systému registrovaný. Použijte prosím volbu „Už jsem u vás byl(a)".'
                    : 'Toto telefonní číslo už je v systému registrované. Použijte prosím volbu „Už jsem u vás byl(a)".'
            });
        }

        const result = await dbQuery(
            'INSERT INTO navstevnici (jmeno, email, telefon, spolecnost, podpis_base64) VALUES (?, ?, ?, ?, ?)',
            [sanitizeString(jmeno), sanitizeString(email), sanitizeString(telefon, 20), sanitizeString(spolecnost), podpis]
        );

        await ulozWacomSouborNaDisk(podpis, result.insertId, 'registrace');

        if (fss) {
            const { encB64 } = ulozFss(fss, result.insertId, 'registrace');
            if (encB64) {
                await dbQuery('UPDATE navstevnici SET fss_encrypted = ? WHERE id = ?', [encB64, result.insertId]);
            }
        }

        res.json({ success: true, id: result.insertId, fssUlozen: !!fss });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/zaznamenej-prichod', rateLimit(CONFIG.RATE_LIMIT_MAX_STRICT), async (req, res) => {
    try {
        const { navstevnikId, podpisVstup, fss } = req.body;

        if (!navstevnikId || isNaN(Number(navstevnikId))) return res.status(400).json({ error: 'Neplatné ID návštěvníka.' });
        if (!podpisVstup || !podpisVstup.startsWith('data:image/')) return res.status(400).json({ error: 'Chybí podpis.' });

        const navst = await dbQuery('SELECT id FROM navstevnici WHERE id = ?', [Number(navstevnikId)]);
        if (!navst.length) return res.status(404).json({ error: 'Návštěvník nenalezen.' });

        const ins = await dbQuery(
            'INSERT INTO dochazka (navstevnik_id, stav, cas_prichodu, podpis_vstup_base64) VALUES (?, "Uvnitr", NOW(), ?)',
            [Number(navstevnikId), podpisVstup]
        );

        await ulozWacomSouborNaDisk(podpisVstup, navstevnikId, 'vstup');

        if (fss) {
            const { encB64 } = ulozFss(fss, navstevnikId, 'vstup');
            if (encB64) {
                await dbQuery('UPDATE dochazka SET fss_encrypted = ? WHERE id = ?', [encB64, ins.insertId]);
            }
        }

        res.json({ success: true, fssUlozen: !!fss });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.get('/api/nacti-aktivni', async (req, res) => {
    try {
        const rows = await dbQuery(
            `SELECT d.id AS dochazka_id, n.jmeno, n.spolecnost, n.telefon,
                    DATE_FORMAT(d.cas_prichodu, '%d.%m.%Y %H:%i') AS cas
             FROM dochazka d
             JOIN navstevnici n ON d.navstevnik_id = n.id
             WHERE d.stav = 'Uvnitr'
             ORDER BY d.cas_prichodu DESC`
        );
        res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/zaznamenej-odchod', async (req, res) => {
    try {
        const dochazkaId = Number(req.body.dochazkaId);
        if (!dochazkaId || isNaN(dochazkaId)) return res.status(400).json({ error: 'Neplatné ID.' });
        await dbQuery(
            'UPDATE dochazka SET stav = "Odesel", cas_odchodu = NOW() WHERE id = ? AND stav = "Uvnitr"',
            [dochazkaId]
        );
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.get('/api/nacti-vsechny-cleny', async (req, res) => {
    try {
        const rows = await dbQuery(
            `SELECT n.id, n.jmeno, n.email, n.spolecnost, n.telefon, n.podpis_base64,
                    (n.fss_encrypted IS NOT NULL) AS ma_fss,
                    (SELECT d.podpis_vstup_base64 FROM dochazka d WHERE d.navstevnik_id = n.id ORDER BY d.cas_prichodu DESC LIMIT 1) AS posledni_podpis
             FROM navstevnici n ORDER BY n.id DESC`
        );
        res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.get('/api/nacti-dochazku', async (req, res) => {
    try {
        const rows = await dbQuery(
            `SELECT d.id, n.jmeno, n.email, n.spolecnost, d.stav, d.cas_prichodu, d.cas_odchodu,
                    d.podpis_vstup_base64, (d.fss_encrypted IS NOT NULL) AS ma_fss
             FROM dochazka d
             JOIN navstevnici n ON d.navstevnik_id = n.id
             ORDER BY d.cas_prichodu DESC
             LIMIT 500`
        );
        res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.get('/api/nacti-pravidla', async (req, res) => {
    try {
        const rows = await dbQuery('SELECT id, obsah, poradi FROM pravidla ORDER BY poradi ASC');
        res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/uloz-pravidlo', rateLimit(20), async (req, res) => {
    try {
        const { obsah, poradi } = req.body;
        if (!obsah) return res.status(400).json({ error: 'Obsah chybí.' });
        await dbQuery('INSERT INTO pravidla (obsah, poradi) VALUES (?, ?)', [obsah, Number(poradi) || 1]);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/uprav-pravidlo', rateLimit(30), async (req, res) => {
    try {
        const id = Number(req.body.id);
        if (!id) return res.status(400).json({ error: 'Chybí ID stránky.' });
        const { obsah, poradi } = req.body;
        if (obsah !== undefined && obsah !== null) {
            await dbQuery('UPDATE pravidla SET obsah = ? WHERE id = ?', [String(obsah), id]);
        }
        if (poradi !== undefined && poradi !== null && !isNaN(Number(poradi))) {
            await dbQuery('UPDATE pravidla SET poradi = ? WHERE id = ?', [Number(poradi), id]);
        }
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/smaz-pravidla', async (req, res) => {
    try { await dbQuery('DELETE FROM pravidla'); res.json({ success: true }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/smaz-stranku', async (req, res) => {
    try {
        const id = Number(req.body.id);
        if (!id) return res.status(400).json({ error: 'Chybí ID.' });
        await dbQuery('DELETE FROM pravidla WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/uloz-wacom-podpis', rateLimit(20), async (req, res) => {
    try {
        const { imageBase64, navstevnikId, typ } = req.body;
        if (!imageBase64 || !imageBase64.startsWith('data:image/')) {
            return res.status(400).json({ error: 'Neplatná data podpisu.' });
        }
        const filename = await ulozWacomSouborNaDisk(imageBase64, navstevnikId, typ || 'wacom');
        if (filename) res.json({ success: true, filename });
        else res.status(500).json({ error: 'Nepodařilo se uložit soubor.' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba serveru' }); }
});

let stavKiosku = { cas: 0, tablet: null };
app.get('/api/health', async (req, res) => {
    const out = { server: true, db: false, fssSifrovani: /^[0-9a-fA-F]{64}$/.test(CONFIG.FSS_KEY), cas: new Date().toISOString() };
    try {
        await dbQuery('SELECT 1');
        out.db = true;
        const [{ c: cleni }] = await dbQuery('SELECT COUNT(*) c FROM navstevnici');
        const [{ c: uvnitr }] = await dbQuery("SELECT COUNT(*) c FROM dochazka WHERE stav = 'Uvnitr'");
        const [{ c: fssPocet }] = await dbQuery('SELECT (SELECT COUNT(*) FROM navstevnici WHERE fss_encrypted IS NOT NULL) + (SELECT COUNT(*) FROM dochazka WHERE fss_encrypted IS NOT NULL) c');
        out.statistiky = { cleni, uvnitr, fssPocet };
    } catch (e) { out.dbChyba = e.message; }
    out.kiosek = stavKiosku;
    res.json(out);
});


app.post('/api/uloz-pravidla-davka', rateLimit(10), async (req, res) => {
    try {
        const strany = req.body.strany;
        if (!Array.isArray(strany) || !strany.length) return res.status(400).json({ error: 'Prázdná dávka.' });
        if (strany.length > 60) return res.status(400).json({ error: 'Dokument je moc dlouhý (max 60 stran).' });
        const stavajici = await dbQuery('SELECT COUNT(*) c FROM pravidla');
        let poradi = Number(stavajici[0].c) + 1;
        for (const obsah of strany) {
            if (typeof obsah !== 'string' || !obsah.trim()) continue;
            await dbQuery('INSERT INTO pravidla (obsah, poradi) VALUES (?, ?)', [obsah, poradi++]);
        }
        res.json({ success: true, ulozeno: strany.length });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/stav-kiosku', rateLimit(30), (req, res) => {
    if (req.body && req.body.vypnuto) {
        if (stavKiosku.cas) {
            console.log('kiosek ohlasil radne vypnuti');
            posliDiscord('GuestBook: kiosek byl vypnut (radne ukonceni aplikace).');
        }
        stavKiosku = { cas: 0, tablet: null, vypnuto: Date.now() };
        stavHlidace.kiosek = true;
        return res.json({ success: true });
    }
    if (!stavKiosku || !stavKiosku.cas) console.log('kiosek se zacal hlasit (tablet: ' + (req.body.tablet ? 'ano' : 'ne') + ')');
    stavKiosku = { cas: Date.now(), tablet: !!req.body.tablet };
    res.json({ success: true });
});

let povelProKiosek = null;
app.get('/api/kiosek-povel', rateLimit(60), (req, res) => {
    if (!povelProKiosek || Date.now() - povelProKiosek.cas > 60000) {
        povelProKiosek = null;
        return res.json({ povel: null });
    }
    const p = povelProKiosek;
    povelProKiosek = null;
    res.json({ povel: p });
});

function ulozVzhledNaServeru(b) {
    const hex = v => /^#[0-9a-fA-F]{6}$/.test(String(v || ''));
    const slozka = path.dirname(ENV_PATH);
    let t = {};
    try { t = JSON.parse(fs.readFileSync(path.join(slozka, 'theme.json'), 'utf-8')); } catch (e) {}
    const prichozi = Number(b.verze) || 0;
    if (prichozi && Number(t.verze) && prichozi < Number(t.verze)) return t;
    for (const k of ['primarni', 'akcent', 'pozadi', 'text']) if (hex(b[k])) t[k] = b[k];
    if (b.companyName !== undefined) t.companyName = sanitizeString(b.companyName, 120) || '';
    if (typeof b.font === 'string' && b.font.length < 40) t.font = b.font;
    if (typeof b.tabletText1 === 'string') t.tabletText1 = b.tabletText1.slice(0, 80);
    if (typeof b.tabletText2 === 'string') t.tabletText2 = b.tabletText2.slice(0, 80);
    const ulozObrazek = (dataUrl, zaklad, klicSoubor, klicData) => {
        if (typeof dataUrl !== 'string' || dataUrl.length >= 4 * 1024 * 1024) return;
        const m = dataUrl.match(/^data:image\/(png|jpeg|svg\+xml|webp|x-icon|vnd\.microsoft\.icon);base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return;
        t[klicData] = dataUrl;
        const pripona = m[1] === 'svg+xml' ? '.svg' : m[1] === 'jpeg' ? '.jpg' : (m[1] === 'x-icon' || m[1] === 'vnd.microsoft.icon') ? '.ico' : '.' + m[1];
        const cil = path.join(slozka, zaklad + pripona);
        try {
            fs.writeFileSync(cil, Buffer.from(m[2], 'base64'));
            t[klicSoubor] = cil;
        } catch (e) {
            console.warn(zaklad + ' se nepodarilo zapsat do ' + slozka + ': ' + e.message + ' (pouziva se kopie z theme.json)');
        }
    };
    ulozObrazek(b.logoData, 'kiosek-logo', 'logo', 'logoData');
    ulozObrazek(b.tabletObrazekData, 'kiosek-tablet', 'tabletObrazek', 'tabletObrazekData');
    t.verze = prichozi || Date.now();
    try {
        fs.writeFileSync(path.join(slozka, 'theme.json'), JSON.stringify(t, null, 2), 'utf-8');
    } catch (e) {
        console.warn('theme.json se nepodarilo zapsat do ' + slozka + ': ' + e.message);
    }
    pripravAdminPanel();
    return t;
}

function ctiVzhledZeServeru() {
    const slozka = path.dirname(ENV_PATH);
    let t = {};
    try { t = JSON.parse(fs.readFileSync(path.join(slozka, 'theme.json'), 'utf-8')); } catch (e) {}
    const zSouboru = (cesta) => {
        try {
            if (cesta && fs.existsSync(cesta)) {
                const pripona = path.extname(cesta).toLowerCase();
                const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' }[pripona];
                if (mime) return 'data:' + mime + ';base64,' + fs.readFileSync(cesta).toString('base64');
            }
        } catch (e) {}
        return null;
    };
    return {
        verze: Number(t.verze) || 0,
        primarni: t.primarni || '', akcent: t.akcent || '', pozadi: t.pozadi || '', text: t.text || '',
        companyName: t.companyName || '', font: t.font || null,
        tabletText1: t.tabletText1, tabletText2: t.tabletText2,
        logoData: t.logoData || zSouboru(t.logo),
        tabletObrazekData: t.tabletObrazekData || zSouboru(t.tabletObrazek)
    };
}

app.post('/api/kiosek-vzhled', rateLimit(10), (req, res) => {
    try {
        const t = ulozVzhledNaServeru(req.body || {});
        console.log('vzhled prevzat' + (t.companyName ? ' (' + t.companyName + ')' : ''));
        res.json({ success: true, verze: Number(t.verze) || 0 });
    } catch (e) { res.status(500).json({ error: 'Vzhled se nepodařilo převzít: ' + e.message }); }
});

app.get('/api/vzhled', rateLimit(60), (req, res) => {
    res.json(ctiVzhledZeServeru());
});

app.get('/api/sprava-adresa', rateLimit(30), (req, res) => {
    res.json({ cesta: aktualniAdminPath });
});

app.get('/api/heslo-existuje', rateLimit(30), (req, res) => {
    res.json({ existuje: !!CONFIG.ADMIN_HESLO });
});
app.post('/api/over-heslo', rateLimit(10), (req, res) => {
    const a = Buffer.from(String((req.body || {}).heslo || ''));
    const b = Buffer.from(CONFIG.ADMIN_HESLO || '');
    res.json({ ok: a.length === b.length && crypto.timingSafeEqual(a, b) });
});

function jeSpravaPovolena(req) {
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (ip === '127.0.0.1' || ip === '::1') return true;
    const seznam = String(ENV.ADMIN_POVOLENE_IP || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!seznam.length) return true;
    return seznam.some(vzor => {
        if (vzor === ip) return true;
        if (vzor.includes('*')) {
            const re = new RegExp('^' + vzor.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\d{1,3}') + '$');
            return re.test(ip);
        }
        return false;
    });
}

async function posliDiscord(text) {
    if (!CONFIG.DISCORD_WEBHOOK) return;
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        await fetch(CONFIG.DISCORD_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: String(text).slice(0, 1900) }),
            signal: ctrl.signal
        }).finally(() => clearTimeout(t));
    } catch (e) { console.warn('discord webhook selhal:', e.message); }
}
const stavHlidace = { db: true, kiosek: true, tablet: true };
async function hlidac() {
    let dbOk = true;
    try { await dbQuery('SELECT 1'); } catch (e) { dbOk = false; }
    if (dbOk !== stavHlidace.db) {
        stavHlidace.db = dbOk;
        posliDiscord(dbOk ? 'LINTECH kiosek: databaze zase bezi.' : 'LINTECH kiosek: vypadla databaze, podpisy se neukladaji!');
    }
    const kiosekOk = stavKiosku.cas === 0 || (Date.now() - stavKiosku.cas) < 90 * 1000;
    if (kiosekOk !== stavHlidace.kiosek) {
        stavHlidace.kiosek = kiosekOk;
        posliDiscord(kiosekOk ? 'LINTECH kiosek: aplikace se zase hlasi.' : 'LINTECH kiosek: aplikace se prestala hlasit (mozna spadla nebo je bez site).');
    }
    if (stavKiosku.cas > 0 && stavKiosku.tablet !== null) {
        const tabletOk = stavKiosku.tablet;
        if (tabletOk !== stavHlidace.tablet) {
            stavHlidace.tablet = tabletOk;
            posliDiscord(tabletOk ? 'LINTECH kiosek: podpisovy tablet pripojen.' : 'LINTECH kiosek: podpisovy tablet je ODPOJENY.');
        }
    }
}
setInterval(hlidac, 30000);

const ADMIN_ENC = path.join(__dirname, 'admin.enc');
const ADMIN_ENC_ZALOHA = path.join(path.dirname(ENV_PATH), 'admin.enc');
const ADMIN_SRC = path.join(__dirname, 'admin_panel.html');
const ADMIN_DIR = path.join(path.dirname(ENV_PATH), 'admin_runtime');

function najdiAdminEnc() {
    return [ADMIN_ENC, ADMIN_ENC_ZALOHA].find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

function vlozBrandingDoPanelu(html) {
    try {
        const themePath = path.join(path.dirname(ENV_PATH), 'theme.json');
        if (!fs.existsSync(themePath)) return html;
        const t = JSON.parse(fs.readFileSync(themePath, 'utf-8'));
        let vlozka = '';
        const css = [];
        if (/^#[0-9a-f]{6}$/i.test(t.primarni || '')) css.push('--blue:' + t.primarni);
        if (/^#[0-9a-f]{6}$/i.test(t.akcent || '')) css.push('--red:' + t.akcent);
        if (/^#[0-9a-f]{6}$/i.test(t.pozadi || '')) css.push('--paper:' + t.pozadi);
        if (css.length) vlozka += '<style>:root{' + css.join(';') + '}</style>';
        let logoData = (typeof t.logoData === 'string' && t.logoData.startsWith('data:image/') && t.logoData.length < 4 * 1024 * 1024) ? t.logoData : null;
        if (!logoData && t.logo && fs.existsSync(t.logo) && fs.statSync(t.logo).size < 3 * 1024 * 1024) {
            const pripona = path.extname(t.logo).toLowerCase();
            const mime = pripona === '.svg' ? 'image/svg+xml' : (pripona === '.jpg' || pripona === '.jpeg') ? 'image/jpeg' : pripona === '.webp' ? 'image/webp' : pripona === '.ico' ? 'image/x-icon' : 'image/png';
            logoData = 'data:' + mime + ';base64,' + fs.readFileSync(t.logo).toString('base64');
        }
        vlozka += '<script>window.GB_BRAND=' + JSON.stringify({ company: t.companyName || null, logo: logoData }) + '</script>';
        return html.replace('</head>', vlozka + '</head>');
    } catch (e) { return html; }
}
let adminHtml = null;

const ADMIN_ZAKLAD = (CONFIG.ADMIN_PATH || '/sprava').replace(/\d+$/, '') || '/sprava';
const ROTACE_CONF = path.join(__dirname, 'admin_rotace.json');
const ROTACE_MIN_MS = 15 * 1000;  
let aktualniAdminPath = ADMIN_ZAKLAD;
let rotaceZapnuta = true;
let rotaceIntervalMs = 60 * 1000; 
let rotaceTimer = null;
let dalsiZmenaCas = 0;           

function nactiRotaciZDisku() {
    try {
        if (fs.existsSync(ROTACE_CONF)) {
            const c = JSON.parse(fs.readFileSync(ROTACE_CONF, 'utf-8'));
            if (typeof c.zapnuta === 'boolean') rotaceZapnuta = c.zapnuta;
            if (Number.isFinite(c.intervalMs) && c.intervalMs >= ROTACE_MIN_MS) rotaceIntervalMs = c.intervalMs;
        }
    } catch (e) { console.warn('nacteni admin_rotace.json selhalo:', e.message); }
}
function ulozRotaciNaDisk() {
    try { fs.writeFileSync(ROTACE_CONF, JSON.stringify({ zapnuta: rotaceZapnuta, intervalMs: rotaceIntervalMs }), 'utf-8'); }
    catch (e) { console.warn('ulozeni admin_rotace.json selhalo:', e.message); }
}

function novaAdminCesta() {
    const cislo = 100 + crypto.randomInt(900);
    return ADMIN_ZAKLAD + cislo;
}
function serverIP() {
    if (CONFIG.HOST && CONFIG.HOST !== '0.0.0.0' && CONFIG.HOST !== '127.0.0.1') return CONFIG.HOST;
    try {
        const nety = require('os').networkInterfaces();
        for (const jmeno of Object.keys(nety)) {
            for (const ni of nety[jmeno]) {
                if (ni.family === 'IPv4' && !ni.internal && jePrivatniIP(ni.address)) return ni.address;
            }
        }
    } catch (e) {}
    return CONFIG.HOST === '127.0.0.1' ? '127.0.0.1' : '<ip-serveru>';
}
function oznamAdminCestu(duvod) {
    const url = `http://${serverIP()}:${CONFIG.PORT}${aktualniAdminPath}`;
    console.log(`sprava (${duvod}): ${url}`);
    if (hesloPraveVygenerovano) {
        posliDiscord(`🔐 **GuestBook – přístup do správy**\nAdresa: ${url}\nHeslo: \`${CONFIG.ADMIN_HESLO}\`\n\nHeslo si prosím uložte. Můžete si ho změnit v Nastavení → Správa a přístup. Adresa se čas od času mění – aktuální vždy najdete tady.`);
        hesloPraveVygenerovano = false;
    } else {
        posliDiscord(`GuestBook – nová adresa správy: ${url}\n(Heslo zůstává stejné jako dřív.)`);
    }
}
function rotujAdminCestu() {
    aktualniAdminPath = novaAdminCesta();
    oznamAdminCestu('nova adresa');
}
function spustRotaci() {
    if (rotaceTimer) clearInterval(rotaceTimer);
    if (!rotaceZapnuta) { dalsiZmenaCas = 0; return; }
    dalsiZmenaCas = Date.now() + rotaceIntervalMs;
    rotaceTimer = setInterval(() => {
        if (!rotaceZapnuta) return;
        rotujAdminCestu();
        dalsiZmenaCas = Date.now() + rotaceIntervalMs;
    }, rotaceIntervalMs);
}

function pripravAdminPanel() {
    if (fs.existsSync(ADMIN_SRC)) {
        const html = fs.readFileSync(ADMIN_SRC, 'utf-8');
        const zasifrovano = encryptFss(html);
        try { fs.writeFileSync(ADMIN_ENC, zasifrovano, 'utf-8'); } catch (e) {}
        try { fs.writeFileSync(ADMIN_ENC_ZALOHA, zasifrovano, 'utf-8'); } catch (e) {}
        try { fs.unlinkSync(ADMIN_SRC); } catch (e) {}
        console.log('admin panel zasifrovan do admin.enc');
    }
    const encSoubor = najdiAdminEnc();
    if (!encSoubor) {
        console.warn('admin.enc nenalezen (hledal jsem ' + ADMIN_ENC + ' i ' + ADMIN_ENC_ZALOHA + '), webova sprava nepobezi');
        return;
    }
    try {
        adminHtml = decryptFss(fs.readFileSync(encSoubor, 'utf-8'));
    } catch (e) {
        if (zkusPuvodniFssKlic(encSoubor)) {
            adminHtml = decryptFss(fs.readFileSync(encSoubor, 'utf-8'));
            console.log('admin.enc rozsifrovan puvodnim klicem z API_Server/.env – klic byl prevzat do konfigurace.');
        } else {
            adminHtml = null;
            console.warn('admin.enc nejde rozsifrovat aktualnim FSS_ENCRYPTION_KEY – webova sprava nepobezi.');
            console.warn('   Reseni: vratte puvodni FSS_ENCRYPTION_KEY do server.env, nebo prilozte admin_panel.html vedle server.js (pri startu se znovu zasifruje).');
            return;
        }
    }
    try { if (!fs.existsSync(ADMIN_ENC_ZALOHA)) fs.copyFileSync(encSoubor, ADMIN_ENC_ZALOHA); } catch (e) {}
    adminHtml = vlozBrandingDoPanelu(adminHtml);
    if (fs.existsSync(ADMIN_DIR)) fs.rmSync(ADMIN_DIR, { recursive: true, force: true });
    fs.mkdirSync(ADMIN_DIR, { recursive: true });
    fs.writeFileSync(path.join(ADMIN_DIR, 'index.html'), adminHtml, 'utf-8');
}

function zkusPuvodniFssKlic(encSoubor) {
    try {
        const legacyEnv = path.join(__dirname, '.env');
        if (!fs.existsSync(legacyEnv)) return false;
        let klic = null;
        for (const line of fs.readFileSync(legacyEnv, 'utf-8').split(/\r?\n/)) {
            const m = line.match(/^\s*FSS_ENCRYPTION_KEY\s*=\s*(.+)\s*$/);
            if (m) { klic = m[1].trim().replace(/^["']|["']$/g, ''); break; }
        }
        if (!klic || !/^[0-9a-fA-F]{64}$/.test(klic) || klic === CONFIG.FSS_KEY) return false;

        const puvodniBuf = FSS_KEY_BUF;
        FSS_KEY_BUF = Buffer.from(klic, 'hex');
        try {
            decryptFss(fs.readFileSync(encSoubor, 'utf-8'));
        } catch (e) {
            FSS_KEY_BUF = puvodniBuf;
            return false;
        }
        CONFIG.FSS_KEY = klic;
        try {
            let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
            if (/^FSS_ENCRYPTION_KEY=.*$/m.test(text)) text = text.replace(/^FSS_ENCRYPTION_KEY=.*$/m, 'FSS_ENCRYPTION_KEY=' + klic);
            else text += (text && !text.endsWith('\n') ? '\n' : '') + 'FSS_ENCRYPTION_KEY=' + klic + '\n';
            fs.writeFileSync(ENV_PATH, text, 'utf-8');
        } catch (e) { console.warn('prevzaty klic se nepodarilo zapsat do env:', e.message); }
        return true;
    } catch (e) { return false; }
}
function uklidAdminPanel() {
    try { if (fs.existsSync(ADMIN_DIR)) fs.rmSync(ADMIN_DIR, { recursive: true, force: true }); } catch (e) {}
}

function jePod(req, suffix) {
    return req.path === aktualniAdminPath + suffix;
}

app.get(/^\/sprava\d*$/i, (req, res, next) => {
    if (!jeSpravaPovolena(req)) return res.status(404).send('Nenalezeno.');
    if (req.path !== aktualniAdminPath) {
        const ip = String(req.ip || '');
        if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
            return res.redirect(aktualniAdminPath);
        }
        return res.status(404).send('Nenalezeno.');
    }
    res.type('html').send(`<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LINTECH sprava</title><style>
body{font-family:'Segoe UI',sans-serif;background:#F4F6F9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border:1px solid #E3E8EF;border-top:4px solid #EE2737;border-radius:14px;padding:34px;width:min(92vw,380px);box-shadow:0 18px 50px rgba(0,32,91,.10)}
h1{color:#00205B;font-size:22px;margin:0 0 6px}p{color:#6b7482;font-size:14px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:14px;border:1.5px solid #E3E8EF;border-radius:10px;font-size:16px}
button{width:100%;margin-top:12px;padding:14px;background:#00205B;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer}
.err{color:#a11624;font-size:13.5px;margin-top:10px;display:none}
</style></head><body><div class="box"><h1>Správa systému</h1><p>Zadejte přístupové heslo.</p>
<input type="password" id="h" placeholder="Heslo" autofocus>
<button onclick="prihlasit()">Přihlásit</button><div class="err" id="e">Nesprávné heslo.</div>
<script>
async function prihlasit(){
  const r = await fetch(location.pathname + '/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({heslo: document.getElementById('h').value})});
  if(r.ok){ const d = await r.json(); location.href = location.pathname + '/panel?t=' + d.token; }
  else document.getElementById('e').style.display='block';
}
document.getElementById('h').addEventListener('keydown', e => { if(e.key==='Enter') prihlasit(); });
</script></div></body></html>`);
});

const PRIJIMANA_HESLA = [];
if (CONFIG.ADMIN_HESLO) PRIJIMANA_HESLA.push(CONFIG.ADMIN_HESLO);
try {
    const legacyEnvH = path.join(__dirname, '.env');
    if (fs.existsSync(legacyEnvH) && path.resolve(legacyEnvH) !== path.resolve(ENV_PATH)) {
        for (const line of fs.readFileSync(legacyEnvH, 'utf-8').split(/\r?\n/)) {
            const m = line.match(/^\s*ADMIN_HESLO\s*=\s*(.+)\s*$/);
            if (!m) continue;
            const h = m[1].trim().replace(/^["']|["']$/g, '');
            if (h && !PRIJIMANA_HESLA.includes(h)) {
                PRIJIMANA_HESLA.push(h);
                console.log('prijimam i starsi heslo do spravy z API_Server/.env');
            }
            break;
        }
    }
} catch (e) {}

function overAdminHeslo(poslane) {
    const a = Buffer.from(String(poslane || ''));
    for (const heslo of PRIJIMANA_HESLA) {
        const b = Buffer.from(heslo);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
    return false;
}

const adminLoginPokusy = new Map();
app.post(/^\/sprava\d*\/login$/i, express.json(), (req, res) => {
    if (!jeSpravaPovolena(req)) return res.status(404).json({ error: 'Nenalezeno.' });
    if (req.path !== aktualniAdminPath + '/login') return res.status(404).json({ error: 'Nenalezeno.' });
    const ip = req.ip;
    const pokusy = adminLoginPokusy.get(ip) || [];
    const aktualni = pokusy.filter(t => Date.now() - t < 10 * 60 * 1000);
    if (aktualni.length >= 8) return res.status(429).json({ error: 'Moc pokusů, zkuste to za chvíli.' });
    if (overAdminHeslo(req.body.heslo)) {
        const token = crypto.randomBytes(24).toString('hex');
        adminTokeny.set(token, Date.now());
        return res.json({ token });
    }
    aktualni.push(Date.now());
    adminLoginPokusy.set(ip, aktualni);
    res.status(401).json({ error: 'Nesprávné heslo.' });
});

app.get(/^\/sprava\d*\/panel$/i, (req, res) => {
    if (req.path !== aktualniAdminPath + '/panel') return res.status(404).send('Nenalezeno.');
    if (!overAdminToken(String(req.query.t || ''))) return res.redirect(aktualniAdminPath);
    if (!adminHtml) return res.status(503).send('Správa není k dispozici (chybí admin.enc).');
    res.type('html').send(adminHtml);
});

app.post('/api/admin/guestbook-akce', express.json(), (req, res) => {
    if (!overAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Neautorizováno.' });
    const akce = String(req.body.akce || '');
    if (!['restart', 'nastaveni', 'terminal'].includes(akce)) return res.status(400).json({ error: 'Neznámý povel.' });
    povelProKiosek = { akce, cas: Date.now() };
    try {
        fs.writeFileSync(path.join(path.dirname(ENV_PATH), 'guestbook-povel.json'),
            JSON.stringify({ akce, cas: Date.now() }), 'utf-8');
    } catch (e) {}
    res.json({ success: true });
});

const { spawn: spawnShell } = require('child_process');
const terminalVstupenky = new Map(); 
const terminalSezeni = new Map();  

app.post('/api/admin/terminal-token', (req, res) => {
    if (!overAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Neautorizováno.' });
    const t = crypto.randomBytes(24).toString('hex');
    terminalVstupenky.set(t, Date.now());
    setTimeout(() => terminalVstupenky.delete(t), 60 * 1000);
    res.json({ token: t });
});

function ukonciTerminalSezeni(sid) {
    const s = terminalSezeni.get(sid);
    if (!s) return;
    terminalSezeni.delete(sid);
    try { s.res && s.res.end(); } catch (e) {}
    try { s.proces && s.proces.kill(); } catch (e) {}
}

setInterval(() => {
    const ted = Date.now();
    for (const [sid, s] of terminalSezeni) {
        if (ted - s.posledni > 15 * 60 * 1000) ukonciTerminalSezeni(sid);
    }
}, 60 * 1000);

app.get(/^\/sprava\d*\/terminal$/i, (req, res) => {
    if (!jeSpravaPovolena(req)) return res.status(403).send('Přístup ke správě je z tohoto počítače zakázán.');
    const t = String(req.query.t || '');
    if (!terminalVstupenky.has(t)) return res.status(401).send('Odkaz na terminál vypršel. Otevřete ho znovu ze správy.');
    terminalVstupenky.delete(t);

    const sid = crypto.randomBytes(24).toString('hex');
    const jeWin = process.platform === 'win32';
    const shell = jeWin ? spawnShell('cmd.exe', ['/Q', '/K', 'chcp 65001>nul'], { cwd: require('os').homedir(), windowsHide: true })
                        : spawnShell('bash', ['-i'], { cwd: require('os').homedir() });
    const sezeni = { proces: shell, res: null, fronta: [], posledni: Date.now() };
    terminalSezeni.set(sid, sezeni);

    const posli = (text) => {
        if (!text) return;
        const radky = 'data: ' + String(text).replace(/\r/g, '').split('\n').join('\ndata: ') + '\n\n';
        if (sezeni.res) { try { sezeni.res.write(radky); } catch (e) {} }
        else sezeni.fronta.push(radky);
    };
    shell.stdout.on('data', d => posli(d.toString('utf-8')));
    shell.stderr.on('data', d => posli(d.toString('utf-8')));
    shell.on('exit', () => { posli('\n[shell byl ukončen]'); setTimeout(() => ukonciTerminalSezeni(sid), 500); });

    res.type('html').send(terminalHtml(sid, jeWin ? 'cmd.exe' : 'bash'));
});

app.get('/terminal-proud', (req, res) => {
    if (!jeSpravaPovolena(req)) return res.status(403).end();
    const s = terminalSezeni.get(String(req.query.s || ''));
    if (!s) return res.status(401).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    s.res = res;
    s.posledni = Date.now();
    for (const r of s.fronta.splice(0)) { try { res.write(r); } catch (e) {} }
    req.on('close', () => { if (s.res === res) s.res = null; });
});

app.post('/terminal-vstup', express.json(), (req, res) => {
    if (!jeSpravaPovolena(req)) return res.status(403).json({ error: 'Zakázáno.' });
    const s = terminalSezeni.get(String(req.body.s || ''));
    if (!s) return res.status(401).json({ error: 'Sezení už neběží.' });
    s.posledni = Date.now();
    try {
        s.proces.stdin.write(String(req.body.text || '') + (process.platform === 'win32' ? '\r\n' : '\n'));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Shell nepřijímá vstup.' }); }
});

function terminalHtml(sid, shellNazev) {
    return `<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8">
<title>GuestBook – terminál</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;height:100%;background:#10161d;color:#d7e0ea;font-family:Consolas,'Cascadia Mono',monospace;}
#hlava{display:flex;align-items:center;gap:10px;padding:9px 14px;background:#1a232e;border-bottom:1px solid #263241;font-size:13px;}
#hlava b{color:#fff;font-weight:600;}
#hlava span{color:#7d8b9b;}
#vystup{box-sizing:border-box;height:calc(100% - 84px);overflow-y:auto;padding:12px 14px;white-space:pre-wrap;word-break:break-all;font-size:13.5px;line-height:1.45;}
#radek{display:flex;align-items:center;gap:8px;padding:8px 14px;background:#1a232e;border-top:1px solid #263241;}
#radek b{color:#5fb3f0;}
#prikaz{flex:1;background:transparent;border:none;outline:none;color:#fff;font:inherit;font-size:13.5px;}
</style></head><body>
<div id="hlava"><b>Terminál kiosku</b><span>${shellNazev} · počítač, na kterém běží GuestBook server</span></div>
<div id="vystup"></div>
<div id="radek"><b>&gt;</b><input id="prikaz" autocomplete="off" spellcheck="false" placeholder="Napište příkaz a stiskněte Enter" autofocus></div>
<script>
const SID=${JSON.stringify(sid)};
const vystup=document.getElementById('vystup');
const vstup=document.getElementById('prikaz');
const historie=[]; let hIndex=-1;
function pridej(t){
    const uSpodu=vystup.scrollTop+vystup.clientHeight>=vystup.scrollHeight-30;
    vystup.appendChild(document.createTextNode(t));
    if(vystup.textContent.length>400000)vystup.textContent=vystup.textContent.slice(-300000);
    if(uSpodu)vystup.scrollTop=vystup.scrollHeight;
}
const proud=new EventSource('/terminal-proud?s='+SID);
proud.onmessage=e=>pridej(e.data+'\\n');
proud.onerror=()=>pridej('\\n[spojení se serverem se přerušilo]\\n');
vstup.addEventListener('keydown',async e=>{
    if(e.key==='Enter'){
        const text=vstup.value;
        vstup.value='';
        if(text.trim()){historie.push(text);hIndex=historie.length;}
        try{
            const r=await fetch('/terminal-vstup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({s:SID,text})});
            if(!r.ok)pridej('\\n[sezení už neběží – zavřete okno a otevřete terminál znovu ze správy]\\n');
        }catch(er){pridej('\\n[příkaz se nepodařilo odeslat]\\n');}
    }else if(e.key==='ArrowUp'){if(hIndex>0){hIndex--;vstup.value=historie[hIndex];e.preventDefault();}}
    else if(e.key==='ArrowDown'){if(hIndex<historie.length-1){hIndex++;vstup.value=historie[hIndex];}else{hIndex=historie.length;vstup.value='';}e.preventDefault();}
});
document.body.addEventListener('click',()=>vstup.focus());
</script></body></html>`;
}

app.get('/api/admin/podpis/:typ/:id', async (req, res) => {
    if (!overAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Neautorizováno.' });
    try {
        const id = Number(req.params.id);
        let radek;
        if (req.params.typ === 'navstevnik') {
            [radek] = await dbQuery('SELECT jmeno, podpis_base64 AS obrazek, (fss_encrypted IS NOT NULL) AS ma_fss FROM navstevnici WHERE id = ?', [id]);
        } else if (req.params.typ === 'dochazka') {
            [radek] = await dbQuery('SELECT CONCAT("Návštěva #", d.id) AS jmeno, d.podpis_vstup_base64 AS obrazek, (d.fss_encrypted IS NOT NULL) AS ma_fss FROM dochazka d WHERE d.id = ?', [id]);
        } else return res.status(400).json({ error: 'Neznámý typ.' });
        if (!radek) return res.status(404).json({ error: 'Záznam nenalezen.' });
        res.json({ jmeno: radek.jmeno, obrazek: radek.obrazek || null, ma_fss: !!radek.ma_fss });
    } catch (e) { res.status(500).json({ error: 'Chyba databáze' }); }
});

function fssNaBinarku(fssText) {
    const s = String(fssText).trim();
    if (/^\d+(,\d+)*$/.test(s)) return Buffer.from(s.split(',').map(Number));
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(s)) {
        const buf = Buffer.from(s, 'base64');
        if (buf.length > 2 && buf[0] === 0x46 && buf[1] === 0x53) return buf;
    }
    return Buffer.from(s, 'binary');
}

app.get('/api/admin/fss-soubor/:typ/:id', async (req, res) => {
    if (!overAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Neautorizováno.' });
    try {
        const id = Number(req.params.id);
        const tabulka = req.params.typ === 'navstevnik' ? 'navstevnici' : req.params.typ === 'dochazka' ? 'dochazka' : null;
        if (!tabulka) return res.status(400).json({ error: 'Neznámý typ.' });
        const [radek] = await dbQuery(`SELECT fss_encrypted FROM ${tabulka} WHERE id = ?`, [id]);
        if (!radek || !radek.fss_encrypted) return res.status(404).json({ error: 'FSS podpis tu není.' });
        const binarka = fssNaBinarku(decryptFss(radek.fss_encrypted));
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="podpis_${req.params.typ}_${id}.fss"`);
        res.send(binarka);
    } catch (e) { res.status(500).json({ error: 'Dešifrování selhalo – zkontrolujte FSS_ENCRYPTION_KEY.' }); }
});

const DLOUHE_SLOUPCE = /text|blob|json/i;

async function popisTabulky(tabulka) {
    const tabulky = (await dbQueryId('SHOW TABLES')).map(r => Object.values(r)[0]);
    if (!tabulky.includes(tabulka)) throw new Error('Neznámá tabulka.');
    const popis = await dbQueryId('DESCRIBE ??', [tabulka]);
    return popis.map(s => ({ nazev: s.Field, typ: s.Type, pk: s.Key === 'PRI', dlouhy: DLOUHE_SLOUPCE.test(s.Type) }));
}

app.get('/api/admin/db-tabulky', async (req, res) => {
    if (!overAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Neautorizováno.' });
    try {
        const tabulky = [];
        for (const r of await dbQueryId('SHOW TABLES')) {
            const nazev = Object.values(r)[0];
            const [pocet] = await dbQueryId('SELECT COUNT(*) AS n FROM ??', [nazev]);
            tabulky.push({ nazev, pocet: pocet.n });
        }
        res.json(tabulky);
    } catch (e) { res.status(500).json({ error: 'Chyba databáze' }); }
});

app.post('/api/admin/db-radky', express.json(), async (req, res) => {
    if (!overAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Neautorizováno.' });
    try {
        const { tabulka } = req.body;
        const strana = Math.max(0, Number(req.body.strana) || 0);
        const naStranu = Math.min(50, Math.max(5, Number(req.body.naStranu) || 20));
        const hledat = String(req.body.hledat || '').trim();
        const sloupce = await popisTabulky(tabulka);
        const pk = (sloupce.find(s => s.pk) || {}).nazev || null;
        let where = '', params = [tabulka];
        if (hledat) {
            const hledatelne = sloupce.filter(s => !s.dlouhy).map(s => s.nazev);
            where = ' WHERE ' + hledatelne.map(() => '?? LIKE ?').join(' OR ');
            for (const sl of hledatelne) params.push(sl, '%' + hledat + '%');
        }
        const [celkem] = await dbQueryId('SELECT COUNT(*) AS n FROM ??' + where, params);
        const radkyRaw = await dbQueryId(
            'SELECT * FROM ??' + where + (pk ? ' ORDER BY ?? DESC' : '') + ' LIMIT ? OFFSET ?',
            pk ? [...params, pk, naStranu, strana * naStranu] : [...params, naStranu, strana * naStranu]
        );
        const radky = radkyRaw.map(r => {
            const out = {};
            for (const s of sloupce) {
                let v = r[s.nazev];
                if (v instanceof Date) v = v.toISOString().slice(0, 19).replace('T', ' ');
                if (s.dlouhy && v) out[s.nazev] = { dlouhy: true, nahled: String(v).slice(0, 40) + '…' };
                else out[s.nazev] = v === null || v === undefined ? null : String(v);
            }
            return out;
        });
        res.json({ sloupce, radky, celkem: celkem.n, pk });
    } catch (e) { res.status(500).json({ error: e.message || 'Chyba databáze' }); }
});

app.post('/api/admin/db-uprav', express.json(), async (req, res) => {
    if (!overAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Neautorizováno.' });
    try {
        const { tabulka, pk, pkHodnota, sloupec, hodnota } = req.body;
        const sloupce = await popisTabulky(tabulka);
        const cil = sloupce.find(s => s.nazev === sloupec);
        const klic = sloupce.find(s => s.nazev === pk && s.pk);
        if (!cil || !klic) return res.status(400).json({ error: 'Neplatný sloupec.' });
        if (cil.dlouhy) return res.status(400).json({ error: 'Dlouhá data (podpisy) se tady upravovat nedají.' });
        await dbQueryId('UPDATE ?? SET ?? = ? WHERE ?? = ?', [tabulka, sloupec, hodnota === '' ? null : hodnota, pk, pkHodnota]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message || 'Chyba databáze' }); }
});

app.post('/api/admin/db-smaz', express.json(), async (req, res) => {
    if (!overAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Neautorizováno.' });
    try {
        const { tabulka, pk, pkHodnota } = req.body;
        const sloupce = await popisTabulky(tabulka);
        if (!sloupce.find(s => s.nazev === pk && s.pk)) return res.status(400).json({ error: 'Tabulka nemá primární klíč.' });
        await dbQueryId('DELETE FROM ?? WHERE ?? = ?', [tabulka, pk, pkHodnota]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message || 'Chyba databáze' }); }
});

app.get('/api/admin/rotace-stav', (req, res) => {
    if (!overAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Neautorizováno.' });
    res.json({
        rotaceZapnuta,
        aktualniAdminPath,
        intervalMs: rotaceIntervalMs,
        intervalSekund: Math.round(rotaceIntervalMs / 1000),
        minIntervalMs: ROTACE_MIN_MS,
        zbyvaMs: (rotaceZapnuta && dalsiZmenaCas) ? Math.max(0, dalsiZmenaCas - Date.now()) : null,
        serverCas: Date.now()
    });
});
app.post('/api/admin/rotace-prepni', express.json(), (req, res) => {
    if (!overAdminToken(req.headers['x-admin-token'])) return res.status(401).json({ error: 'Neautorizováno.' });

    if (typeof req.body.zapnuto === 'boolean') rotaceZapnuta = req.body.zapnuto;

    if (req.body.intervalSekund !== undefined) {
        const sek = Number(req.body.intervalSekund);
        if (!Number.isFinite(sek) || sek * 1000 < ROTACE_MIN_MS) {
            return res.status(400).json({ error: `Interval musí být alespoň ${ROTACE_MIN_MS / 1000} s.` });
        }
        rotaceIntervalMs = Math.round(sek) * 1000;
    }

    ulozRotaciNaDisk();
    spustRotaci();
    oznamAdminCestu(rotaceZapnuta ? `rotace zapnuta (${rotaceIntervalMs / 1000} s)` : 'rotace vypnuta (adresa se ustálila)');
    res.json({
        rotaceZapnuta,
        aktualniAdminPath,
        intervalMs: rotaceIntervalMs,
        intervalSekund: Math.round(rotaceIntervalMs / 1000),
        zbyvaMs: (rotaceZapnuta && dalsiZmenaCas) ? Math.max(0, dalsiZmenaCas - Date.now()) : null,
        serverCas: Date.now()
    });
});

app.get('/api/export-db', rateLimit(5), async (req, res) => {
    try {
        console.log('Spouštím export databáze...');
        const conn = await pool.getConnection();
        let sql = `-- LINTECH Export databáze\n-- Datum: ${new Date().toISOString()}\n-- Databáze: ${CONFIG.DB.database}\n-- =====================================================\n\n`;
        sql += `USE \`${CONFIG.DB.database}\`;\n\nSET NAMES utf8mb4;\nSET time_zone = '+00:00';\n\n`;

        const [tables] = await conn.execute(`SHOW TABLES`);
        const tableKey = `Tables_in_${CONFIG.DB.database}`;

        for (const tableRow of tables) {
            const tableName = tableRow[tableKey];
            const [[createRow]] = await conn.execute(`SHOW CREATE TABLE \`${tableName}\``);
            sql += `-- Tabulka: ${tableName}\nDROP TABLE IF EXISTS \`${tableName}\`;\n` + createRow['Create Table'] + ';\n\n';

            const [rows] = await conn.execute(`SELECT * FROM \`${tableName}\``);
            if (rows.length > 0) {
                const BATCH = 100;
                for (let i = 0; i < rows.length; i += BATCH) {
                    const batch = rows.slice(i, i + BATCH);
                    const columns = Object.keys(batch[0]).map(c => `\`${c}\``).join(', ');
                    const values = batch.map(row => {
                        const vals = Object.values(row).map(v => {
                            if (v === null) return 'NULL';
                            if (typeof v === 'number') return v;
                            if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
                            const str = String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
                            return `'${str}'`;
                        }).join(', ');
                        return `(${vals})`;
                    }).join(',\n  ');
                    sql += `INSERT INTO \`${tableName}\` (${columns}) VALUES\n  ${values};\n`;
                }
                sql += '\n';
            }
        }
        conn.release();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.setHeader('Content-Type', 'application/sql');
        res.setHeader('Content-Disposition', `attachment; filename="lintech_export_${timestamp}.sql"`);
        res.send(sql);
        console.log('Export hotov');
    } catch (e) {
        console.error('Chyba exportu:', e);
        res.status(500).json({ error: 'Export selhal: ' + e.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

if ((ENV.ADMIN_ENABLED || '1') !== '0') pripravAdminPanel();
nactiRotaciZDisku();                 
aktualniAdminPath = novaAdminCesta(); 

const server = app.listen(CONFIG.PORT, CONFIG.HOST, async () => {
    console.log(`server bezi na http://${CONFIG.HOST}:${CONFIG.PORT}`);
    console.log(`konfigurace: ${ENV_PATH} | API klic zacina na ${CONFIG.API_KEY.slice(0, 6)}…`);
    if (CONFIG.HOST === '127.0.0.1') {
        console.log('server je jen pro localhost. Pro pristup ze site nastavte v .env HOST=0.0.0.0');
    } else {
        console.log(`server je dostupny ze site na http://${serverIP()}:${CONFIG.PORT}` + (LAN_ONLY ? ' (jen privatni sit)' : ''));
    }
    oznamAdminCestu('po startu');
    spustRotaci();
    try {
        await dbQuery('SELECT 1');
        console.log('databaze pripojena');
        try { await dbQuery('SELECT fss_encrypted FROM navstevnici LIMIT 1'); }
        catch (e) { console.warn('chybi sloupce fss_encrypted, spustte migrace_fss.sql'); }
    } catch (e) {
        console.error('databaze nejede:', e.message);
    }
});

process.on('SIGTERM', () => { uklidAdminPanel(); server.close(() => { pool.end(); process.exit(0); }); });
process.on('SIGINT', () => { uklidAdminPanel(); server.close(() => { pool.end(); process.exit(0); }); });