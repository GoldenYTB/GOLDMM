const fetch = require('node-fetch');
const { COINS } = require('../config/coins');

const cache = {}; // coingeckoId -> { price, ts }
const CACHE_MS = 5 * 60 * 1000; // 5 minutes - plenty fresh for a USD trade quote, and cuts
                                 // request volume enough to avoid CoinGecko's free-tier 429s

async function fetchWithRetry(url, retries = 2, baseDelayMs = 1500) {
  let res;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch(url);
    if (res.status !== 429) return res;
    if (attempt < retries) await new Promise(r => setTimeout(r, baseDelayMs * (attempt + 1)));
  }
  return res; // still 429 after retries - let the caller decide what to do
}

async function getUsdPrice(coin) {
  const id = COINS[coin].coingeckoId;
  const now = Date.now();
  if (cache[id] && now - cache[id].ts < CACHE_MS) return cache[id].price;

  try {
    const res = await fetchWithRetry(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (!res.ok) throw new Error(`CoinGecko error ${res.status}`);
    const data = await res.json();
    const price = data[id]?.usd;
    if (!price) throw new Error(`No USD price returned for ${id}`);
    cache[id] = { price, ts: now };
    return price;
  } catch (err) {
    // If CoinGecko is down/rate-limited but we have ANY previous price for this coin,
    // use it rather than blocking the trade entirely - a few-minutes-stale price is far
    // better than a hard failure mid-trade for a USD quote.
    if (cache[id]) {
      console.warn(`[pricing] ${id} lookup failed (${err.message}), using stale cached price from ${Math.round((now - cache[id].ts) / 1000)}s ago`);
      return cache[id].price;
    }
    throw err;
  }
}

module.exports = { getUsdPrice };
