(() => {
  function toText(value) {
    if (value === 0 || value === false) return String(value);
    return String(value || '').trim();
  }

  function parseTestnetNumber(raw) {
    const text = toText(raw).toLowerCase();
    if (!text) return 0;
    if (text === 'testnet') return 10;
    if (text === 'tn10' || text === 'tn-10' || text === 'testnet-10' || text === 'testnet10') return 10;

    const tnMatch = text.match(/^tn-?(\d+)$/);
    if (tnMatch) return Number(tnMatch[1] || '0');

    const testnetMatch = text.match(/^testnet-?(\d+)$/);
    if (testnetMatch) return Number(testnetMatch[1] || '0');

    return 0;
  }

  function normalizeAppNetworkKey(raw) {
    const text = toText(raw).toLowerCase();
    if (!text) return '';
    if (text === 'mainnet') return 'mainnet';

    const testnetNumber = parseTestnetNumber(text);
    if (Number.isInteger(testnetNumber) && testnetNumber > 0) {
      return `tn${testnetNumber}`;
    }

    return '';
  }

  function buildNetworkMeta(appKey) {
    if (appKey === 'mainnet') {
      return Object.freeze({
        appKey: 'mainnet',
        displayLabel: 'Mainnet',
        addressPrefix: 'kaspa:',
        explorerBase: 'https://explorer.kaspa.org',
        walletNetworkLabel: 'mainnet',
        sdkNetworkId: 'mainnet',
        kasplexNetworkId: 'mainnet',
        isMainnet: true
      });
    }

    const tnMatch = String(appKey || '').match(/^tn(\d+)$/);
    if (!tnMatch) {
      return Object.freeze({
        appKey: '',
        displayLabel: '',
        addressPrefix: '',
        explorerBase: '',
        walletNetworkLabel: '',
        sdkNetworkId: '',
        kasplexNetworkId: '',
        isMainnet: false
      });
    }

    const testnetNumber = Number(tnMatch[1] || '0');
    const explorerBase = testnetNumber === 10 ? 'https://explorer-tn10.kaspa.org' : '';

    return Object.freeze({
      appKey: `tn${testnetNumber}`,
      displayLabel: `TN${testnetNumber}`,
      addressPrefix: 'kaspatest:',
      explorerBase,
      walletNetworkLabel: 'testnet',
      sdkNetworkId: `testnet-${testnetNumber}`,
      kasplexNetworkId: `testnet-${testnetNumber}`,
      isMainnet: false
    });
  }

  function getNetworkMeta(raw) {
    return buildNetworkMeta(normalizeAppNetworkKey(raw));
  }

  function getDisplayLabel(raw, fallback) {
    const meta = getNetworkMeta(raw);
    return meta.displayLabel || toText(fallback);
  }

  function getAddressPrefix(raw) {
    return getNetworkMeta(raw).addressPrefix;
  }

  function getExplorerBase(raw) {
    return getNetworkMeta(raw).explorerBase;
  }

  function getExplorerTxUrl(raw, txid) {
    const base = getExplorerBase(raw);
    const value = toText(txid);
    if (!base || !value) return '';
    return `${base}/txs/${encodeURIComponent(value)}`;
  }

  function getExplorerAddressUrl(raw, address) {
    const base = getExplorerBase(raw);
    const value = toText(address);
    if (!base || !value) return '';
    return `${base}/addresses/${encodeURIComponent(value)}`;
  }

  function isKaspaAddressForNetwork(address, raw) {
    const prefix = getAddressPrefix(raw).toLowerCase();
    const value = toText(address).toLowerCase();
    if (!prefix || !value) return false;
    return value.startsWith(prefix);
  }

  const api = Object.freeze({
    normalizeAppNetworkKey,
    getNetworkMeta,
    getDisplayLabel,
    getAddressPrefix,
    getExplorerBase,
    getExplorerTxUrl,
    getExplorerAddressUrl,
    isKaspaAddressForNetwork
  });

  if (typeof window !== 'undefined') {
    window.CwNetworkShared = api;
  }
})();
