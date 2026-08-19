// ============================================================
// Infobip Report Automator - Background Service Worker
// Funcionalidades:
// 1) Fila de links salvos (manual) processada na hora ou via timer de 2h
// 2) Modo teste (URL única sempre com print)
// 3) Integração n8n: busca pedidos pendentes (link + telefone) via
//    Webhook GET, processa cada um e envia o resultado (screenshot +
//    status + telefone) para o Webhook POST (que dispara o WhatsApp).
// ============================================================

const STORAGE_KEY = 'infobip_links';
const ALARM_NAME = 'every2h';
const POLL_ALARM = 'poll_n8n';
const WATCHDOG_ALARM = 'ib_watchdog';
const PROC_WATCHDOG_MS = 10 * 60 * 1000;

let processing = false;
let keepAliveId = null;
let currentShotDataUrl = null;

// ---------- helpers de estado (storage.session sobrevive ao encerramento do SW) ----------

function sGet(key, def) {
  return new Promise(resolve => {
    chrome.storage.session.get(key, d => resolve(d[key] !== undefined ? d[key] : def));
  });
}

function sSet(key, val) {
  return chrome.storage.session.set({ [key]: val });
}

function getN8nConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get({
      ib_fetch_url: 'https://plug-sales-dispatch-app-n8n-2.hx8235.easypanel.host/webhook/71e418e2-0e0d-49c1-a49b-71c929688454',
      ib_post_url: 'https://plug-sales-dispatch-app-n8n-2.hx8235.easypanel.host/webhook/notifcation-whatsapp-relatorio',
      ib_token: 'samwell-midia',
      ib_poll_enabled: true,
      ib_poll_min: 5,
      ib_last_poll: ''
    }, resolve);
  });
}

function log(text) {
  console.log('[Infobip]', text);
  try {
    const entry = `${brClock(new Date())} - ${text}`;
    chrome.storage.local.get({ ib_status: 'Nenhuma execução ainda.', ib_logs: [] }, d => {
      const logs = (d.ib_logs || []).concat(entry).slice(-30);
      chrome.storage.local.set({ ib_status: entry, ib_logs: logs });
    });
  } catch (e) {}
  try {
    chrome.runtime.sendMessage({ action: 'log', text }).catch(() => {});
  } catch (e) {}
}

function showNotify(message) {
  try {
    chrome.notifications.create('ib-notify', {
      type: 'basic',
      title: 'Infobip Automator',
      message
    });
  } catch (e) {
    log(message);
  }
}

function getQueue() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY, data => resolve(data[STORAGE_KEY] || []));
  });
}

function setQueue(queue) {
  return new Promise(resolve => chrome.storage.local.set({ [STORAGE_KEY]: queue }, resolve));
}

function getAlarm(name) {
  return new Promise(resolve => chrome.alarms.get(name, a => resolve(a || null)));
}

// ---------- Registro (banco de dados) anti-duplicado ----------
// Chave = numero|url. Cada item tem um "código/etiqueta" (IB-XXXX) para identificação.

const REGISTRY_KEY = 'ib_registry';

function jobKey(numero, url) {
  return `${String(numero || '')}|${String(url || '')}`;
}

function getRegistry() {
  return new Promise(resolve => {
    chrome.storage.local.get(REGISTRY_KEY, d => resolve(d[REGISTRY_KEY] || {}));
  });
}

function setRegistry(reg) {
  return chrome.storage.local.set({ [REGISTRY_KEY]: reg });
}

async function registryMark(item, state) {
  const reg = await getRegistry();
  const key = jobKey(item.phone, item.url);
  const existing = reg[key];
  reg[key] = {
    key,
    numero: item.phone || '',
    url: item.url || '',
    name: item.name || '',
    code: existing ? existing.code : 'IB-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    state,
    created: existing ? existing.created : Date.now(),
    updated: Date.now(),
    skips: existing ? existing.skips + (state === 'standby' ? 1 : 0) : (state === 'standby' ? 1 : 0)
  };
  await setRegistry(reg);
  return reg[key];
}

async function standbyItems() {
  const reg = await getRegistry();
  return Object.values(reg).filter(r => r.state === 'standby');
}

function safeName(s) {
  const clean = String(s || '').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 60);
  return clean || 'relatorio';
}

