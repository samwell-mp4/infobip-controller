import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const API_TOKEN = process.env.API_TOKEN || '';
const MAX_COMMAND_AGE_MS = 30 * 60 * 1000;

const DATA_DIR = process.env.DATA_DIR || '/data';
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

let command = null;
let lastRun = null;
let lastUpload = null;

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(JOBS_FILE)) {
    fs.writeFileSync(JOBS_FILE, JSON.stringify({ pending: [], sent: [] }, null, 2));
  }
}

function loadJobs() {
  ensureData();
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch (e) {
    return { pending: [], sent: [] };
  }
}

function saveJobs(jobs) {
  ensureData();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function auth(req, res, next) {
  if (!API_TOKEN) return next();
  const token = req.get('x-api-token') || req.query.token || '';
  if (token !== API_TOKEN) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// Normaliza cada item do POST do n8n: extrai numero (telefone) + link (qualquer campo que seja URL)
function normalizeJob(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let numero = String(
    obj.numero || obj.Numero || obj.phone || obj.telefone || obj.whatsapp || obj.celular || ''
  ).trim();
  if (/^https?:\/\//i.test(numero)) numero = '';
  numero = numero.replace(/\D/g, '');
  let link = '';
  for (const [k, v] of Object.entries(obj)) {
    if (/numero|phone|telefone|whatsapp|cels/i.test(k)) continue;
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
      link = v.trim();
      break;
    }
  }
  if (!link) return null;
  return { numero, link };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

ensureData();

app.get('/health', (req, res) => res.json({
  ok: true,
  service: 'infobip-extension-controller',
  time: new Date().toISOString(),
  command: command ? { id: command.id, status: command.status, createdAt: command.createdAt } : null,
  lastRun,
  lastUpload,
  jobs: (() => {
    const j = loadJobs();
    return { pending: j.pending.length, sent: j.sent.length };
  })()
}));

app.get('/api/config', (req, res) => {
  res.json({ ok: true, webhookConfigured: Boolean(WEBHOOK_URL) });
});

// Recebe do n8n a lista de itens {numero, link}. Deduplica contra já enviados/pendentes.
app.post('/api/jobs', auth, (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body) ? body : (body.items || body.jobs || body.data || []);
  if (!Array.isArray(items)) {
    return res.status(400).json({ ok: false, error: 'Body deve ser um array de {numero, link}.' });
  }

  const jobs = loadJobs();
  const normalized = items.map(normalizeJob).filter(Boolean);
  const addedItems = [];
  let skipped = 0;

  for (const item of normalized) {
    const exists =
      jobs.sent.some(s => s.numero === item.numero && s.link === item.link) ||
      jobs.pending.some(p => p.numero === item.numero && p.link === item.link);
    if (exists) {
      skipped++;
      continue;
    }
    jobs.pending.push({ ...item, at: new Date().toISOString() });
    addedItems.push(item);
  }

  saveJobs(jobs);
  res.json({ ok: true, added: addedItems.length, skipped, pending: jobs.pending.length, items: addedItems });
});

// Retorna os pendentes para a extensão consultar (formato que a extensão entende: {link, telefone})
app.get('/api/jobs', auth, (req, res) => {
  const jobs = loadJobs();
  res.json(jobs.pending.map(p => ({ link: p.link, telefone: p.numero })));
});

// Recebe o resultado da extensão (multipart), reenvia ao webhook do WhatsApp e
// marca como enviado se a resposta do webhook for {"status":"sucesso"}.
app.post('/api/result', auth, upload.any(), async (req, res) => {
  if (!WEBHOOK_URL) return res.status(500).json({ ok: false, error: 'WEBHOOK_URL não configurada.' });
  try {
    const telefone = String(req.body.telefone || '').replace(/\D/g, '');
    const link = String(req.body.link || '').trim();

    const form = new FormData();
    for (const key of Object.keys(req.body)) {
      if (key === 'telefone' || key === 'link') continue;
      form.append(key, req.body[key]);
    }
    form.append('telefone', telefone);
    form.append('link', link);
    if (req.files && req.files.length) {
      const file = req.files[0];
      form.append('screenshot', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'screenshot.png');
    }

    const response = await fetch(WEBHOOK_URL, { method: 'POST', body: form });
    const text = await response.text();
    let whatsappStatus = 'error';
    try {
      const parsed = JSON.parse(text);
      whatsappStatus = parsed.status || 'error';
    } catch (e) {}

    if (whatsappStatus === 'sucesso' && telefone && link) {
      const jobs = loadJobs();
      jobs.pending = jobs.pending.filter(p => !(p.numero === telefone && p.link === link));
      if (!jobs.sent.some(s => s.numero === telefone && s.link === link)) {
        jobs.sent.push({ numero: telefone, link, at: new Date().toISOString() });
      }
      saveJobs(jobs);
    }

    lastUpload = { ok: response.ok, status: response.status, whatsapp: whatsappStatus, at: new Date().toISOString() };
    res.status(response.status).send(text || JSON.stringify({ ok: response.ok }));
  } catch (error) {
    lastUpload = { ok: false, error: error.message, at: new Date().toISOString() };
    res.status(502).json({ ok: false, error: error.message });
  }
});

// Endpoints legados (extensão antiga de broadcast)
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