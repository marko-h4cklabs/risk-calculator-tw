// All position-size math lives here. No DOM access.
const Calculator = (() => {
  const STANDARD_LOT = 100_000;
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  let _ratesCache     = null;
  let _ratesFetchedAt = 0;

  function getPipSize(pair) {
    return /JPY/i.test(pair) ? 0.01 : 0.0001;
  }

  function getBaseCurrency(pair) {
    return pair.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3);
  }

  function getQuoteCurrency(pair) {
    return pair.replace(/[^A-Za-z]/g, '').toUpperCase().slice(3, 6);
  }

  async function fetchRates() {
    const now = Date.now();
    if (_ratesCache && (now - _ratesFetchedAt) < CACHE_TTL_MS) return _ratesCache;
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // rates[X] = how many X per 1 USD
    _ratesCache     = { USD: 1, ...data.rates };
    _ratesFetchedAt = now;
    return _ratesCache;
  }

  // manualRates: { CURRENCY: X } where X = how many of that currency per 1 USD (API convention).
  // UI converts user-friendly inputs to this convention before passing in.
  async function calculate({ entry, sl, tp, pair, accountSize, accountCurrency, riskPct, manualRates = {} }) {
    const pipSize       = getPipSize(pair);
    const baseCurrency  = getBaseCurrency(pair);
    const quoteCurrency = getQuoteCurrency(pair);

    const slPipsRaw = Math.abs(entry - sl)  / pipSize;
    const tpPipsRaw = Math.abs(tp   - entry) / pipSize;
    const rrRatio   = tpPipsRaw / slPipsRaw;

    // ── Step 1: Risk amount in account currency ────────────────────────
    const riskAmountAccount = accountSize * (riskPct / 100);

    // ── Step 2: Determine which live rates are needed ──────────────────
    //
    // Pip value is always computed in USD first (3 cases based on pair structure):
    //   quoteIsUSD → pip value already in USD, no rate needed
    //   baseIsUSD  → use entry price as the implicit USD/QUOTE rate
    //   cross pair → need rates[quoteCurrency] to convert QUOTE → USD
    //
    // Account conversion: need rates[accountCurrency] whenever account ≠ USD,
    //   regardless of which pip-value case applies.
    const quoteIsUSD      = quoteCurrency    === 'USD';
    const baseIsUSD       = baseCurrency     === 'USD';
    const needPipRate     = !quoteIsUSD && !baseIsUSD;   // cross pair
    const needAccountRate = accountCurrency  !== 'USD';

    let rates = { USD: 1, ...manualRates };

    const missingFromRates =
      (needPipRate     && !rates[quoteCurrency])   ||
      (needAccountRate && !rates[accountCurrency]);

    if (missingFromRates) {
      try {
        const fetched = await fetchRates();
        rates = { ...fetched, ...manualRates }; // manual overrides win
      } catch (_fetchErr) {
        const missing = [];
        if (needPipRate && !rates[quoteCurrency]) {
          missing.push({
            currency:  quoteCurrency,
            label:     `Enter current USD → ${quoteCurrency} rate  (e.g. USDJPY → 150)`,
            direction: 'usdToQuote',
          });
        }
        if (needAccountRate && !rates[accountCurrency]) {
          missing.push({
            currency:  accountCurrency,
            label:     `Enter current ${accountCurrency} → USD rate  (e.g. EUR → 1.08)`,
            direction: 'acctToUSD',
          });
        }
        throw { type: 'RATE_ERROR', missing, message: 'Exchange rate API unavailable. Enter rates manually.' };
      }
    }

    // After fetching: verify required rates are actually in the response
    // (rare, but handles exotic currencies not covered by the free API tier)
    const stillMissing = [];
    if (needPipRate && !rates[quoteCurrency]) {
      stillMissing.push({
        currency:  quoteCurrency,
        label:     `${quoteCurrency} missing from API — enter USD → ${quoteCurrency}`,
        direction: 'usdToQuote',
      });
    }
    if (needAccountRate && !rates[accountCurrency]) {
      stillMissing.push({
        currency:  accountCurrency,
        label:     `${accountCurrency} missing from API — enter ${accountCurrency} → USD`,
        direction: 'acctToUSD',
      });
    }
    if (stillMissing.length > 0) {
      throw { type: 'RATE_ERROR', missing: stillMissing, message: 'Some rates missing from API. Enter manually.' };
    }

    // ── Step 3: Pip value per standard lot in USD ──────────────────────
    //
    // Case A — QUOTE is USD (EURUSD, GBPUSD, AUDUSD …):
    //   pip value in USD = STANDARD_LOT × pipSize  (already in USD)
    //
    // Case B — BASE is USD (USDJPY, USDCAD, USDCHF …):
    //   pip value in QUOTE = STANDARD_LOT × pipSize
    //   entry ≈ spot price (USD per QUOTE), so divide to get USD
    //   pip value in USD = STANDARD_LOT × pipSize / entry
    //
    // Case C — cross pair (GBPJPY, EURGBP, EURJPY …):
    //   pip value in QUOTE = STANDARD_LOT × pipSize
    //   rates[quoteCurrency] = QUOTE per 1 USD, so divide to get USD
    //   pip value in USD = STANDARD_LOT × pipSize / rates[quoteCurrency]
    let pipValuePerLotUSD;
    let pipCase;
    let rateUsed;

    if (quoteIsUSD) {
      pipValuePerLotUSD = STANDARD_LOT * pipSize;
      pipCase           = 'A — quote = USD';
      rateUsed          = 'n/a';
    } else if (baseIsUSD) {
      pipValuePerLotUSD = STANDARD_LOT * pipSize / entry;
      pipCase           = 'B — base = USD (entry price)';
      rateUsed          = `entry = ${entry}`;
    } else {
      const rQ          = rates[quoteCurrency];
      pipValuePerLotUSD = STANDARD_LOT * pipSize / rQ;
      pipCase           = `C — cross (${quoteCurrency}/USD via API)`;
      rateUsed          = `1 USD = ${rQ} ${quoteCurrency}`;
    }

    // ── Step 4: Convert risk amount to USD ─────────────────────────────
    // rates[accountCurrency] = accountCurrency per 1 USD
    // → 1 accountCurrency = 1 / rates[accountCurrency] USD
    const rA           = rates[accountCurrency] ?? 1; // 1 for USD accounts
    const riskAmountUSD = riskAmountAccount / rA;

    // ── Step 5: Lot size ───────────────────────────────────────────────
    const rawLot  = riskAmountUSD / (slPipsRaw * pipValuePerLotUSD);
    const lotSize = Math.round(rawLot * 100) / 100;

    // ── Step 6: Actual money at risk (post-rounding) in account currency
    // Lot rounding changes the realised risk slightly vs the target.
    const actualRiskUSD  = lotSize * slPipsRaw * pipValuePerLotUSD;
    const moneyAtRisk    = actualRiskUSD * rA;  // USD → account currency

    return {
      lotSize,
      moneyAtRisk,
      accountCurrency,
      rrRatio: Math.round(rrRatio   * 100) / 100,
      slPips:  Math.round(slPipsRaw * 10)  / 10,
      tpPips:  Math.round(tpPipsRaw * 10)  / 10,
      _debug: {
        pair,
        baseCurrency,
        quoteCurrency,
        accountCurrency,
        pipCase,
        pipSize,
        pipValuePerLotUSD,
        rateUsed,
        accountRateToUSD: 1 / rA,       // e.g. 1 EUR = 1.099 USD
        riskAmountAccount,
        riskAmountUSD,
        slPipsRaw,
        tpPipsRaw,
        rawLot,
        lotSize,
        actualRiskUSD,
        moneyAtRisk,
      },
    };
  }

  return { calculate, getPipSize, getQuoteCurrency, getBaseCurrency };
})();