// Aceita "https://link" ou "https://link | 5511999999999"
function parseLinkWithPhone(text) {
  const parts = String(text).split('|');
  const url = (parts[0] || '').trim();
  const phone = parts.length > 1 ? (parts[1] || '').trim() : '';
  if (!/^https?:\/\//i.test(url)) return null;
  const m = url.match(/\/([^/?]+)\/?(\?|$)/);
  const name = m ? decodeURIComponent(m[1]) : url;
  return { url, phone, name };
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Horários em Brasília (SP, Brasil)
function brTime(date) {
  return new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function brClock(date) {
  return new Date(date).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

// Mantém o service worker acordado enquanto houver processamento
function startKeepAlive() {
  stopKeepAlive();
  keepAliveId = setInterval(async () => {
    try { await chrome.runtime.getPlatformInfo(); } catch (e) {}
  }, 15000);
}

function stopKeepAlive() {
  if (keepAliveId) {
    clearInterval(keepAliveId);
    keepAliveId = null;
  }
}

async function setBusy(busy) {
  await sSet('processing', busy);
  processing = busy;
  if (!busy) {
    stopKeepAlive();
    currentShotDataUrl = null;
  }
}

async function heartbeat() {
  await sSet('ib_proc_beat', Date.now());
}

async function watchdogTick() {
  const busy = await sGet('processing', false);
  if (!busy) return;
  const last = await sGet('ib_proc_beat', 0);
  const now = Date.now();
  if (!last) {
    await sSet('ib_proc_beat', now);
    return;
  }
  if (now - last > PROC_WATCHDOG_MS) {
    await sSet('processing', false);
    processing = false;
    await sSet('test_mode', false);
    await sSet('ib_current', null);
    stopKeepAlive();
    log('Processamento travado detectado — estado resetado automaticamente.');
  }
}

// ---------------- Timers ----------------

function ensureTimer() {
  chrome.alarms.get(ALARM_NAME, alarm => {
    if (!alarm) {
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: 120, periodInMinutes: 120 });
    }
  });
}

async function ensurePollAlarm() {
  await chrome.alarms.clear(POLL_ALARM);
  const cfg = await getN8nConfig();
  if (cfg.ib_poll_enabled && cfg.ib_fetch_url) {
    const min = Math.max(1, parseInt(cfg.ib_poll_min, 10) || 5);
    chrome.alarms.create(POLL_ALARM, { delayInMinutes: min, periodInMinutes: min });
  }
}

function setupSidePanel() {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {}
}

function ensureWatchdogAlarm() {
  chrome.alarms.get(WATCHDOG_ALARM, a => {
    if (!a) chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureTimer();
  ensurePollAlarm();
  ensureWatchdogAlarm();
  setupSidePanel();
});
chrome.runtime.onStartup.addListener(() => {
  ensureTimer();
  ensurePollAlarm();
  ensureWatchdogAlarm();
  setupSidePanel();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM_NAME) {
    log('Timer de 2h disparado.');
    runN8nPoll();
    startProcessing('timer');
  } else if (alarm.name === POLL_ALARM) {
    runN8nPoll();
  } else if (alarm.name === WATCHDOG_ALARM) {
    watchdogTick();
  }
});

// ---------------- Fila de processamento (pipeline único) ----------------

async function startProcessing(source) {
  const busy = await sGet('processing', false);
  if (busy) {
    log(`(${source}) Já existe um processamento em andamento.`);
    return;
  }
  await setBusy(true);
  startKeepAlive();
  await sSet('stopped', false);
  await sSet('ib_proc_start', Date.now());
  await sSet('ib_proc_beat', Date.now());

  const links = await getQueue();
  if (!links.length) {
    await setBusy(false);
    log('Nenhum link na fila.');
    return;
  }

  log(`Iniciando processamento (${source}). ${links.length} item(ns) na fila.`);
  if (source !== 'n8n') showNotify(`Iniciando processamento de ${links.length} item(ns)...`);
  processNext();
}

async function openTabAndInject(url, name, isTest) {
  // Em modo teste, marca a URL para o content.js saber (sem depender de estado)
  let finalUrl = url;
  if (isTest) {
    finalUrl = url.split('#')[0] + '#ibtest';
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url: finalUrl, active: true });
  } catch (e) {
    log('Falha ao abrir aba: ' + e);
    return false;
  }

  await waitForTabLoad(tab.id, 45000);

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    log('Script injetado na página.');
    return true;
  } catch (e) {
    log('Falha ao injetar script: ' + e);
    showNotify('Falha ao injetar o script na página: ' + String(e).slice(0, 120));
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    return false;
  }
}

// Polling com chamadas de API em voo mantém o service worker vivo
async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === 'complete') return true;
    } catch (e) {
      return false;
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  return false;
}

