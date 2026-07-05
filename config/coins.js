module.exports = {
  COINS: {
    BTC: { label: 'Bitcoin', symbol: 'BTC', decimals: 8, coingeckoId: 'bitcoin', chain: 'btc' },
    LTC: { label: 'Litecoin', symbol: 'LTC', decimals: 8, coingeckoId: 'litecoin', chain: 'ltc' },
    ETH: { label: 'Ethereum', symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum', chain: 'eth' },
    SOL: { label: 'Solana', symbol: 'SOL', decimals: 9, coingeckoId: 'solana', chain: 'sol' },
    USDT_BEP20: { label: 'USDT (BEP20)', symbol: 'USDT', decimals: 18, coingeckoId: 'tether', chain: 'bsc', isToken: true },
  },
  // confirmations required before a deposit is considered final
  REQUIRED_CONFIRMATIONS: {
    BTC: 2,
    LTC: 4,
    ETH: 12,
    SOL: 1, // finalized commitment
    USDT_BEP20: 15,
  },
};
