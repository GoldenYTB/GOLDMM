const fetch = require('node-fetch');
const { COINS } = require('../config/coins');

const cache = {}; // coingeckoId -> { price, ts }
const CACHE_MS = 5 * 60 * 1000; // 5 minutes - plenty fresh for a USD trade quote

// Binance's public API has much more generous rate limits than CoinGecko's free tier and
// doesn't require a key. Used as a fallback when CoinGecko is unavailable/rate-limited.
const BINANCE_SYMBOLS = {
  BTC: 'BTCUSDT',
  LTC: 'LTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
};

async function fetchWithRetry(url, retries = 2, baseDelayMs = 1500) {
  let res;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch(url);
    if (res.status !== 429) return res;
    if (attempt < retries) await new Promise(r => setTimeout(r, baseDelayMs * (attempt + 1)));
  }
  return res;
}

async function getCoinGeckoPrice(id) {
  const res = await fetchWithRetry(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
  if (!res.ok) throw new Error(`CoinGecko error ${res.status}`);
  const data = await res.json();
  const price = data[id]?.usd;
  if (!price) throw new Error(`No USD price returned for ${id}`);
  return price;
}

async function getBinancePrice(coin) {
  const symbol = BINANCE_SYMBOLS[coin];
  if (!symbol) throw new Error(`No Binance symbol mapping for ${coin}`);
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance error ${res.status}`);
  const data = await res.json();
  const price = parseFloat(data.price);
  if (!price) throw new Error(`No USD price returned from Binance for ${symbol}`);
  return price;
}

async function getUsdPrice(coin) {
  // USDT is a stablecoin pegged to $1 - no need for an external lookup, and removes a
  // whole class of avoidable failures for that coin specifically.
  if (coin === 'USDT_BEP20') return 1.0;

  const id = COINS[coin].coingeckoId;
  const now = Date.now();
  if (cache[id] && now - cache[id].ts < CACHE_MS) return cache[id].price;

  // Try CoinGecko first
  try {
    const price = await getCoinGeckoPrice(id);
    cache[id] = { price, ts: now };
    return price;
  } catch (err) {
    console.warn(`[pricing] CoinGecko failed for ${id} (${err.message}), trying Binance...`);
  }

  // CoinGecko failed - try Binance as an independent fallback
  try {
    const price = await getBinancePrice(coin);
    cache[id] = { price, ts: now };
    return price;
  } catch (err) {
    console.warn(`[pricing] Binance fallback also failed for ${coin} (${err.message})`);
  }

  // Both live sources failed - a stale price is far better than blocking the trade entirely
  if (cache[id]) {
    console.warn(`[pricing] using stale cached price for ${id} from ${Math.round((now - cache[id].ts) / 1000)}s ago`);
    return cache[id].price;
  }

  throw new Error(`Could not get a USD price for ${coin} from any source`);
}

module.exports = { getUsdPrice };
