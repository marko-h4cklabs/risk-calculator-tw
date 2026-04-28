// FX Risk Calculator — content script injected into TradingView
(function () {
  'use strict';

  // Guard against double-injection (e.g. navigating between charts)
  if (document.getElementById('fx-risk-calc-host')) return;

  let shadow = null;        // ShadowRoot
  let uiReady = false;      // true only after overlay HTML is injected and initUI() completes
  let detectedPair = null;
  let detectedPrices = { SL: null, Entry: null, TP: null };
  let lastDebugData  = null; // populated after every successful calculation

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

    // Guard every element before writing — the await above creates a suspension
    // point; although the shadow DOM isn't torn down between ticks, being
    // explicit here makes every subsequent call safe.
    const riskPctEl        = q('risk-pct');
    const accountSizeEl    = q('account-size');
    const accountCurrEl    = q('account-currency');
    const defaultRiskEl    = q('default-risk');

    if (!riskPctEl || !accountSizeEl || !accountCurrEl || !defaultRiskEl) {
      console.error('[FX Risk] initUI: one or more form elements missing from shadow DOM');
      return;
    }

    riskPctEl.value     = settings.defaultRisk;
    accountSizeEl.value = settings.accountSize;
    accountCurrEl.value = settings.accountCurrency;
    defaultRiskEl.value = settings.defaultRisk;

    detectedPair = detectPair();
    renderPair();

    wireEvents();
    setupDrag();

    // Only flip the flag after everything is wired — the MutationObserver
    // in watchTitleForPair() checks this before touching any shadow elements.
    uiReady = true;
  }

  // ─────────────────────────────────────────────
  // Event wiring
  // ─────────────────────────────────────────────
  function wireEvents() {
    // Collapse / expand — use optional chaining so a missing element skips silently
    q('fx-toggle')?.addEventListener('click', () => {
      const panel = q('fx-panel');
      const btn   = q('fx-toggle');
      if (!panel || !btn) return;
      const collapsed = panel.style.display === 'none';
      panel.style.display = collapsed ? '' : 'none';
      btn.textContent    = collapsed ? '▲' : '▼';
    });

    // Tab switching
    shadow.querySelectorAll('.fx-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        shadow.querySelectorAll('.fx-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabId   = tab.dataset.tab;
        const calcTab = q('tab-calculator');
        const settTab = q('tab-settings');
        if (calcTab) calcTab.style.display = tabId === 'calculator' ? '' : 'none';
        if (settTab) settTab.style.display = tabId === 'settings'   ? '' : 'none';
      });
    });

    q('btn-read-lines')?.addEventListener('click', onReadLines);
    q('btn-calculate')?.addEventListener('click', onCalculate);
    q('btn-save-settings')?.addEventListener('click', onSaveSettings);

    // Secret debug toggle: type "fxdebug" while focused on the Risk % field.
    // type="number" swallows the characters so .value never changes, but keydown
    // still fires — we build a rolling buffer to detect the sequence.
    const DEBUG_SEQ = 'fxdebug';
    let debugBuf = '';
    q('risk-pct')?.addEventListener('keydown', (e) => {
      debugBuf = (debugBuf + e.key).slice(-DEBUG_SEQ.length);
      if (debugBuf === DEBUG_SEQ) { debugBuf = ''; toggleDebugPanel(); }
    });
  }

  // ─────────────────────────────────────────────
  // Dragging
  // ─────────────────────────────────────────────
  function setupDrag() {
    const host   = document.getElementById('fx-risk-calc-host');
    const header = shadow.getElementById('fx-header');

    // Both must exist — header is the drag handle, host is what we reposition
    if (!host || !header) return;

    let dragging = false, ox = 0, oy = 0, startRight = 0, startBottom = 0;

    header.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging    = true;
      ox          = e.clientX;
      oy          = e.clientY;
      startRight  = parseInt(host.style.right,  10) || 20;
      startBottom = parseInt(host.style.bottom, 10) || 20;
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      host.style.right  = Math.max(0, startRight  + (ox - e.clientX)) + 'px';
      host.style.bottom = Math.max(0, startBottom + (oy - e.clientY)) + 'px';
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ─────────────────────────────────────────────
  // Pair detection
  // ─────────────────────────────────────────────
  function detectPair() {
    // 1. DOM selectors — most accurate once the chart widget is mounted.
    //    Wrapped in try/catch because some selectors can throw on malformed DOMs,
    //    and we guard el.textContent explicitly before calling .replace() on it.
    const domSelectors = [
      '[data-name="legend-series-item"] .js-button-text',
      '[class*="titleWrapper"] [class*="title"]',
      '[class*="SymbolInfo"] [class*="title"]',
      '.chart-widget [class*="title"]',
    ];
    try {
      for (const sel of domSelectors) {
        const el = document.querySelector(sel);
        if (!el || !el.textContent) continue;
        const text = el.textContent.replace(/[^A-Z]/gi, '').toUpperCase();
        if (/^[A-Z]{6}$/.test(text)) return text;
      }
    } catch (_) { /* selector threw — fall through to next strategy */ }

    // 2. URL ?symbol= or #symbol=
    const urlSymbol = new URLSearchParams(window.location.search).get('symbol')
                   || new URLSearchParams(window.location.hash.replace('#', '')).get('symbol');
    if (urlSymbol) {
      const clean = urlSymbol.replace(/[^A-Z]/gi, '').toUpperCase();
      if (clean.length >= 6) return clean.slice(0, 6);
    }

    // 3. Page title fallback.
    //    Handles both "EURUSD · 1D · OANDA · TradingView" and "EURUSD, 15 — TradingView".
    //    Split on middle-dot, whitespace, or comma; take the first token; strip non-letters.
    const firstToken = document.title.split(/[·\s,]+/)[0].replace(/[^A-Z]/gi, '').toUpperCase();
    if (/^[A-Z]{6}$/.test(firstToken)) return firstToken;

    return null;
  }

  function renderPair() {
    const el = q('detected-pair');
    if (!el) return;
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
        // uiReady is only true after initUI() finishes — guards against the race
        // where the title changes before the HTML template has been injected.
        if (uiReady) renderPair();
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

      // Find the first adjacent pair with a non-zero pixel span for extrapolation anchors
      function slopeAt(i) {
        const dy = pts[i + 1].y - pts[i].y;
        if (Math.abs(dy) < 0.5) return null; // zero-range guard
        return (pts[i + 1].price - pts[i].price) / dy;
      }

      // Extrapolate above the sampled range
      if (clientY <= pts[0].y) {
        for (let i = 0; i < n - 1; i++) {
          const s = slopeAt(i);
          if (s !== null) {
            const result = pts[i].price + s * (clientY - pts[i].y);
            return isFinite(result) ? result : null;
          }
        }
        return pts[0].price;
      }

      // Extrapolate below the sampled range
      if (clientY >= pts[n - 1].y) {
        for (let i = n - 2; i >= 0; i--) {
          const s = slopeAt(i);
          if (s !== null) {
            const result = pts[i].price + s * (clientY - pts[i].y);
            return isFinite(result) ? result : null;
          }
        }
        return pts[n - 1].price;
      }

      // Linear interpolation between surrounding samples
      for (let i = 0; i < n - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (clientY >= a.y && clientY <= b.y) {
          const dy = b.y - a.y;
          if (Math.abs(dy) < 0.5) return a.price; // degenerate segment — return anchor price
          const t = (clientY - a.y) / dy;
          const result = a.price + t * (b.price - a.price);
          return isFinite(result) ? result : null;
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
        // null means interpolation failed (zero-range axis); trigger manual fallback
        if (price === null || !isFinite(price)) {
          document.removeEventListener('mousemove', moveHnd);
          capDiv.removeEventListener('click', clickHnd);
          moveHnd = null; clickHnd = null;
          cancel();
          if (noScaleCb) noScaleCb();
          return;
        }

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
      const s = statusEl; // grab before reset() clears it
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
  // Read-lines handler  (starts interactive placement)
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

    const riskPctEl = q('risk-pct');
    if (!riskPctEl) return;
    const riskPct = parseFloat(riskPctEl.value);
    if (!riskPct || riskPct <= 0) {
      markError('risk-pct', 'Enter a valid risk %');
      return;
    }
    clearMark('risk-pct');

    // Resolve prices from detection or manual inputs
    const manualSection = q('manual-lines-section');
    const manualVisible = manualSection ? manualSection.style.display !== 'none' : false;
    let sl, entry, tp;

    if (manualVisible) {
      const slEl    = q('manual-sl');
      const entryEl = q('manual-entry');
      const tpEl    = q('manual-tp');
      if (!slEl || !entryEl || !tpEl) return;
      sl    = parseFloat(slEl.value);
      entry = parseFloat(entryEl.value);
      tp    = parseFloat(tpEl.value);
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

      lastDebugData = result._debug;
      renderResults(result, settings.accountCurrency);
      hideManualRates();
      refreshDebugPanel();
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
        rates[currency] = val;
      } else if (direction === 'acctToUSD') {
        rates[currency] = 1 / val;
      }
    });
    return rates;
  }

  function renderManualRateInputs(missing) {
    const section = q('manual-rates-section');
    const inputs  = q('manual-rates-inputs');
    if (!section || !inputs) return;
    inputs.innerHTML = '';

    missing.forEach(({ currency, label, direction }) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'fx-field';

      const lbl = document.createElement('label');
      lbl.textContent = label;

      const inp = document.createElement('input');
      inp.type              = 'number';
      inp.step              = '0.00001';
      inp.dataset.currency  = currency;
      inp.dataset.direction = direction;
      inp.placeholder       = direction === 'usdToQuote' ? 'e.g. 150' : 'e.g. 1.08';

      wrapper.append(lbl, inp);
      inputs.appendChild(wrapper);
    });

    section.style.display = '';
  }

  function hideManualRates() {
    const section = q('manual-rates-section');
    const inputs  = q('manual-rates-inputs');
    if (section) section.style.display = 'none';
    if (inputs)  inputs.innerHTML = '';
  }

  // ─────────────────────────────────────────────
  // Settings handler
  // ─────────────────────────────────────────────
  async function onSaveSettings() {
    const accountSizeEl = q('account-size');
    const defaultRiskEl = q('default-risk');
    const accountCurrEl = q('account-currency');
    if (!accountSizeEl || !defaultRiskEl || !accountCurrEl) return;

    const accountSize     = parseFloat(accountSizeEl.value);
    const defaultRisk     = parseFloat(defaultRiskEl.value);
    const accountCurrency = accountCurrEl.value;

    let valid = true;
    if (!accountSize || accountSize <= 0) { markError('account-size', ''); valid = false; }
    else clearMark('account-size');
    if (!defaultRisk || defaultRisk <= 0 || defaultRisk > 100) { markError('default-risk', ''); valid = false; }
    else clearMark('default-risk');
    if (!valid) return;

    await Settings.save({ accountSize, accountCurrency, defaultRisk });

    // Mirror new default into the calculator tab
    const riskPctEl = q('risk-pct');
    if (riskPctEl) riskPctEl.value = defaultRisk;

    const fb = q('settings-feedback');
    if (!fb) return;
    fb.style.display = '';
    setTimeout(() => { fb.style.display = 'none'; }, 2500);
  }

  // ─────────────────────────────────────────────
  // UI helpers
  // ─────────────────────────────────────────────
  function q(id) { return shadow.getElementById(id); }

  function renderPriceDisplay() {
    const fmt      = v => v !== null ? v : '—';
    const slEl     = q('price-sl');
    const entryEl  = q('price-entry');
    const tpEl     = q('price-tp');
    if (!slEl || !entryEl || !tpEl) return;

    slEl.textContent    = fmt(detectedPrices.SL);
    entryEl.textContent = fmt(detectedPrices.Entry);
    tpEl.textContent    = fmt(detectedPrices.TP);

    // Pre-fill manual inputs with detected values — guard each independently
    const manSlEl    = q('manual-sl');
    const manEntryEl = q('manual-entry');
    const manTpEl    = q('manual-tp');
    if (detectedPrices.SL    !== null && manSlEl)    manSlEl.value    = detectedPrices.SL;
    if (detectedPrices.Entry !== null && manEntryEl) manEntryEl.value = detectedPrices.Entry;
    if (detectedPrices.TP    !== null && manTpEl)    manTpEl.value    = detectedPrices.TP;
  }

  function showManualLines(show) {
    const el = q('manual-lines-section');
    if (!el) return;
    el.style.display = show ? '' : 'none';
  }

  function showError(msg) {
    const el = q('fx-error');
    if (!el) return;
    el.textContent   = msg;
    el.style.display = '';
  }

  function clearError() {
    const el = q('fx-error');
    if (!el) return;
    el.textContent   = '';
    el.style.display = 'none';
  }

  function hideResults() {
    const el = q('results');
    if (!el) return;
    el.style.display = 'none';
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
    const sym    = CURRENCY_SYMBOLS[accountCurrency] || (accountCurrency + ' ');
    const lotEl  = q('result-lot');
    const riskEl = q('result-risk');
    const rrEl   = q('result-rr');
    const slEl   = q('result-sl-pips');
    const tpEl   = q('result-tp-pips');
    const resEl  = q('results');
    if (!lotEl || !riskEl || !rrEl || !slEl || !tpEl || !resEl) return;

    lotEl.textContent  = result.lotSize.toFixed(2);
    riskEl.textContent = `${sym}${result.moneyAtRisk.toFixed(2)}`;
    rrEl.textContent   = `1 : ${result.rrRatio.toFixed(2)}`;
    slEl.textContent   = `${result.slPips.toFixed(1)} pips`;
    tpEl.textContent   = `${result.tpPips.toFixed(1)} pips`;
    resEl.style.display = '';
  }

  // ─────────────────────────────────────────────
  // Debug panel
  // ─────────────────────────────────────────────
  function toggleDebugPanel() {
    const panel = q('fx-debug-panel');
    if (!panel) return;
    const visible = panel.style.display !== 'none';
    if (visible) {
      panel.style.display = 'none';
    } else {
      refreshDebugPanel();
      panel.style.display = '';
    }
  }

  function refreshDebugPanel() {
    const panel = q('fx-debug-panel');
    const rows  = q('fx-debug-rows');
    if (!panel || !rows || panel.style.display === 'none') return;

    const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

    if (!lastDebugData) {
      rows.innerHTML = '<div style="font-size:10px;color:#787b86;text-align:center;padding:4px">Run a calculation first</div>';
      return;
    }

    const d   = lastDebugData;
    const sym = CURRENCY_SYMBOLS[d.accountCurrency] || (d.accountCurrency + ' ');

    const entries = [
      ['Pair',               d.pair],
      ['Base / Quote',       `${d.baseCurrency} / ${d.quoteCurrency}`],
      ['Account',            `${sym} ${d.accountCurrency}`],
      ['Pip case',           d.pipCase],
      ['Rate used',          d.rateUsed],
      ['Acct rate → USD',   `1 ${d.accountCurrency} = ${d.accountRateToUSD.toFixed(5)} USD`],
      ['Pip size',           d.pipSize],
      ['Pip val / lot (USD)', `$${d.pipValuePerLotUSD.toFixed(4)}`],
      ['Risk target',        `${sym}${d.riskAmountAccount.toFixed(2)}`],
      ['Risk in USD',        `$${d.riskAmountUSD.toFixed(4)}`],
      ['SL pips (raw)',      d.slPipsRaw.toFixed(2)],
      ['TP pips (raw)',      d.tpPipsRaw.toFixed(2)],
      ['Raw lot',            d.rawLot.toFixed(4)],
      ['Rounded lot',        d.lotSize.toFixed(2)],
      ['Actual risk (USD)',  `$${d.actualRiskUSD.toFixed(4)}`],
      ['Actual risk (acct)', `${sym}${d.moneyAtRisk.toFixed(2)}`],
    ];

    rows.innerHTML = entries.map(([k, v]) =>
      `<div class="fx-debug-row"><span class="fx-debug-key">${k}</span><span class="fx-debug-val">${v}</span></div>`
    ).join('');
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
