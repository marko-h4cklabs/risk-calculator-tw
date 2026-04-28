// All position-size math lives here. No DOM access.
const Calculator = (() => {
  const STANDARD_LOT = 100_000;

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
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // API returns: rates[X] = how many X per 1 USD
    return { USD: 1, ...data.rates };
  }

  // manualRates keys use the API convention: how many of that currency per 1 USD.
  // UI is responsible for converting user-friendly inputs before passing in.
  async function calculate({ entry, sl, tp, pair, accountSize, accountCurrency, riskPct, manualRates = {} }) {
    const pipSize = getPipSize(pair);
    const quoteCurrency = getQuoteCurrency(pair);

    const slPips  = Math.abs(entry - sl)  / pipSize;
    const tpPips  = Math.abs(tp   - entry) / pipSize;
    const rrRatio = tpPips / slPips;

    // Risk in account currency — this is exact by definition
    const riskAmountAccount = accountSize * (riskPct / 100);

    // Build rates — seed with manual overrides; fetch live rates if any are still missing
    let rates = { USD: 1, ...manualRates };

    const needsQuoteRate = quoteCurrency !== 'USD' && !rates[quoteCurrency];
    const needsAcctRate  = accountCurrency !== 'USD' && !rates[accountCurrency];

    if (needsQuoteRate || needsAcctRate) {
      try {
        const fetched = await fetchRates();
        // Manual overrides take precedence over API values
        rates = { ...fetched, ...manualRates };
      } catch {
        // API failed; see if manual rates cover what we need
        const missing = [];
        if (quoteCurrency !== 'USD' && !rates[quoteCurrency]) {
          missing.push({
            currency: quoteCurrency,
            // Ask for USD → quote direction (e.g. "1 USD = 150 JPY")
            label: `1 USD = ??? ${quoteCurrency} (e.g. USDJPY → 150)`,
            direction: 'usdToQuote',
          });
        }
        if (accountCurrency !== 'USD' && !rates[accountCurrency]) {
          missing.push({
            currency: accountCurrency,
            // Ask for account → USD direction (e.g. "1 EUR = 1.08 USD")
            label: `1 ${accountCurrency} = ??? USD (e.g. EURUSD → 1.08)`,
            direction: 'acctToUSD',
          });
        }
        if (missing.length > 0) {
          throw { type: 'RATE_ERROR', missing, message: 'Exchange rate API unavailable. Enter rates manually.' };
        }
      }
    }

    // Pip value per standard lot in USD
    // pip value in quote currency = STANDARD_LOT × pipSize
    // convert to USD: divide by rates[quoteCurrency] (quote units per 1 USD)
    const pipValuePerLotUSD = (STANDARD_LOT * pipSize) / rates[quoteCurrency];

    // Risk amount in USD
    // rates[accountCurrency] = account-currency units per 1 USD
    // → 1 account-currency unit = 1/rates[accountCurrency] USD
    const riskAmountUSD = riskAmountAccount / rates[accountCurrency];

    const rawLot = riskAmountUSD / (slPips * pipValuePerLotUSD);

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
