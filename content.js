// FX Risk Calculator — content script injected into TradingView
(function () {
  'use strict';

  // Guard against double-injection (e.g. navigating between charts)
  if (document.getElementById('fx-risk-calc-host')) return;

  let shadow = null;        // ShadowRoot
  let detectedPair = null;
  let detectedPrices = { SL: null, Entry: null, TP: null };

  // ─────────────────────────────────────────────
  // Bootstrap
  // ─────────────────────────────────────────────
  function boot() {
    mountOverlay();
    watchTitleForPair();
  }

  // ─────────────────────────────────────────────
  // Mount overlay into an isolated shadow DOM
  // ─────────────────────────────────────────────
  function mountOverlay() {
    const host = document.createElement('div');
    host.id = 'fx-risk-calc-host';
    Object.assign(host.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: '2147483647',
    });
    document.body.appendChild(host);

    shadow = host.attachShadow({ mode: 'open' });

    // Inject stylesheet into shadow root
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('overlay.css');
    shadow.appendChild(link);

    // Fetch and inject HTML template
    fetch(chrome.runtime.getURL('overlay.html'))
      .then(r => r.text())
      .then(html => {
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        shadow.appendChild(tpl.content.cloneNode(true));
        initUI();
      })
      .catch(err => console.error('[FX Risk] Failed to load overlay.html:', err));
  }

  // ─────────────────────────────────────────────
  // UI initialisation (called after HTML is ready)
  // ─────────────────────────────────────────────
  async function initUI() {
    const settings = await Settings.load();

    // Populate calculator tab defaults
    q('risk-pct').value = settings.defaultRisk;

    // Populate settings tab
    q('account-size').value      = settings.accountSize;
    q('account-currency').value  = settings.accountCurrency;
    q('default-risk').value      = settings.defaultRisk;

    // Refresh pair
    detectedPair = detectPair();
    renderPair();

    wireEvents();
    setupDrag();
  }

  // ─────────────────────────────────────────────
  // Event wiring
  // ─────────────────────────────────────────────
  function wireEvents() {
    // Collapse / expand
    q('fx-toggle').addEventListener('click', () => {
      const panel = q('fx-panel');
      const btn   = q('fx-toggle');
      const collapsed = panel.style.display === 'none';
      panel.style.display = collapsed ? '' : 'none';
      btn.textContent    = collapsed ? '▲' : '▼';
    });

    // Tab switching
    shadow.querySelectorAll('.fx-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        shadow.querySelectorAll('.fx-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabId = tab.dataset.tab;
        q('tab-calculator').style.display = tabId === 'calculator' ? '' : 'none';
        q('tab-settings').style.display   = tabId === 'settings'   ? '' : 'none';
      });
    });

    // Read lines
    q('btn-read-lines').addEventListener('click', onReadLines);

    // Calculate
    q('btn-calculate').addEventListener('click', onCalculate);

    // Save settings
    q('btn-save-settings').addEventListener('click', onSaveSettings);
  }

  // ─────────────────────────────────────────────
  // Dragging
  // ─────────────────────────────────────────────
  function setupDrag() {
    const host   = document.getElementById('fx-risk-calc-host');
    const header = shadow.getElementById('fx-header');

    let dragging = false, ox = 0, oy = 0, startRight = 0, startBottom = 0;

    header.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging   = true;
      ox         = e.clientX;
      oy         = e.clientY;
      startRight  = parseInt(host.style.right,  10) || 20;
      startBottom = parseInt(host.style.bottom, 10) || 20;
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      // right = startRight + (ox - e.clientX)  — drag left → right increases
      host.style.right  = Math.max(0, startRight  + (ox - e.clientX)) + 'px';
      host.style.bottom = Math.max(0, startBottom + (oy - e.clientY)) + 'px';
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ─────────────────────────────────────────────
  // Pair detection
  // ─────────────────────────────────────────────
  function detectPair() {
    // 1. Page title: "EURUSD, 15 — TradingView"
    const titleMatch = document.title.match(/\b([A-Z]{6})\b/);
    if (titleMatch) return titleMatch[1];

    // 2. URL ?symbol= or #symbol=
    const urlSymbol = new URLSearchParams(window.location.search).get('symbol')
                   || new URLSearchParams(window.location.hash.replace('#', '')).get('symbol');
    if (urlSymbol) {
      const clean = urlSymbol.replace(/[^A-Z]/gi, '').toUpperCase();
      if (clean.length >= 6) return clean.slice(0, 6);
    }

    // 3. Common TradingView DOM selectors (class names change with deploys)
    const domSelectors = [
      '[data-name="legend-series-item"] .js-button-text',
      '[class*="titleWrapper"] [class*="title"]',
      '[class*="SymbolInfo"] [class*="title"]',
      '.chart-widget [class*="title"]',
    ];
    for (const sel of domSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = el.textContent.replace(/[^A-Z]/gi, '').toUpperCase();
      if (/^[A-Z]{6}$/.test(text)) return text;
    }

    return null;
  }

  function renderPair() {
    const el = q('detected-pair');
    el.textContent = detectedPair || 'Not detected';
    el.style.color = detectedPair ? '#f0a500' : '#f23645';
  }

  function watchTitleForPair() {
    const titleEl = document.querySelector('title');
    if (!titleEl) return;
    new MutationObserver(() => {
      const found = detectPair();
      if (found && found !== detectedPair) {
        detectedPair = found;
        if (shadow) renderPair();
      }
    }).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // ─────────────────────────────────────────────
  // Read-lines handler
  // ─────────────────────────────────────────────
  function onReadLines() {
    clearError();
    hideResults();

    const prices = scanChartForLines();
    const found  = Object.values(prices).filter(v => v !== null).length;

    detectedPrices = prices;
    renderPriceDisplay();

    if (found === 0) {
      showError('Lines not found — make sure you have 3 horizontal lines labeled SL, Entry, and TP on the chart.\nTry clicking "Enter Manually" to type the prices directly.');
      showManualLines(true);
      return;
    }

    if (found < 3) {
      const missing = ['SL', 'Entry', 'TP'].filter(k => prices[k] === null).join(', ');
      showError(`Found ${found}/3 lines. Missing: ${missing}. Check your labels, or fill in the prices below.`);
      showManualLines(true);
    } else {
      showManualLines(false);
    }
  }

  // ─────────────────────────────────────────────
  // DOM scanner — three complementary strategies
  // ─────────────────────────────────────────────
  function scanChartForLines() {
    const result   = { SL: null, Entry: null, TP: null };
    const labelMap = { sl: 'SL', entry: 'Entry', tp: 'TP' };

    // Strategy 1 — TreeWalker: find exact-match text nodes, then extract price from context
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      const raw  = walker.currentNode.textContent.trim();
      const key  = labelMap[raw.toLowerCase()];
      if (!key || result[key] !== null) continue;

      // Walk up DOM tree looking for an associated price
      let price = null;
      let el    = walker.currentNode.parentElement;
      for (let depth = 0; depth < 5 && el && price === null; depth++) {
        price = extractPrice(el, walker.currentNode.parentElement);
        el    = el.parentElement;
      }

      // Positional fallback: find a price element at the same screen Y
      if (price === null) {
        price = priceAtSameY(walker.currentNode.parentElement);
      }

      if (price !== null) result[key] = price;
    }

    // Strategy 2 — SVG text elements (TradingView labels are often SVG)
    if (anyMissing(result)) {
      for (const el of document.querySelectorAll('svg text, svg tspan')) {
        const raw = el.textContent.trim();
        const key = labelMap[raw.toLowerCase()];
        if (!key || result[key] !== null) continue;
        const price = priceAtSameY(el) ?? extractPrice(el.parentElement, el);
        if (price !== null) result[key] = price;
      }
    }

    // Strategy 3 — Combined label+price elements ("Entry 1.09234" in one node)
    if (anyMissing(result)) {
      const combinedRe = /^(SL|Entry|TP)\s+(\d{1,6}\.\d{2,8})$/i;
      const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      while (walker2.nextNode()) {
        const text  = walker2.currentNode.textContent.trim();
        const match = text.match(combinedRe);
        if (!match) continue;
        const key = labelMap[match[1].toLowerCase()];
        if (!key || result[key] !== null) continue;
        result[key] = parseFloat(match[2]);
      }
    }

    return result;
  }

  function anyMissing(result) {
    return Object.values(result).some(v => v === null);
  }

  // Extract a forex price from container text, excluding the label element
  function extractPrice(container, excludeEl) {
    if (!container) return null;
    let text = '';
    for (const child of container.childNodes) {
      if (child === excludeEl || (child.contains && child.contains(excludeEl))) continue;
      text += (child.textContent || '') + ' ';
    }
    // Also include entire container text as fallback (broader context)
    text += container.textContent;

    const matches = text.match(/\b(\d{1,6}\.\d{2,8})\b/g) || [];
    for (const m of matches) {
      const num = parseFloat(m);
      if (num > 0.0001 && num < 999999) return num;
    }
    return null;
  }

  // Find a price-looking leaf element whose vertical center is within 12px of labelEl
  function priceAtSameY(labelEl) {
    if (!labelEl) return null;
    const rect  = labelEl.getBoundingClientRect();
    const centY = rect.top + rect.height / 2;
    const TOL   = 12; // px tolerance

    let best = null, bestDist = Infinity;

    // Limit search to the chart widget area for performance + accuracy
    const chartRoot = document.querySelector(
      '.chart-widget, [class*="chart-container"], #chart-area, body'
    );

    for (const el of chartRoot.querySelectorAll('*')) {
      if (el.children.length > 0) continue; // leaf nodes only
      const text = el.textContent.trim();
      if (!/^\d{1,6}\.\d{2,8}$/.test(text)) continue;

      const elRect = el.getBoundingClientRect();
      const elCentY = elRect.top + elRect.height / 2;
      const dy = Math.abs(elCentY - centY);
      if (dy <= TOL && dy < bestDist) {
        const num = parseFloat(text);
        if (num > 0.0001 && num < 999999) {
          best     = num;
          bestDist = dy;
        }
      }
    }
    return best;
  }

  // ─────────────────────────────────────────────
  // Calculate handler
  // ─────────────────────────────────────────────
  async function onCalculate() {
    clearError();

    const riskPct = parseFloat(q('risk-pct').value);
    if (!riskPct || riskPct <= 0) {
      markError('risk-pct', 'Enter a valid risk %');
      return;
    }
    clearMark('risk-pct');

    // Resolve prices from detection or manual inputs
    const manualVisible = q('manual-lines-section').style.display !== 'none';
    let sl, entry, tp;

    if (manualVisible) {
      sl    = parseFloat(q('manual-sl').value);
      entry = parseFloat(q('manual-entry').value);
      tp    = parseFloat(q('manual-tp').value);
    } else {
      sl    = detectedPrices.SL;
      entry = detectedPrices.Entry;
      tp    = detectedPrices.TP;
    }

    if ([sl, entry, tp].some(v => !v || isNaN(v))) {
      showError('Missing prices. Click "📍 Read Lines" or enter prices manually using the fields below.');
      showManualLines(true);
      return;
    }

    // Basic sanity check: SL and TP must be on opposite sides of Entry
    const slBelow = sl < entry, tpAbove = tp > entry;
    const slAbove = sl > entry, tpBelow = tp < entry;
    if (!((slBelow && tpAbove) || (slAbove && tpBelow))) {
      showError('Invalid prices: SL and TP must be on opposite sides of Entry.');
      return;
    }

    if (!detectedPair || detectedPair.length < 6) {
      showError('Currency pair not detected. Please open a forex chart on TradingView first.');
      return;
    }

    const settings = await Settings.load();

    // Collect any manual exchange rates the user may have entered after a prior API failure
    const manualRates = collectManualRates();

    try {
      const result = await Calculator.calculate({
        entry, sl, tp,
        pair:            detectedPair,
        accountSize:     settings.accountSize,
        accountCurrency: settings.accountCurrency,
        riskPct,
        manualRates,
      });

      renderResults(result, settings.accountCurrency);
      hideManualRates();
    } catch (err) {
      if (err.type === 'RATE_ERROR') {
        showError(err.message);
        renderManualRateInputs(err.missing);
      } else {
        showError(err.message || 'Calculation failed. Please check your inputs.');
      }
    }
  }

  // Build { CURRENCY: rateInAPIConvention } from dynamically-generated inputs
  function collectManualRates() {
    const rates = {};
    const section = q('manual-rates-inputs');
    if (!section) return rates;

    section.querySelectorAll('input[data-currency]').forEach(input => {
      const val = parseFloat(input.value);
      if (!val || isNaN(val)) return;
      const currency  = input.dataset.currency;
      const direction = input.dataset.direction;
      if (direction === 'usdToQuote') {
        // User entered: 1 USD = N quote_currency  →  rates[quote] = N  ✓
        rates[currency] = val;
      } else if (direction === 'acctToUSD') {
        // User entered: 1 account_currency = N USD  →  rates[acct] = 1/N
        rates[currency] = 1 / val;
      }
    });
    return rates;
  }

  function renderManualRateInputs(missing) {
    const section = q('manual-rates-section');
    const inputs  = q('manual-rates-inputs');
    inputs.innerHTML = '';

    missing.forEach(({ currency, label, direction }) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'fx-field';

      const lbl = document.createElement('label');
      lbl.textContent = label;

      const inp = document.createElement('input');
      inp.type             = 'number';
      inp.step             = '0.00001';
      inp.dataset.currency  = currency;
      inp.dataset.direction = direction;
      inp.placeholder      = direction === 'usdToQuote' ? 'e.g. 150' : 'e.g. 1.08';

      wrapper.append(lbl, inp);
      inputs.appendChild(wrapper);
    });

    section.style.display = '';
  }

  function hideManualRates() {
    q('manual-rates-section').style.display = 'none';
    q('manual-rates-inputs').innerHTML = '';
  }

  // ─────────────────────────────────────────────
  // Settings handler
  // ─────────────────────────────────────────────
  async function onSaveSettings() {
    const accountSize = parseFloat(q('account-size').value);
    const defaultRisk = parseFloat(q('default-risk').value);
    const accountCurrency = q('account-currency').value;

    let valid = true;
    if (!accountSize || accountSize <= 0) { markError('account-size', ''); valid = false; }
    else clearMark('account-size');
    if (!defaultRisk || defaultRisk <= 0 || defaultRisk > 100) { markError('default-risk', ''); valid = false; }
    else clearMark('default-risk');
    if (!valid) return;

    await Settings.save({ accountSize, accountCurrency, defaultRisk });

    // Mirror new default into the calculator tab
    q('risk-pct').value = defaultRisk;

    const fb = q('settings-feedback');
    fb.style.display = '';
    setTimeout(() => { fb.style.display = 'none'; }, 2500);
  }

  // ─────────────────────────────────────────────
  // UI helpers
  // ─────────────────────────────────────────────
  function q(id) { return shadow.getElementById(id); }

  function renderPriceDisplay() {
    const fmt = v => v !== null ? v : '—';
    q('price-sl').textContent    = fmt(detectedPrices.SL);
    q('price-entry').textContent = fmt(detectedPrices.Entry);
    q('price-tp').textContent    = fmt(detectedPrices.TP);

    // Pre-fill manual inputs with detected values
    if (detectedPrices.SL    !== null) q('manual-sl').value    = detectedPrices.SL;
    if (detectedPrices.Entry !== null) q('manual-entry').value = detectedPrices.Entry;
    if (detectedPrices.TP    !== null) q('manual-tp').value    = detectedPrices.TP;
  }

  function showManualLines(show) {
    q('manual-lines-section').style.display = show ? '' : 'none';
  }

  function showError(msg) {
    const el = q('fx-error');
    el.textContent   = msg;
    el.style.display = '';
  }

  function clearError() {
    const el = q('fx-error');
    el.textContent   = '';
    el.style.display = 'none';
  }

  function hideResults() {
    q('results').style.display = 'none';
  }

  function markError(id, msg) {
    const input = q(id);
    if (input) input.classList.add('fx-input-error');
    if (msg)   showError(msg);
  }

  function clearMark(id) {
    q(id)?.classList.remove('fx-input-error');
  }

  const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

  function renderResults(result, accountCurrency) {
    const sym = CURRENCY_SYMBOLS[accountCurrency] || (accountCurrency + ' ');

    q('result-lot').textContent      = result.lotSize.toFixed(2);
    q('result-risk').textContent     = `${sym}${result.moneyAtRisk.toFixed(2)}`;
    q('result-rr').textContent       = `1 : ${result.rrRatio.toFixed(2)}`;
    q('result-sl-pips').textContent  = `${result.slPips.toFixed(1)} pips`;
    q('result-tp-pips').textContent  = `${result.tpPips.toFixed(1)} pips`;

    q('results').style.display = '';
  }

  // ─────────────────────────────────────────────
  // Go
  // ─────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
