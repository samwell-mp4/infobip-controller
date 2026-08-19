(function() {
  console.log('Infobip Scraper: Content Script Loaded');

  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function waitForElement(selector, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await wait(500);
    }
    return null;
  }

  function sendToBackground(type, payload) {
    return chrome.runtime.sendMessage({ type, payload }).catch((err) => {
      console.warn('Infobip Scraper: background indisponível:', err.message);
    });
  }

  async function isScrapingActive() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      return !!(response && response.isScraping);
    } catch (_) {
      return false;
    }
  }

  (async function init() {
    const active = await isScrapingActive();
    if (!active) {
      console.log('Infobip Scraper: coleta inativa, aguardando comando');
      return;
    }
    if (window.location.href.includes('/broadcast/preview/')) {
      scrapeDetailPage();
    } else if (window.location.href.includes('/broadcast')) {
      scrapeListPage();
    }
  })();

  async function scrapeListPage() {
    console.log('Infobip Scraper: Detectada página de listagem');

    const table = await waitForElement('.bepo-2-table');
    if (!table) {
      console.error('Tabela não encontrada');
      return;
    }

    await wait(3000); // Wait for rows to stabilize

    const rows = Array.from(document.querySelectorAll('tr')).slice(1);
    const data = rows.map(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 5) return null;

      const previewLink = row.querySelector('a[href*="/broadcast/preview/"]');

      return {
        name: cells[0]?.innerText?.trim(),
        status: 'FINISHED',
        sent: cells[2]?.innerText?.trim(),
        pending: cells[3]?.innerText?.trim(),
        delivered: cells[4]?.innerText?.trim(),
        deliveryRate: cells[5]?.innerText?.trim(),
        previewUrl: previewLink ? previewLink.href : null
      };
    }).filter(item => item !== null && item.previewUrl !== null);

    await sendToBackground('LIST_DATA_RECEIVED', data);
  }

  async function scrapeDetailPage() {
    console.log('Infobip Scraper: Detectada página de detalhes');

    // Wait for a key indicator that the detail page is loaded
    await waitForElement('body');
    await wait(4000); // Increased wait time to ensure charts and values are rendered for the screenshot

    const extractByLabel = (label) => {
      // Find all elements and look for the label text
      const allElements = Array.from(document.querySelectorAll('*'));
      const labelElement = allElements.find(el =>
        el.children.length === 0 &&
        el.innerText &&
        el.innerText.trim().toLowerCase() === label.toLowerCase()
      );

      if (labelElement) {
        // In the provided screenshot, the value is often in a sibling or parent sibling
        // Try next sibling
        let valueEl = labelElement.nextElementSibling;
        if (valueEl && valueEl.innerText.trim() !== '') {
           return valueEl.innerText.trim();
        }

        // Try parent's next sibling (common in many dashboard layouts)
        const parent = labelElement.parentElement;
        if (parent && parent.nextElementSibling) {
          return parent.nextElementSibling.innerText.trim();
        }

        // Try searching for a span/div with numbers near the label
        const context = labelElement.closest('div');
        if (context) {
          const text = context.innerText;
          const parts = text.split('\n');
          const index = parts.findIndex(p => p.trim().toLowerCase() === label.toLowerCase());
          if (index !== -1 && parts[index + 1]) return parts[index + 1].trim();
        }
      }
      return 'N/A';
    };

    // Specific logic for the summary boxes shown in screenshot
    const summaryData = {
      sent: extractByLabel('Enviadas'),
      pending: extractByLabel('Pendentes'),
      delivered: extractByLabel('Entregues'),
      deliveryRate: extractByLabel('Taxa de entrega')
    };

    const details = {
      name: document.querySelector('h1, h2')?.innerText?.trim() || 'N/A',
      sent: summaryData.sent,
      pending: summaryData.pending,
      delivered: summaryData.delivered,
      deliveryRate: summaryData.deliveryRate,
      sender: extractByLabel('Remetente'),
      recipients: extractByLabel('Destinatários'),
      totalDestinations: extractByLabel('Total de destinos'),
      possibleDestinations: extractByLabel('Destinos possíveis'),
      ignored: extractByLabel('Mensagens ignoradas')
    };

    console.log('Detalhes coletados:', details);
    await sendToBackground('DETAIL_DATA_RECEIVED', details);
  }
})();