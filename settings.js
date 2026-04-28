// Thin wrapper around chrome.storage.local
const Settings = (() => {
  const DEFAULTS = {
    accountSize: 10000,
    accountCurrency: 'USD',
    defaultRisk: 0.5,
  };

  function load() {
    return new Promise(resolve => chrome.storage.local.get(DEFAULTS, resolve));
  }

  function save(data) {
    return new Promise(resolve => chrome.storage.local.set(data, resolve));
  }

  return { load, save, DEFAULTS };
})();