function processNext() {
  getQueue().then(async queue => {
    if (await sGet('stopped', false)) {
      await setBusy(false);
      await sSet('stopped', false);
      log('PARADO — fila cancelada.');
      return;
    }
    if (!queue.length) {
      await setBusy(false);
      log('Todos os itens foram processados.');
      showNotify('Processamento concluído!');
      return;
    }

    const item = queue.shift();
    await setQueue(queue);
    await sSet('ib_current', item);
    await sSet('ib_status', 'gerado');
    await heartbeat();
    await sSet('ib_count', '');
    log(`Processando: ${item.name} (restam ${queue.length})`);

    const ok = await openTabAndInject(item.url, item.name, false);
    if (!ok) {
      finishItem(item);
      processNext();
    }
  });
}

function finishItem(item) {
  // limpa referência do item atual (a postagem é feita no close_tab_and_next)
  sSet('ib_current', null);
  sSet('ib_status', 'gerado');
  sSet('ib_count', '');
  currentShotDataUrl = null;
}

// ---------------- Integração n8n ----------------

function normalizeJob(j) {
  let url = j.link || j.url || j.Url || j.Link;
  if (!url) {
    for (const k of Object.keys(j)) {
      if (/^https?:\/\//i.test(String(j[k]))) {
        url = j[k];
        break;
      }
    }
  }
  const phone = String(j.numero || j.telefone || j.phone || j.celular || j.whatsapp || j.Phone || '').trim();
  const jobId = j.id !== undefined && j.id !== null ? j.id : (j.ID !== undefined ? j.ID : null);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const m = url.match(/\/([^/?]+)\/?(\?|$)/);
  const base = m ? decodeURIComponent(m[1]).slice(0, 40) : 'pedido';
  const name = `n8n_${base}${phone ? '_' + phone : ''}`;
  return { url, phone, jobId, name };
}

async function enqueueN8nJobs(items) {
  const queue = await getQueue();
  const reg = await getRegistry();
  const existing = new Set(queue.map(q => q.url + '|' + q.phone));
  const fresh = items.filter(i => {
    if (existing.has(i.url + '|' + i.phone)) return false;
    return !reg[jobKey(i.phone, i.url)];
  });
  if (!fresh.length) {
    log('Nenhum pedido novo (já estão na fila, em standby ou já processados).');
    return;
  }
  await setQueue(queue.concat(fresh));
  log(`${fresh.length} pedido(s) novo(s) adicionado(s) à fila.`);
  startProcessing('n8n');
}

// Re-adiciona à fila os itens em STANDBY (Pendentes > 0) para reconsultar até Pendentes = 0
async function requeueStandby() {
  const standby = await standbyItems();
  if (!standby.length) return;
  const queue = await getQueue();
  const inQueue = new Set(queue.map(q => q.url + '|' + q.phone));
  const toAdd = standby.filter(s => !inQueue.has(s.url + '|' + s.numero))
    .map(s => ({ url: s.url, phone: s.numero, name: s.name, jobId: null, code: s.code }));
  if (!toAdd.length) return;
  await setQueue(queue.concat(toAdd));
  log(`${toAdd.length} item(ns) em STANDBY re-adicionado(s) para reconsulta (até Pendentes = 0).`);
  startProcessing('standby');
}

async function runN8nPoll() {
  const cfg = await getN8nConfig();
  if (!cfg.ib_fetch_url || !/^https?:\/\//i.test(cfg.ib_fetch_url)) {
    log('URL de busca de pedidos do n8n não configurada.');
    return;
  }
  try {
    log('Buscando pedidos pendentes no n8n...');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.ib_token) headers['x-api-token'] = cfg.ib_token;
    const resp = await fetch(cfg.ib_fetch_url, { method: 'POST', headers, body: '{}' });
    if (!resp.ok) {
      log('Falha ao buscar pedidos do n8n: HTTP ' + resp.status);
      return;
    }
    const data = await resp.json();
    let jobs = Array.isArray(data) ? data : (data.jobs || data.data || data.pedidos || []);
    const items = (Array.isArray(jobs) ? jobs : []).map(normalizeJob).filter(Boolean);
    const cfg2 = await getN8nConfig();
    const stamp = `${brClock(new Date())} - ${items.length} pedido(s)`;
    await chrome.storage.local.set({
      ib_last_poll: items.length ? stamp : `${brClock(new Date())} - 0 pedidos`
    });
    if (!items.length) {
      log('Nenhum pedido pendente no n8n.');
    } else {
      log(`${items.length} pedido(s) novo(s) encontrado(s).`);
      await enqueueN8nJobs(items);
    }
    await requeueStandby();
  } catch (e) {
    log('Erro ao buscar pedidos do n8n: ' + e);
  }
}

