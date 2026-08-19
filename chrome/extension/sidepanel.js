const $ = id => document.getElementById(id);
const sendMsg = m => chrome.runtime.sendMessage(m);
let initialized = false;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderQueue(links, current) {
  const el = $('queue');
  if (!links || !links.length) {
    el.innerHTML = '<div class="empty">Fila vazia.</div>';
    return;
  }
  el.innerHTML = links.map(it => {
    const isCurrent = current && current.url === it.url && (current.phone || '') === (it.phone || '');
    const name = esc(it.name || 'relatorio');
    const phone = it.phone ? ' | ' + esc(it.phone) : '';
    const url = esc(String(it.url || '').replace(/^https?:\/\//, ''));
    return '<div class="qitem' + (isCurrent ? ' active' : '') + '">' +
      '<div class="qname">' + (isCurrent ? '\u25b6 ' : '') + name + phone + '</div>' +
      '<div class="qurl">' + url + '</div>' +
      '</div>';
  }).join('');
}

function fmtCountdown(ts, withHours) {
  if (!ts) return 'OFF';
  const total = Math.max(0, Math.floor((ts - Date.now()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = n => String(n).padStart(2, '0');
  return withHours ? p(h) + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
}

function renderTimers(resp) {
  const el = $('timers');
  const pollMin = (resp.n8n && resp.n8n.pollMin) || 5;
  const parts = [];
  parts.push('Timer 2h dispara em: ' + fmtCountdown(resp.nextRunTs, true) + (resp.timerOn ? ' (ON)' : ' (OFF)'));
  parts.push('Busca auto ' + pollMin + ' min dispara em: ' + fmtCountdown(resp.nextPollTs) + (resp.pollOn ? ' (ON)' : ' (OFF)'));
  if (resp.n8n && resp.n8n.lastPoll) parts.push('Última busca: ' + resp.n8n.lastPoll);
  if (resp.sentCount !== undefined) parts.push('Enviados/registrados: ' + resp.sentCount);
  el.innerText = parts.join('\n');
  $('pollToggleBtn').innerText = resp.pollOn ? 'Desativar Busca auto (' + pollMin + ' min)' : 'Ativar Busca auto (' + pollMin + ' min)';
}

function renderStandby(list) {
  const el = $('standby');
  if (!list || !list.length) {
    el.innerHTML = '<div class="empty">Nenhum item em espera.</div>';
    return;
  }
  el.innerHTML = list.map(s => {
    const when = new Date(s.updated).toLocaleString();
    return '<div class="qitem">' +
      '<div class="qname">' + esc(s.code || '') + ' | ' + esc(s.numero) + ' | tentativas: ' + (s.skips || 0) + '</div>' +
      '<div class="qurl">' + esc(s.name) + ' - ' + when + '</div>' +
      '</div>';
  }).join('');
}

async function refresh() {
  try {
    const resp = await sendMsg({ action: 'get_links' });
    if (!resp || !resp.ok) {
      $('status').innerText = 'Extensão não carregada / recarregar.';
      return;
    }
    $('status').innerText = resp.links.length + ' item(ns) na fila.' +
      (resp.timerOn ? ' | Timer 2h \u2713' : ' | Timer 2h OFF') +
      (resp.pollOn ? ' | Auto \u2713' : ' | Auto OFF');
    $('timerBtn').innerText = resp.timerOn ? 'Desativar Timer (2h)' : 'Ativar Timer (2h)';
    renderQueue(resp.links, resp.current);
    renderTimers(resp);
    renderStandby(resp.standby || []);
    if (resp.logs && resp.logs.length) {
      $('log').innerText = resp.logs.slice().reverse().join('\n');
    }
    if (!initialized && resp.n8n) {
      $('fetchUrl').value = resp.n8n.fetchUrl || '';
      $('postUrl').value = resp.n8n.postUrl || '';
      initialized = true;
    }
  } catch (e) {
    $('status').innerText = 'Sem resposta do background.';
  }
}

function printLog(text) {
  $('log').innerText = (text || '') + '\n' + $('log').innerText;
}

$('saveBtn').addEventListener('click', async () => {
  const links = $('links').value.split(/\r?\n/).map(l => l.trim()).filter(l => /^https?:\/\//i.test(l));
  try {
    const resp = await sendMsg({ action: 'save_links', links });
    $('status').innerText = resp && resp.ok ? links.length + ' link(s) salvos.' : 'Erro ao salvar.';
    $('links').value = '';
    refresh();
  } catch (e) {
    $('status').innerText = 'Erro ao salvar (recarregue a extensão).';
  }
});

$('runBtn').addEventListener('click', async () => {
  $('status').innerText = 'Iniciando agora...';
  try { await sendMsg({ action: 'run_now' }); } catch (e) {}
  setTimeout(refresh, 500);
});

$('pollNowBtn').addEventListener('click', async () => {
  $('status').innerText = 'Buscando pedidos no n8n...';
  try { await sendMsg({ action: 'run_poll' }); } catch (e) {}
  setTimeout(refresh, 800);
});

$('pollToggleBtn').addEventListener('click', async () => {
  try {
    const resp = await sendMsg({ action: 'toggle_poll' });
    $('status').innerText = resp && resp.ok ? (resp.pollOn ? 'Busca automática ativada.' : 'Busca automática desativada.') : 'Erro ao alternar busca.';
    refresh();
  } catch (e) {
    $('status').innerText = 'Erro ao alternar busca.';
  }
});

$('stopBtn').addEventListener('click', async () => {
  try {
    const resp = await sendMsg({ action: 'stop_all' });
    $('status').innerText = resp && resp.ok ? 'PARADO — fila e timers desativados.' : 'Erro ao parar.';
    refresh();
  } catch (e) {
    $('status').innerText = 'Erro ao parar.';
  }
});

$('resetBtn').addEventListener('click', async () => {
  try {
    const resp = await sendMsg({ action: 'reset_state' });
    $('status').innerText = resp && resp.ok ? 'Estado resetado.' : 'Erro ao resetar.';
    refresh();
  } catch (e) {
    $('status').innerText = 'Erro ao resetar.';
  }
});

$('timerBtn').addEventListener('click', async () => {
  try { await sendMsg({ action: 'toggle_timer' }); } catch (e) {}
  refresh();
});

$('testBtn').addEventListener('click', async () => {
  const line = $('testUrl').value.trim();
  const parts = line.split('|');
  const url = (parts[0] || '').trim();
  const phone = (parts.length > 1 ? parts[1] : '').trim();
  if (!/^https?:\/\//i.test(url)) {
    $('status').innerText = 'Informe uma URL válida para o teste (opcional: link | telefone).';
    return;
  }
  $('status').innerText = 'Testando fluxo do link único...';
  printLog('>> Iniciando TESTE do link: ' + url + (phone ? ' | tel ' + phone : ''));
  try {
    const resp = await sendMsg({ action: 'run_test', url, phone });
    if (resp && !resp.ok) $('status').innerText = resp.error || 'Teste não iniciado.';
  } catch (e) {
    $('status').innerText = 'Erro ao iniciar o teste.';
  }
});

$('saveN8nBtn').addEventListener('click', async () => {
  try {
    const resp = await sendMsg({
      action: 'save_n8n_config',
      fetchUrl: $('fetchUrl').value.trim(),
      postUrl: $('postUrl').value.trim(),
      token: 'samwell-midia',
      pollEnabled: true,
      pollMin: 5
    });
    $('status').innerText = resp && resp.ok ? 'n8n salvo.' : 'Erro ao salvar n8n.';
    refresh();
  } catch (e) {
    $('status').innerText = 'Erro ao salvar n8n.';
  }
});

chrome.runtime.onMessage.addListener(request => {
  if (request.action === 'log') {
    printLog(request.text);
  } else if (request.action === 'status_update') {
    $('status').innerText = request.message;
  }
});

refresh();
setInterval(refresh, 1000);