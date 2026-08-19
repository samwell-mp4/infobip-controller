import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const API_TOKEN = process.env.API_TOKEN || '';
const MAX_COMMAND_AGE_MS = 30 * 60 * 1000;

let command = null;
let lastRun = null;
let lastUpload = null;

function auth(req, res, next) {
  if (!API_TOKEN) return next();
  const token = req.get('x-api-token') || req.query.token || '';
  if (token !== API_TOKEN) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

app.get('/health', (req, res) => res.json({
  ok: true,
  service: 'infobip-extension-controller',
  time: new Date().toISOString(),
  command: command ? { id: command.id, status: command.status, createdAt: command.createdAt } : null,
  lastRun,
  lastUpload
}));

app.get('/api/config', (req, res) => {
  res.json({ ok: true, webhookConfigured: Boolean(WEBHOOK_URL) });
});

app.get('/api/command', auth, (req, res) => {
  if (!command) return res.json({ ok: true, command: null });
  if (Date.now() - command.createdAt > MAX_COMMAND_AGE_MS && command.status === 'pending') {
    command.status = 'expired';
  }
  res.json({ ok: true, command });
});

app.post('/api/start', auth, (req, res) => {
  const { dateFrom, dateTo, jobId } = req.body || {};
  if (!dateFrom || !dateTo) return res.status(400).json({ ok: false, error: 'dateFrom e dateTo são obrigatórios.' });
  command = {
    id: crypto.randomUUID(),
    jobId: jobId || null,
    type: 'START_SCRAPING',
    dateFrom: Number(dateFrom),
    dateTo: Number(dateTo),
    createdAt: Date.now(),
    status: 'pending'
  };
  res.json({ ok: true, command });
});

app.post('/api/ack', auth, (req, res) => {
  const { id, status } = req.body || {};
  if (!command || command.id !== id) return res.status(404).json({ ok: false, error: 'Comando não encontrado.' });
  command.status = status || 'received';
  command.ackAt = Date.now();
  res.json({ ok: true, command });
});

app.post('/api/run-status', auth, (req, res) => {
  lastRun = { ...req.body, receivedAt: new Date().toISOString() };
  res.json({ ok: true });
});

app.post('/api/report', auth, express.raw({ type: 'multipart/form-data', limit: '100mb' }), async (req, res) => {
  if (!WEBHOOK_URL) return res.status(500).json({ ok: false, error: 'WEBHOOK_URL não configurada.' });
  try {
    const headers = {};
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: req.body
    });
    const text = await response.text();
    lastUpload = { ok: response.ok, status: response.status, at: new Date().toISOString() };
    res.status(response.status).send(text || JSON.stringify({ ok: response.ok }));
  } catch (error) {
    lastUpload = { ok: false, error: error.message, at: new Date().toISOString() };
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Controller listening on :${PORT}`));