async function postResultToN8n(item) {
  const cfg = await getN8nConfig();
  if (!cfg.ib_post_url || !/^https?:\/\//i.test(cfg.ib_post_url)) {
    log('URL de envio de resultado do n8n não configurada.');
    return;
  }
  const status = (await sGet('ib_status', 'gerado')) === 'pulado' ? 'pulado' : 'gerado';
  const detalhe = await sGet('ib_count', '');

  try {
    const form = new FormData();
    form.append('telefone', item.phone || '');
    form.append('link', item.url || '');
    form.append('nome', item.name || 'relatorio');
    form.append('status', status);
    form.append('detalhe', String(detalhe || (status === 'gerado' ? 'relatório gerado' : '')));
    if (item.jobId !== undefined && item.jobId !== null) {
      form.append('processo_id', String(item.jobId));
    }
    if (status === 'gerado' && currentShotDataUrl) {
      try {
        const blob = await (await fetch(currentShotDataUrl)).blob();
        form.append('screenshot', blob, 'screenshot.png');
      } catch (e) {}
    }

    const resp = await fetch(cfg.ib_post_url, {
      method: 'POST',
      headers: cfg.ib_token ? { 'x-api-token': cfg.ib_token } : {},
      body: form
    });
    const respText = await resp.text().catch(() => '');
    log(`POST ao webhook: HTTP ${resp.status}${item.phone ? ' -> tel ' + item.phone : ''} (${status})`);
    if (!respText) {
      log('webhook respondeu vazio (ok).');
    } else {
      log('Resposta do webhook: ' + respText.slice(0, 200));
    }
    if (resp.ok) {
      const rec = await registryMark(item, 'sent');
      log(`[ENVIADO] ${item.name}${item.phone ? ' - ' + item.phone : ''} (${rec.code}).`);
    } else {
      const rec = await registryMark(item, 'standby');
      log(`[FALHOU ENVIO] ${item.name} mantido em standby (${rec.code}).`);
    }
    showNotify(`n8n: ${resp.ok ? 'enviado' : 'FALHOU'} (${status}${item.phone ? ' - ' + item.phone : ''})`);
  } catch (e) {
    log('Falha ao enviar resultado ao n8n: ' + e);
  }
  currentShotDataUrl = null;
}

