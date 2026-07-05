const fetch = require('node-fetch');

// Returns { confirmedSats, unconfirmedSats, confirmations (of oldest relevant tx, approx) }
async function getBalance(address) {
  const res = await fetch(`https://blockstream.info/api/address/${address}`);
  if (!res.ok) throw new Error(`Blockstream error ${res.status}`);
  const data = await res.json();
  const confirmedSats = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
  const unconfirmedSats = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
  return { confirmedSats, unconfirmedSats, confirmedBTC: confirmedSats / 1e8 };
}

async function getConfirmations(address) {
  const res = await fetch(`https://blockstream.info/api/address/${address}/txs`);
  if (!res.ok) throw new Error(`Blockstream error ${res.status}`);
  const txs = await res.json();
  if (!txs.length) return 0;
  const tipRes = await fetch('https://blockstream.info/api/blocks/tip/height');
  const tipHeight = parseInt(await tipRes.text(), 10);
  const heights = txs.filter(t => t.status.confirmed).map(t => t.status.block_height);
  if (!heights.length) return 0;
  const minHeight = Math.min(...heights);
  return tipHeight - minHeight + 1;
}

module.exports = { getBalance, getConfirmations };
