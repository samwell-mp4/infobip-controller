const CONTROLLER_URL = 'https://var-hub-infobip-controller.hx8235.easypanel.host';
const CONTROLLER_TOKEN = 'CHANGE_ME_API_TOKEN';

let state = {
  isScraping: false,
  isFinished: false,
  isPaused: false,
  dateFrom: null,
  dateTo: null,
  total: 0,
  processed: 0,
  errors: 0,
  message: '',
  data: [],
  pendingPreviews: [],
  currentTabId: null,
  currentCampaign: '',
  currentDelivered: 0,
  currentNotDelivered: 0,
  runId: null
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('controller-poll', { periodInMinutes: 0.5 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('controller-poll', { periodInMinutes: 0.5 });
});
chrome.alarms.create('controller-poll', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'controller-poll') await pollController();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_STATUS': sendResponse(state); break;
    case 'START_SCRAPING': startScraping(message.dateFrom, message.dateTo, message.runId); break;
    case 'PAUSE_SCRAPING': state.isPaused = true; broadcastStatus(); reportStatus(); break;
    case 'RESUME_SCRAPING': state.isPaused = false; broadcastStatus(); reportStatus(); processNextPreview(); break;
    case 'STOP_SCRAPING': stopScraping(); break;
    case 'LIST_DATA_RECEIVED': handleListData(message.payload); break;
    case 'DETAIL_DATA_RECEIVED': handleDetailData(message.payload); break;
    case 'EXPORT_DATA': exportToCSV(); break;
    case 'CLEAR_DATA': clearData(sendResponse); return true;
  }
});

async function controllerFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('x-api-token', CONTROLLER_TOKEN);
  return fetch(`${CONTROLLER_URL}${path}`, { ...options, headers });
}

async function pollController() {
  try {
    const response = await controllerFetch('/api/command');
    if (!response.ok) return;
    const result = await response.json();
    const command = result.command;
    if (!command || command.status !== 'pending') return;

    await controllerFetch('/api/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: command.id, status: 'received' })
    });

    if (command.type === 'START_SCRAPING') {
      await startScraping(command.dateFrom, command.dateTo, command.jobId || command.id);
    }
  } catch (error) {
    console.warn('Controller indisponível:', error.message);
  }
}

async function startScraping(dateFrom, dateTo, runId = crypto.randomUUID()) {
  if (state.isScraping) return;

  state = {
    isScraping: true,
    isFinished: false,
    isPaused: false,
    dateFrom,
    dateTo,
    total: 0,
    processed: 0,
    errors: 0,
    message: 'Iniciando listagem...',
    data: [],
    pendingPreviews: [],
    currentTabId: null,
    currentCampaign: 'Listando campanhas...',
    currentDelivered: 0,
    currentNotDelivered: 0,
    runId
  };

  await reportStatus();

  const url = `https://portal-ny2.infobip.com/broadcast?status=FINISHED&page=1&dateProperty=CREATED&dateFrom=${dateFrom}&dateTo=${dateTo}&size=50`;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let target = tabs[0];

  if (!target || !target.url?.includes('portal-ny2.infobip.com')) {
    const created = await chrome.tabs.create({ url });
    target = created;
  } else {
    await chrome.tabs.update(target.id, { url });
  }

  state.currentTabId = target.id;
  broadcastStatus();
}

async function stopScraping() {
  state.isScraping = false;
  state.isFinished = true;
  state.message = 'Coleta interrompida pelo usuário.';
  broadcastStatus();
  await saveToStorage();
  await reportStatus();
  setTimeout(() => exportToCSV(), 1000);
}

function handleListData(items) {
  if (!state.isScraping) return;
  state.total = items.length;
  state.pendingPreviews = items;
  state.message = `Encontradas ${items.length} transmissões. Iniciando coleta...`;
  broadcastStatus();
  reportStatus();
  processNextPreview();
}

async function processNextPreview() {
  if (!state.isScraping || state.isPaused) return;

  if (state.pendingPreviews.length === 0) {
    state.isScraping = false;
    state.isFinished = true;
    state.message = 'Coleta concluída com sucesso!';
    state.currentCampaign = 'Concluído';
    broadcastStatus();
    await saveToStorage();
    await sendFinalCSV();
    await reportStatus();
    return;
  }

  const nextItem = state.pendingPreviews.shift();
  state.currentCampaign = nextItem.name || 'Sem nome';
  state.currentDelivered = parseInt(nextItem.delivered) || 0;
  const sent = parseInt(nextItem.sent) || 0;
  const delivered = parseInt(nextItem.delivered) || 0;
  state.currentNotDelivered = Math.max(0, sent - delivered);
  state.message = `Processando: ${state.currentCampaign}`;
  state.currentItemSummary = nextItem;
  broadcastStatus();
  await reportStatus();

  if (nextItem.previewUrl) {
    await chrome.tabs.update(state.currentTabId, { url: nextItem.previewUrl });
  } else {
    state.errors++;
    state.processed++;
    processNextPreview();
  }
}