// ---------------- Mensagens ----------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      switch (request.action) {

        case 'save_links': {
          const links = [];
          for (const raw of request.links || []) {
            const item = typeof raw === 'string'
              ? parseLinkWithPhone(raw)
              : raw;
            if (item && item.url) links.push(item);
          }
          await setQueue(links);
          ensureTimer();
          log(`${links.length} link(s) salvos.`);
          sendResponse({ ok: true, count: links.length });
          return;
        }

        case 'get_links': {
          const links = await getQueue();
          const current = await sGet('ib_current', null);
          const alarm = await getAlarm(ALARM_NAME);
          const pollAlarm = await getAlarm(POLL_ALARM);
          const cfg = await getN8nConfig();
          const local = await new Promise(res =>
            chrome.storage.local.get(['ib_status', 'ib_logs'], res)
          );
          const reg = await getRegistry();
          const standby = Object.values(reg).filter(r => r.state === 'standby').sort((a, b) => b.updated - a.updated).slice(0, 50);
          const sentCount = Object.values(reg).filter(r => r.state === 'sent').length;
          sendResponse({
            ok: true,
            links,
            current,
            timerOn: !!alarm,
            nextRun: alarm ? brTime(alarm.scheduledTime) : null,
            nextRunTs: alarm ? alarm.scheduledTime : null,
            pollOn: !!pollAlarm,
            nextPoll: pollAlarm ? brTime(pollAlarm.scheduledTime) : null,
            nextPollTs: pollAlarm ? pollAlarm.scheduledTime : null,
            standby,
            sentCount,
            lastStatus: local.ib_status || null,
            logs: local.ib_logs || [],
            n8n: {
              fetchUrl: cfg.ib_fetch_url,
              postUrl: cfg.ib_post_url,
              token: cfg.ib_token,
              pollEnabled: cfg.ib_poll_enabled,
              pollMin: cfg.ib_poll_min,
              lastPoll: cfg.ib_last_poll
            }
          });
          return;
        }

        case 'run_now': {
          sendResponse({ ok: true });
          startProcessing('manual');
          return;
        }

        // Executa o fluxo completo em UM único link (modo teste)
        case 'run_test': {
          const testUrl = request.url;
          if (!testUrl || !/^https?:\/\//i.test(testUrl)) {
            sendResponse({ ok: false, error: 'URL inválida para o teste' });
            return;
          }
          const busy = await sGet('processing', false);
          const wasTest = await sGet('test_mode', false);
          if (busy && !wasTest) {
            sendResponse({ ok: false, error: 'Já existe um processamento em andamento.' });
            return;
          }
          const testPhone = (request.phone || '').trim();
          await sSet('ib_current', { url: testUrl, phone: testPhone, name: 'TESTE' });
          await sSet('test_mode', true);
          await setBusy(true);
          startKeepAlive();
          await sSet('stopped', false);
          await sSet('ib_proc_start', Date.now());
          await sSet('ib_proc_beat', Date.now());
          log(`=== MODO TESTE === ${testUrl}${testPhone ? ' | tel ' + testPhone : ''}`);
          showNotify('Iniciando teste do link...');

          const ok = await openTabAndInject(testUrl, 'TESTE', true);
          if (!ok) {
            await sSet('test_mode', false);
            await setBusy(false);
            log('Falha ao iniciar o teste.');
          }
          sendResponse({ ok: true });
          return;
        }

        case 'get_test_mode': {
          const isTest = await sGet('test_mode', false);
          sendResponse({ ok: true, testMode: !!isTest });
          return;
        }

        case 'toggle_timer': {
          const alarm = await getAlarm(ALARM_NAME);
          if (alarm) {
            await chrome.alarms.clear(ALARM_NAME);
            log('Timer desativado.');
          } else {
            chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.2, periodInMinutes: 120 });
            log('Timer ativado (a cada 2 horas).');
          }
          sendResponse({ ok: true });
          return;
        }

        case 'toggle_poll': {
          const pollAlarm = await getAlarm(POLL_ALARM);
          if (pollAlarm) {
            await chrome.alarms.clear(POLL_ALARM);
            await chrome.storage.local.set({ ib_poll_enabled: false });
            log('Busca automática DESATIVADA.');
            sendResponse({ ok: true, pollOn: false });
          } else {
            const cfg = await getN8nConfig();
            const min = Math.max(1, parseInt(cfg.ib_poll_min, 10) || 5);
            chrome.alarms.create(POLL_ALARM, { delayInMinutes: min, periodInMinutes: min });
            await chrome.storage.local.set({ ib_poll_enabled: true });
            log(`Busca automática ATIVADA (a cada ${min} min).`);
            sendResponse({ ok: true, pollOn: true });
          }
          return;
        }

        case 'save_n8n_config': {
          await chrome.storage.local.set({
            ib_fetch_url: (request.fetchUrl || '').trim(),
            ib_post_url: (request.postUrl || '').trim(),
            ib_token: (request.token || '').trim(),
            ib_poll_enabled: !!request.pollEnabled,
            ib_poll_min: parseInt(request.pollMin, 10) || 5
          });
          await ensurePollAlarm();
          const cfg = await getN8nConfig();
          const pollState = cfg.ib_poll_enabled ? `busca automática a cada ${cfg.ib_poll_min} min` : 'busca automática desativada';
          log(`n8n configurado (buscar: ${cfg.ib_fetch_url ? 'ok' : 'vazio'} | enviar: ${cfg.ib_post_url ? 'ok' : 'vazio'} | ${pollState}).`);
          sendResponse({ ok: true });
          return;
        }

        case 'run_poll': {
          sendResponse({ ok: true });
          runN8nPoll();
          return;
        }

        case 'log': {
          log(request.text || '');
          sendResponse({ ok: true });
          return;
        }

        // Captura o viewport atual da aba (chamado pelo content.js durante o scroll)
        case 'capture_viewport': {
          await heartbeat();
          if (!sender.tab) {
            sendResponse({ ok: false, error: 'sem aba' });
            return;
          }
          try {
            await chrome.tabs.update(sender.tab.id, { active: true });
            await chrome.windows.update(sender.tab.windowId, { focused: true });
            let dataUrl;
            try {
              dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
            } catch (e) {
              dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
            }
            sendResponse({ ok: true, dataUrl });
          } catch (e) {
            sendResponse({ ok: false, error: String(e) });
          }
          return;
        }

        case 'save_screenshot': {
          await heartbeat();
          const filename = `disparo/infobip_${safeName(request.name)}_${timestamp()}.png`;
          try {
            let blobUrl = null;
            try {
              const blob = await (await fetch(request.dataUrl)).blob();
              blobUrl = URL.createObjectURL(blob);
            } catch (e) {}
            const downloadId = await chrome.downloads.download({
              url: blobUrl || request.dataUrl,
              filename,
              saveAs: false,
              conflictAction: 'uniquify'
            });
            if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);

            // Guarda para envio ao n8n (e descobre o caminho salvo)
            currentShotDataUrl = request.dataUrl;
            try {
              const items = await chrome.downloads.search({ id: downloadId });
              if (items && items[0]) {
                log(`Screenshot salvo em: ${items[0].filename}`);
              } else {
                log(`Screenshot salvo: ${filename}`);
              }
            } catch (e) {
              log(`Screenshot salvo: ${filename}`);
            }
          } catch (e) {
            log('Falha ao salvar screenshot: ' + e);
          }
          sendResponse({ ok: true });
          return;
        }

        case 'report_skipped': {
          await sSet('ib_status', 'pulado');
          await sSet('ib_count', (request.count ?? '').toString());
          const name = request.name || '?';
          const count = request.count ?? '?';
          const item = await sGet('ib_current', null);
          let rec = null;
          if (item && item.url) {
            rec = await registryMark(item, 'standby');
            log(`[STANDBY] ${name}: Pendentes = ${count}. Em espera (${rec.code}). Reconsultado até Pendentes = 0.`);
          } else {
            log(`[PULADO] ${name}: Pendentes = ${count} (diferente de 0). Relatório NÃO gerado.`);
          }
          const isTestNow = await sGet('test_mode', false);
          if (isTestNow) {
            showNotify(`Teste: ${name} pendente = ${count}${rec ? ' (' + rec.code + ')' : ''}.`);
          }
          sendResponse({ ok: true });
          return;
        }

        case 'close_tab_and_next': {
          await heartbeat();
          if (sender.tab) {
            try { await chrome.tabs.remove(sender.tab.id); } catch (e) {}
          }
          if (await sGet('stopped', false)) {
            await setBusy(false);
            await sSet('stopped', false);
            await sSet('ib_current', null);
            log('PARADO — item cancelado, nada enviado.');
            sendResponse({ ok: true });
            return;
          }

          const item = await sGet('ib_current', null);
          const wasTest = await sGet('test_mode', false);

          // Se houver telefone, envia o resultado ao webhook do n8n
          if (item && item.phone) {
            await postResultToN8n(item);
          } else if (item) {
            const status = await sGet('ib_status', 'gerado');
            if (status === 'pulado') {
              log('Item pulado (sem telefone) - nada enviado ao webhook.');
            } else {
              const rec = await registryMark(item, 'sent');
              log(`Relatório gerado SEM TELEFONE - marcado (${rec.code}) para não repetir.`);
            }
          } else {
            log('Sem item para registrar.');
          }

          if (wasTest) {
            await sSet('test_mode', false);
            await setBusy(false);
            log('Teste concluído.');
            showNotify('Teste concluído!');
            sendResponse({ ok: true });
            return;
          }

          finishItem(item);
          processNext();
          sendResponse({ ok: true });
          return;
        }

        case 'stop_all': {
          await setBusy(false);
          await sSet('test_mode', false);
          await sSet('stopped', true);
          await sSet('ib_current', null);
          await sSet('ib_status', 'PARADO pelo usuário.');
          await sSet('ib_count', '');
          await sSet('ib_proc_beat', 0);
          await setQueue([]);
          await chrome.alarms.clear(ALARM_NAME);
          await chrome.alarms.clear(POLL_ALARM);
          log('PARADO — processamento cancelado, fila limpa e timers (2h/5min) desativados.');
          showNotify('Infobip Automator PARADO.');
          sendResponse({ ok: true });
          return;
        }

        case 'reset_state': {
          await setBusy(false);
          await sSet('test_mode', false);
          await sSet('stopped', false);
          await sSet('ib_current', null);
          await sSet('ib_status', 'Estado resetado.');
          await sSet('ib_count', '');
          await sSet('ib_proc_beat', 0);
          log('Estado resetado pelo usuário.');
          sendResponse({ ok: true });
          return;
        }

        default:
          sendResponse({ ok: false, error: 'ação desconhecida' });
      }
    } catch (e) {
      log('Erro no handler: ' + e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // resposta assíncrona
});