const fetch = require('node-fetch');
const { COINS } = require('../config/coins');

const cache = {}; // coingeckoId -> { price, ts }
const CACHE_MS = 30_000;

async function getUsdPrice(coin) {
  const id = COINS[coin].coingeckoId;
  const now = Date.now();
  if (cache[id] && now - cache[id].ts < CACHE_MS) return cache[id].price;

  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
  if (!res.ok) throw new Error(`CoinGecko error ${res.status}`);
  const data = await res.json();
  const price = data[id]?.usd;
  if (!price) throw new Error(`No USD price returned for ${id}`);
  cache[id] = { price, ts: now };
  return price;
}

module.exports = { getUsdPrice };