async function handleDetailData(details) {
  if (!state.isScraping) return;

  let imageBlob = null;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    imageBlob = dataUrlToBlob(dataUrl);
  } catch (err) {
    console.error('Falha ao capturar screenshot:', err);
  }

  const combinedItem = {
    ...state.currentItemSummary,
    ...details,
    scrapedAt: new Date().toISOString()
  };

  state.data.push(combinedItem);
  state.processed++;
  broadcastStatus();
  await reportStatus();

  if (imageBlob) {
    await sendCampaignReport(combinedItem, imageBlob);
  }

  if (!state.isPaused) setTimeout(processNextPreview, 2000);
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(meta)?.[1] || 'image/png';
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function sendCampaignReport(item, imageBlob) {
  try {
    const form = new FormData();
    form.append('type', 'campaign');
    form.append('runId', state.runId || '');
    form.append('campaign', item.name || 'Sem nome');
    form.append('data', JSON.stringify(item));
    const safeName = String(item.name || 'campanha').replace(/[/\\?%*:|"<>]/g, '-');
    form.append('image', imageBlob, `${safeName}.png`);

    const response = await controllerFetch('/api/report', { method: 'POST', body: form });
    if (!response.ok) console.warn('Falha ao enviar campanha ao N8N:', await response.text());
  } catch (error) {
    console.error('Erro no envio da campanha:', error);
  }
}

async function sendFinalCSV() {
  try {
    const csv = buildCSV(state.data);
    const form = new FormData();
    form.append('type', 'final');
    form.append('runId', state.runId || '');
    form.append('dateFrom', String(state.dateFrom || ''));
    form.append('dateTo', String(state.dateTo || ''));
    form.append('count', String(state.data.length));
    form.append('data', JSON.stringify(state.data));
    form.append('excel', new Blob([csv], { type: 'text/csv;charset=utf-8' }), `infobip-report-${Date.now()}.csv`);

    const response = await controllerFetch('/api/report', { method: 'POST', body: form });
    if (!response.ok) console.warn('Falha ao enviar CSV ao N8N:', await response.text());
  } catch (error) {
    console.error('Erro no envio do CSV:', error);
  }
}

function buildCSV(data) {
  const headers = ['Nome','Status','Enviadas','Pendentes','Entregues','Taxa de Entrega','Remetente','Destinatários','Total de Destinos','Destinos Possíveis','Ignoradas','Link Preview'];
  let csv = '\uFEFF' + headers.join(',') + '\n';
  for (const item of data) {
    const row = [item.name,item.status,item.sent,item.pending,item.delivered,item.deliveryRate,item.sender,item.recipients,item.totalDestinations,item.possibleDestinations,item.ignored,item.previewUrl];
    csv += row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',') + '\n';
  }
  return csv;
}

async function saveToStorage() {
  const existing = await chrome.storage.local.get('scrapedData');
  const allData = [...(existing.scrapedData || []), ...state.data];
  await chrome.storage.local.set({ scrapedData: allData });
}

function clearData(callback) {
  chrome.storage.local.remove('scrapedData', () => {
    state.data = [];
    state.processed = 0;
    state.total = 0;
    state.isFinished = false;
    state.isPaused = false;
    state.currentCampaign = '';
    state.currentDelivered = 0;
    state.currentNotDelivered = 0;
    callback && callback();
  });
}

function exportToCSV() {
  chrome.storage.local.get('scrapedData', (result) => {
    const data = result.scrapedData || [];
    if (!data.length) return;
    const csvContent = buildCSV(data);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const reader = new FileReader();
    reader.onload = function(e) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      chrome.downloads.download({ url: e.target.result, filename: `infobip-report-${timestamp}.csv`, saveAs: true });
    };
    reader.readAsDataURL(blob);
  });
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', payload: state }).catch(() => {});
}

async function reportStatus() {
  try {
    await controllerFetch('/api/run-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: state.runId,
        isScraping: state.isScraping,
        isFinished: state.isFinished,
        isPaused: state.isPaused,
        total: state.total,
        processed: state.processed,
        errors: state.errors,
        message: state.message,
        currentCampaign: state.currentCampaign
      })
    });
  } catch (_) {}
}
