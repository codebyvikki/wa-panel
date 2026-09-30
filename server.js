const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const ACCESS_KEY = process.env.ACCESS_KEY || 'change-me';
const MAX_PER_DAY = parseInt(process.env.MAX_PER_DAY || '10', 10);
const MIN_DELAY = 30; // seconds, server enforces this
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ---------- WhatsApp state ----------
let sock = null;
let status = 'disconnected'; // disconnected | qr | connected
let qrDataUrl = null;
let logs = [];
let running = false;
let day = new Date().toDateString();
let createdToday = 0;

const log = (m) => {
  logs.push(`${new Date().toLocaleTimeString()}  ${m}`);
  if (logs.length > 100) logs.shift();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }) });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      status = 'qr';
      qrDataUrl = await QRCode.toDataURL(qr);
    }
    if (connection === 'open') {
      status = 'connected';
      qrDataUrl = null;
      log('WhatsApp connected');
    }
    if (connection === 'close') {
      status = 'disconnected';
      qrDataUrl = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log('Logged out. Naya QR ban raha hai...');
        fs.rmSync('auth', { recursive: true, force: true });
        setTimeout(connect, 2000);
      } else {
        setTimeout(connect, 3000);
      }
    }
  });
}

// ---------- Auth (simple token) ----------
const tokens = new Set();
const auth = (req, res, next) => {
  const t = req.headers['x-token'];
  if (t && tokens.has(t)) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

app.post('/api/login', (req, res) => {
  if (String(req.body.key || '') !== ACCESS_KEY) {
    return res.status(401).json({ error: 'Wrong key' });
  }
  const t = crypto.randomBytes(24).toString('hex');
  tokens.add(t);
  res.json({ token: t });
});

app.get('/api/status', auth, (req, res) => {
  if (day !== new Date().toDateString()) {
    day = new Date().toDateString();
    createdToday = 0;
  }
  res.json({ status, qr: qrDataUrl, logs, running, createdToday, maxPerDay: MAX_PER_DAY, minDelay: MIN_DELAY });
});

app.post('/api/create', auth, (req, res) => {
  if (status !== 'connected') return res.status(400).json({ error: 'WhatsApp connected nahi hai' });
  if (running) return res.status(400).json({ error: 'Ek job pehle se chal raha hai' });

  const names = (req.body.names || []).map((s) => String(s).trim()).filter(Boolean);
  const members = (req.body.members || [])
    .map((s) => String(s).replace(/\D/g, ''))
    .filter((s) => s.length >= 10);
  const delay = Math.max(MIN_DELAY, parseInt(req.body.delay || MIN_DELAY, 10));

  if (!names.length) return res.status(400).json({ error: 'Group names do' });
  if (!members.length) return res.status(400).json({ error: 'Kam se kam 1 member number do' });

  const left = MAX_PER_DAY - createdToday;
  if (left <= 0) return res.status(400).json({ error: 'Aaj ki limit poori ho gayi' });
  const todo = names.slice(0, left);

  running = true;
  res.json({ ok: true, count: todo.length });

  (async () => {
    log(`Job start: ${todo.length} groups, gap ${delay}s+`);
    for (let i = 0; i < todo.length; i++) {
      try {
        const g = await sock.groupCreate(todo[i], members.map((n) => n + '@s.whatsapp.net'));
        createdToday++;
        log(`Created: ${todo[i]} (${g.id})`);
      } catch (e) {
        log(`Failed: ${todo[i]} - ${e.message}`);
      }
      if (i < todo.length - 1) await sleep((delay + Math.random() * 30) * 1000);
    }
    log('Job done');
    running = false;
  })();
});

app.listen(PORT, () => {
  console.log('Panel on port', PORT);
  connect();
});
