const $ = id => document.getElementById(id);

function cleanLinks(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^https?:\/\//i.test(line));
}

function sendMsg(message) {
  return chrome.runtime.sendMessage(message);
}

function printLog(text) {
  const el = $('log');
  el.innerText = (text || '') + '\n' + el.innerText;
  el.scrollTop = 0;
}

$('saveBtn').addEventListener('click', async () => {
  const links = cleanLinks($('links').value);
  try {
    const resp = await sendMsg({ action: 'save_links', links });
    $('status').innerText = resp && resp.ok ? `${links.length} link(s) salvos.` : 'Erro ao salvar.';
  } catch (e) {
    $('status').innerText = 'Erro ao salvar (recarregue a extensão).';
  }
});

$('runBtn').addEventListener('click', async () => {
  $('status').innerText = 'Iniciando agora...';
  try { await sendMsg({ action: 'run_now' }); } catch (e) {}
});

$('timerBtn').addEventListener('click', async () => {
  try { await sendMsg({ action: 'toggle_timer' }); } catch (e) {}
  refreshStatus();
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
    if (resp && !resp.ok) {
      $('status').innerText = resp.error || 'Teste não iniciado.';
    }
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
      token: $('token').value.trim(),
      pollEnabled: $('pollEnabled').checked,
      pollMin: $('pollMin').value
    });
    $('n8nStatus').innerText = resp && resp.ok ? 'n8n salvo.' : 'Erro ao salvar n8n.';
    refreshStatus();
  } catch (e) {
    $('n8nStatus').innerText = 'Erro ao salvar n8n.';
  }
});

$('pollNowBtn').addEventListener('click', async () => {
  $('n8nStatus').innerText = 'Buscando pedidos no n8n...';
  try { await sendMsg({ action: 'run_poll' }); } catch (e) {}
});

async function refreshStatus() {
  try {
    const resp = await sendMsg({ action: 'get_links' });
    if (!resp || !resp.ok) {
      $('status').innerText = 'Extensão não carregada / recarregar.';
      return;
    }
    const parts = [resp.links.length + ' item(ns) na fila.'];
    if (resp.timerOn) {
      parts.push('Timer 2h ✓');
    } else {
      parts.push('Timer off');
    }
    $('status').innerText = parts.join(' ');
    $('timerBtn').innerText = resp.timerOn ? 'Desativar Timer (2h)' : 'Ativar Timer (2h)';

    if (resp.logs && resp.logs.length) {
      $('log').innerText = resp.logs.slice().reverse().join('\n');
    } else if (resp.lastStatus) {
      $('log').innerText = resp.lastStatus;
    }

    if (resp.n8n) {
      $('fetchUrl').value = resp.n8n.fetchUrl || '';
      $('postUrl').value = resp.n8n.postUrl || '';
      $('token').value = resp.n8n.token || '';
      $('pollEnabled').checked = !!resp.n8n.pollEnabled;
      $('pollMin').value = String(resp.n8n.pollMin || 5);
      const n8nParts = [];
      if (resp.n8n.fetchUrl) n8nParts.push('Busca: ok');
      if (resp.n8n.postUrl) n8nParts.push('Envio: ok');
      n8nParts.push(resp.n8n.pollEnabled ? `Auto a cada ${resp.n8n.pollMin} min` : 'Auto OFF');
      if (resp.n8n.lastPoll) n8nParts.push('Última busca: ' + resp.n8n.lastPoll);
      $('n8nStatus').innerText = n8nParts.join(' | ');
    }
  } catch (e) {
    $('status').innerText = 'Sem resposta do background.';
  }
}

chrome.runtime.onMessage.addListener(request => {
  if (request.action === 'log') {
    printLog(request.text);
  } else if (request.action === 'status_update') {
    $('status').innerText = request.message;
  }
});

refreshStatus();