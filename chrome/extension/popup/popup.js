document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const dateFromInput = document.getElementById('dateFrom');
  const dateToInput = document.getElementById('dateTo');
  const statusCard = document.getElementById('statusCard');
  const statusText = document.getElementById('statusText');
  const percentageText = document.getElementById('percentageText');
  const progressFill = document.getElementById('progressFill');
  const currentCampaignName = document.getElementById('currentCampaignName');
  const deliveredCount = document.getElementById('deliveredCount');
  const notDeliveredCount = document.getElementById('notDeliveredCount');
  const processedCount = document.getElementById('processedCount');
  const errorCount = document.getElementById('errorCount');
  const actionArea = document.getElementById('actionArea');
  const exportBtn = document.getElementById('exportBtn');
  const clearBtn = document.getElementById('clearBtn');

  // Set default dates (today and yesterday)
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  dateToInput.value = today.toISOString().slice(0, 16);
  dateFromInput.value = yesterday.toISOString().slice(0, 16);

  // Check current status
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (response && response.isScraping) {
      updateUI(response);
    }
  });

  startBtn.addEventListener('click', () => {
    const dateFrom = new Date(dateFromInput.value).getTime();
    const dateTo = new Date(dateToInput.value).getTime();

    if (isNaN(dateFrom) || isNaN(dateTo)) {
      alert('Por favor, selecione as datas corretamente.');
      return;
    }

    startBtn.classList.add('loading');
    startBtn.disabled = true;
    statusCard.style.display = 'flex';
    pauseBtn.style.display = 'block';
    stopBtn.style.display = 'block';
    
    chrome.runtime.sendMessage({
      type: 'START_SCRAPING',
      dateFrom,
      dateTo
    });
  });

  pauseBtn.addEventListener('click', () => {
    const isPaused = pauseBtn.textContent.trim() === 'Retomar';
    if (isPaused) {
      chrome.runtime.sendMessage({ type: 'RESUME_SCRAPING' });
      pauseBtn.textContent = 'Pausar';
    } else {
      chrome.runtime.sendMessage({ type: 'PAUSE_SCRAPING' });
      pauseBtn.textContent = 'Retomar';
    }
  });

  stopBtn.addEventListener('click', () => {
    if (confirm('Deseja realmente parar a coleta? Os dados coletados até agora serão exportados.')) {
      chrome.runtime.sendMessage({ type: 'STOP_SCRAPING' });
    }
  });

  exportBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'EXPORT_DATA' });
  });

  clearBtn.addEventListener('click', () => {
    if (confirm('Deseja realmente limpar todos os dados coletados?')) {
      chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, () => {
        statusCard.style.display = 'none';
        actionArea.style.display = 'none';
        pauseBtn.style.display = 'none';
        stopBtn.style.display = 'none';
        processedCount.textContent = '0';
        errorCount.textContent = '0';
        progressFill.style.width = '0%';
      });
    }
  });

  // Listen for updates from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATUS_UPDATE') {
      updateUI(message.payload);
    }
  });

  function updateUI(data) {
    statusCard.style.display = 'flex';
    
    if (data.isPaused) {
      statusText.textContent = 'Pausado...';
      pauseBtn.textContent = 'Retomar';
    } else {
      statusText.textContent = data.message || 'Processando...';
      pauseBtn.textContent = 'Pausar';
    }
    
    currentCampaignName.textContent = data.currentCampaign || 'Aguardando...';
    deliveredCount.textContent = data.currentDelivered || 0;
    notDeliveredCount.textContent = data.currentNotDelivered || 0;

    const progress = data.total > 0 ? (data.processed / data.total) * 100 : 0;
    percentageText.textContent = `${Math.round(progress)}%`;
    progressFill.style.width = `${progress}%`;
    
    processedCount.textContent = data.processed;
    errorCount.textContent = data.errors || 0;

    if (data.isFinished) {
      startBtn.classList.remove('loading');
      startBtn.disabled = false;
      pauseBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      actionArea.style.display = 'grid';
      statusText.textContent = 'Concluído!';
      currentCampaignName.textContent = 'Finalizado';
    } else if (data.isScraping) {
      startBtn.classList.add('loading');
      startBtn.disabled = true;
      pauseBtn.style.display = 'block';
      stopBtn.style.display = 'block';
      actionArea.style.display = 'none';
    }
  }
});
