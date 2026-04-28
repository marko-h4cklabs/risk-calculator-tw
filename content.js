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
  // LineDrawer — interactive line placement on chart
  // ─────────────────────────────────────────────
  const LineDrawer = (() => {
    // Entry first so the user sets the anchor price before risk lines
    const PHASES = [
      { key: 'Entry', label: 'Entry', color: '#f0a500', textColor: '#000',
        status: '1/3 — Click chart to set Entry  (Esc: cancel)' },
      { key: 'SL',    label: 'SL',    color: '#f23645', textColor: '#fff',
        status: '2/3 — Click chart to set SL' },
      { key: 'TP',    label: 'TP',    color: '#4caf50', textColor: '#000',
        status: '3/3 — Click chart to set TP' },
    ];

    // All mutable state — fully reset on each start()
    let chartSVG    = null;   // <svg> overlay for the drawn lines
    let capDiv      = null;   // transparent div that intercepts chart clicks
    let statusEl    = null;   // reference to the #line-status element in shadow DOM
    let doneCb      = null;   // callback({ Entry, SL, TP }) called when all placed
    let noScaleCb   = null;   // callback() when price axis cannot be read
    let pricePoints = [];     // [{ y: number, price: number }] sorted top→bottom
    let decimals    = 5;
    let phaseIdx    = 0;
    let recorded    = {};
    let moveHnd     = null;   // document mousemove handler for the active phase
    let clickHnd    = null;   // capDiv click handler for the active phase
    let keyHnd      = null;   // document keydown handler (ESC)

    // ── Price axis reading ────────────────────────────────────────────

    function getChartBounds() {
      for (const sel of ['.chart-widget', '[class*="chartWidget"]',
                          '.layout__area--center', '.chart-container']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 300 && r.height > 200) return r;
      }
      return { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
    }

    function collectPricePoints(bounds) {
      // Look only in the rightmost strip where TradingView renders the Y-axis labels
      const minX = bounds.right - 200;
      const seen = new Map(); // price → { y, left } — deduplicate by price

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      while (walker.nextNode()) {
        const raw = walker.currentNode.textContent.trim().replace(/,/g, '');
        // Must be a decimal number (e.g. "1.08500", "150.234") — no pure integers
        if (!/^\d{1,6}\.\d{1,8}$/.test(raw)) continue;
        const price = parseFloat(raw);
        if (!price || price <= 0) continue;

        const el = walker.currentNode.parentElement;
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;

        // Must be horizontally inside the price-axis strip
        const cx = r.left + r.width / 2;
        if (cx < minX) continue;

        // Must be vertically inside the chart
        if (r.top < bounds.top || r.bottom > bounds.bottom) continue;

        const y = r.top + r.height / 2;
        const prev = seen.get(price);
        // Keep the occurrence furthest right (most likely the axis label, not body text)
        if (!prev || r.left > prev.left) seen.set(price, { y, left: r.left });
      }

      return [...seen.entries()]
        .map(([price, { y }]) => ({ price, y }))
        .sort((a, b) => a.y - b.y); // top-to-bottom = high-to-low price
    }

    function guessDecimals(pts) {
      let max = 2;
      for (const { price } of pts) {
        const s = price.toString();
        const d = s.indexOf('.');
        if (d >= 0) max = Math.max(max, s.length - d - 1);
      }
      return max;
    }

    function interpolate(clientY) {
      const pts = pricePoints, n = pts.length;
      if (n === 0) return null;
      if (n === 1) return pts[0].price;

      // Extrapolate above/below the sampled range
      if (clientY <= pts[0].y) {
        const s = (pts[1].price - pts[0].price) / (pts[1].y - pts[0].y);
        return pts[0].price + s * (clientY - pts[0].y);
      }
      if (clientY >= pts[n - 1].y) {
        const s = (pts[n-1].price - pts[n-2].price) / (pts[n-1].y - pts[n-2].y);
        return pts[n-1].price + s * (clientY - pts[n-1].y);
      }

      // Linear interpolation between surrounding samples
      for (let i = 0; i < n - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (clientY >= a.y && clientY <= b.y) {
          const t = (clientY - a.y) / (b.y - a.y);
          return a.price + t * (b.price - a.price);
        }
      }
      return null;
    }

    function fmt(price) {
      return (price !== null && !isNaN(price)) ? price.toFixed(decimals) : '—';
    }

    // ── SVG helpers ───────────────────────────────────────────────────

    function svgEl(tag, attrs) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      chartSVG.appendChild(el);
      return el;
    }

    function makeLineGroup(color, textColor, dashed) {
      const line = svgEl('line', {
        x1: '0', x2: '100%',
        stroke: color, 'stroke-width': '1.5',
        ...(dashed ? { 'stroke-dasharray': '8 4' } : {}),
      });
      const bg  = svgEl('rect',  { height: '18', rx: '3', fill: color });
      const txt = svgEl('text',  {
        fill: textColor,
        'font-size': '11',
        'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'font-weight': '700',
        'dominant-baseline': 'middle',
      });
      return { line, bg, txt };
    }

    function placeGroup(g, y, labelStr) {
      g.line.setAttribute('y1', y); g.line.setAttribute('y2', y);
      g.txt.textContent = labelStr;
      const w = Math.ceil(labelStr.length * 7.5 + 12);
      const x = window.innerWidth - w - 16;
      g.bg.setAttribute('x', x);   g.bg.setAttribute('y',     y - 9);
      g.bg.setAttribute('width', w);
      g.txt.setAttribute('x', x + 6); g.txt.setAttribute('y', y);
    }

    // ── Status helper ─────────────────────────────────────────────────

    function setStatus(text, placing) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.className   = 'fx-line-status' + (placing ? ' placing' : '');
    }

    // ── Phase execution ───────────────────────────────────────────────

    function runPhase() {
      if (phaseIdx >= PHASES.length) { finishPlacement(); return; }

      const ph = PHASES[phaseIdx];
      setStatus(ph.status, true);

      const grp = makeLineGroup(ph.color, ph.textColor, true);

      // Track mouse globally so the line follows even when the cursor drifts
      // over the FX panel (which sits above the capture div)
      moveHnd = (e) => {
        const price = interpolate(e.clientY);
        placeGroup(grp, e.clientY, `${ph.label}  ${fmt(price)}`);
      };
      document.addEventListener('mousemove', moveHnd);

      // Lock the line when the user clicks anywhere on the chart
      // (capDiv sits below the FX panel, so panel clicks are unaffected)
      clickHnd = (e) => {
        const price = interpolate(e.clientY);
        if (price === null) return;

        // Solidify: remove dash to show this line is locked
        grp.line.removeAttribute('stroke-dasharray');
        recorded[ph.key] = parseFloat(fmt(price));
        phaseIdx++;

        // Tear down this phase's listeners before advancing
        document.removeEventListener('mousemove', moveHnd);
        capDiv.removeEventListener('click', clickHnd);
        moveHnd = null; clickHnd = null;

        runPhase();
      };
      capDiv.addEventListener('click', clickHnd);
    }

    function finishPlacement() {
      // Remove the capture div — TradingView regains full mouse control
      capDiv.remove(); capDiv = null;
      document.removeEventListener('keydown', keyHnd); keyHnd = null;

      // chartSVG stays in DOM; pointer-events:none means it never blocks the chart

      setStatus('✓ Lines placed — click ⚡ Calculate', false);
      if (doneCb) doneCb({ ...recorded });
    }

    // ── Public API ────────────────────────────────────────────────────

    function start(opts) {
      reset(); // always start fresh, removing any previous SVG

      statusEl  = opts.statusEl;
      doneCb    = opts.onDone;
      noScaleCb = opts.onNoScale;

      const bounds = getChartBounds();
      pricePoints  = collectPricePoints(bounds);
      decimals     = guessDecimals(pricePoints);

      if (pricePoints.length < 2) {
        setStatus('⚠ Cannot read price axis — hover over the chart first, then retry.', false);
        if (noScaleCb) noScaleCb();
        return;
      }

      // Full-viewport SVG overlay; pointer-events:none so it never blocks
      chartSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      Object.assign(chartSVG.style, {
        position: 'fixed', top: '0', left: '0',
        width: '100vw', height: '100vh',
        pointerEvents: 'none',
        zIndex: '2147483645',
      });
      document.body.appendChild(chartSVG);

      // Transparent capture div — sits above chart (z below FX panel)
      // Gives crosshair cursor and absorbs clicks so TradingView doesn't react
      capDiv = document.createElement('div');
      Object.assign(capDiv.style, {
        position: 'fixed', top: '0', left: '0',
        width: '100vw', height: '100vh',
        cursor: 'crosshair',
        zIndex: '2147483646',
        background: 'transparent',
      });
      document.body.appendChild(capDiv);

      // ESC cancels at any point
      keyHnd = (e) => { if (e.key === 'Escape') cancel(); };
      document.addEventListener('keydown', keyHnd);

      phaseIdx = 0; recorded = {};
      runPhase();
    }

    function cancel() {
      const s = statusEl; // grab before reset() nulls it
      reset();
      if (s) { s.textContent = 'Cancelled — click "Read Lines" to try again.'; s.className = 'fx-line-status'; }
    }

    function reset() {
      // Listeners
      if (moveHnd)             document.removeEventListener('mousemove', moveHnd);
      if (clickHnd && capDiv)  capDiv.removeEventListener('click', clickHnd);
      if (keyHnd)              document.removeEventListener('keydown', keyHnd);
      // DOM elements
      capDiv?.remove();
      chartSVG?.remove();
      // State
      chartSVG = null; capDiv = null;
      pricePoints = []; decimals = 5;
      phaseIdx = 0; recorded = {};
      moveHnd = null; clickHnd = null; keyHnd = null;
    }

    return { start, cancel, reset };
  })();

  // ─────────────────────────────────────────────
  // Read-lines handler  (now starts interactive placement)
  // ─────────────────────────────────────────────
  function onReadLines() {
    clearError();
    hideResults();
    showManualLines(false);

    LineDrawer.start({
      statusEl:  q('line-status'),
      onDone:    (prices) => {
        detectedPrices = prices;
        renderPriceDisplay();
      },
      onNoScale: () => {
        showManualLines(true);
        showError('Price axis unreadable — enter prices manually below.');
      },
    });
  }

  // ─────────────────────────────────────────────
  // Calculate handler
  // ─────────────────────────────────────────────
  async function onCalculate() {
    clearError();
    LineDrawer.reset(); // remove chart overlay once the user commits to Calculate

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
