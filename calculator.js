// All position-size math lives here. No DOM access.
const Calculator = (() => {
  const STANDARD_LOT = 100_000;

  // Session-level rate cache so we don't fetch on every click
  let _ratesCache = null;

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
    if (_ratesCache) return _ratesCache;
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // API returns: rates[X] = how many X per 1 USD
    _ratesCache = { USD: 1, ...data.rates };
    return _ratesCache;
  }

  // manualRates keys use the API convention: how many of that currency per 1 USD.
  // UI is responsible for converting user-friendly inputs before passing in.
  async function calculate({ entry, sl, tp, pair, accountSize, accountCurrency, riskPct, manualRates = {} }) {
    const pipSize       = getPipSize(pair);
    const baseCurrency  = getBaseCurrency(pair);
    const quoteCurrency = getQuoteCurrency(pair);

    const slPips  = Math.abs(entry - sl)  / pipSize;
    const tpPips  = Math.abs(tp   - entry) / pipSize;
    const rrRatio = tpPips / slPips;

    // Risk in account currency — exact by definition
    const riskAmountAccount = accountSize * (riskPct / 100);

    // Determine which rates we need:
    //   Case 1: QUOTE === accountCurrency  → pip value is already in account currency, no rate needed
    //   Case 2: BASE  === accountCurrency  → need spot rate of the pair itself (entry price ≈ spot)
    //   Case 3: cross pair                 → need QUOTE/accountCurrency spot rate
    //
    // rates[X] = X per 1 USD  (API convention)
    // To convert X→Y: multiply by rates[Y] / rates[X]

    const case1 = quoteCurrency === accountCurrency;
    const case2 = baseCurrency  === accountCurrency;

    // For case 3 we need rates[quoteCurrency] and rates[accountCurrency]
    let rates = { USD: 1, ...manualRates };

    const needsQuoteRate = !case1 && !case2 && quoteCurrency !== 'USD' && !rates[quoteCurrency];
    const needsAcctRate  = !case1             && accountCurrency !== 'USD' && !rates[accountCurrency];

    if (needsQuoteRate || needsAcctRate) {
      try {
        const fetched = await fetchRates();
        rates = { ...fetched, ...manualRates };
      } catch {
        const missing = [];
        if (needsQuoteRate && !rates[quoteCurrency]) {
          missing.push({
            currency:  quoteCurrency,
            label:     `1 USD = ??? ${quoteCurrency}  (e.g. USDJPY → 150)`,
            direction: 'usdToQuote',
          });
        }
        if (needsAcctRate && !rates[accountCurrency]) {
          missing.push({
            currency:  accountCurrency,
            label:     `1 ${accountCurrency} = ??? USD  (e.g. EURUSD → 1.08)`,
            direction: 'acctToUSD',
          });
        }
        if (missing.length > 0) {
          throw { type: 'RATE_ERROR', missing, message: 'Exchange rate API unavailable. Enter rates manually.' };
        }
      }
    }

    // Pip value per standard lot in account currency
    // rates[X] = X per 1 USD, so:  1 unit of X = 1 / rates[X]  USD
    //                               1 unit of Y = 1 / rates[Y]  USD
    //                               1 X = rates[Y] / rates[X]   Y
    let pipValuePerLotAcct;
    if (case1) {
      // QUOTE === accountCurrency: pip value = pipSize × lot size (already in account currency)
      pipValuePerLotAcct = STANDARD_LOT * pipSize;
    } else if (case2) {
      // BASE === accountCurrency: pip value in quote currency, convert via current spot price
      // spot ≈ entry (mid-price); pipValue in base = pipSize × lot / entry
      pipValuePerLotAcct = STANDARD_LOT * pipSize / entry;
    } else {
      // Cross pair: pip value in quote currency; convert quote → accountCurrency
      // pipValueQuote = STANDARD_LOT × pipSize
      // pipValueAcct  = pipValueQuote × (1 / rates[quoteCurrency]) × rates[accountCurrency]
      //               = STANDARD_LOT × pipSize × rates[accountCurrency] / rates[quoteCurrency]
      const rQ = rates[quoteCurrency]   || 1;
      const rA = rates[accountCurrency] || 1;
      pipValuePerLotAcct = STANDARD_LOT * pipSize * rA / rQ;
    }

    const rawLot = riskAmountAccount / (slPips * pipValuePerLotAcct);

    return {
      lotSize:       Math.round(rawLot  * 100) / 100,
      moneyAtRisk:   riskAmountAccount,
      accountCurrency,
      rrRatio:       Math.round(rrRatio * 100) / 100,
      slPips:        Math.round(slPips  * 10)  / 10,
      tpPips:        Math.round(tpPips  * 10)  / 10,
    };
  }

  return { calculate, getPipSize, getQuoteCurrency, getBaseCurrency };
})();
