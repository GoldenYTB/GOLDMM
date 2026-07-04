require('dotenv').config();
const { query, logEvent } = require('./db');
const { COINS, REQUIRED_CONFIRMATIONS } = require('../config/coins');
const { calculateFee } = require('./fees');
const { sweepToHotWallet } = require('./payouts');
const btc = require('./chains/btc');
const ltc = require('./chains/ltc');
const eth = require('./chains/eth');
const bsc = require('./chains/bsc');
const sol = require('./chains/sol');
const { fundedActionRow } = require('./interactions');

const POLL_MS = 30_000;

async function checkDeposit(trade) {
  const { coin, deposit_address } = trade;
  if (coin === 'BTC') {
    const bal = await btc.getBalance(deposit_address);
    const confs = bal.confirmedSats > 0 ? await btc.getConfirmations(deposit_address) : 0;
    return { amount: bal.confirmedBTC, confirmations: confs, hasFunds: bal.confirmedSats > 0 };
  }
  if (coin === 'LTC') {
    const bal = await ltc.getBalance(deposit_address);
    const confs = bal.confirmedSats > 0 ? await ltc.getConfirmations(deposit_address) : 0;
    return { amount: bal.confirmedLTC, confirmations: confs, hasFunds: bal.confirmedSats > 0 };
  }
  if (coin === 'ETH') {
    const bal = await eth.getBalance(deposit_address);
    return { amount: bal.balanceETH, confirmations: bal.balanceETH > 0 ? REQUIRED_CONFIRMATIONS.ETH : 0, hasFunds: bal.balanceETH > 0 };
  }
  if (coin === 'USDT_BEP20') {
    const bal = await bsc.getBalance(deposit_address);
    return { amount: bal.balanceUSDT, confirmations: bal.balanceUSDT > 0 ? REQUIRED_CONFIRMATIONS.USDT_BEP20 : 0, hasFunds: bal.balanceUSDT > 0 };
  }
  if (coin === 'SOL') {
    const bal = await sol.getBalance(deposit_address);
    return { amount: bal.sol, confirmations: bal.sol > 0 ? 1 : 0, hasFunds: bal.sol > 0 };
  }
  throw new Error(`Unsupported coin: ${coin}`);
}

async function processPendingTrades(client) {
  const { rows } = await query(
    `SELECT * FROM trades WHERE status = 'pending' AND deposit_address IS NOT NULL`
  );

  for (const trade of rows) {
    try {
      const result = await checkDeposit(trade);
      if (!result.hasFunds) continue;

      const requiredConfs = REQUIRED_CONFIRMATIONS[trade.coin];
      if (result.confirmations < requiredConfs) continue; // still waiting

      const { usdValue, feePercent, feeAmount, netAmount } = await calculateFee(trade.coin, result.amount);

      const swept = await sweepToHotWallet(trade.coin, trade.id);

      await query(
        `UPDATE trades SET status='funded', amount_received=$1, usd_value_at_deposit=$2,
         fee_percent=$3, fee_amount=$4, swept_tx_hash=$5, funded_at=now() WHERE id=$6`,
        [result.amount, usdValue, feePercent, feeAmount, swept.txHash, trade.id]
      );
      await logEvent(trade.id, 'deposit_confirmed', 'system', `${result.amount} ${trade.coin} (~$${usdValue.toFixed(2)}), fee ${(feePercent * 100).toFixed(0)}%`);

      if (trade.channel_id) {
        const channel = await client.channels.fetch(trade.channel_id).catch(() => null);
        if (channel) {
          channel.send({
            content:
              `💰 Deposit confirmed: **${result.amount} ${COINS[trade.coin].symbol}** (~$${usdValue.toFixed(2)})\n` +
              `Fee: ${(feePercent * 100).toFixed(0)}% (${feeAmount.toFixed(8)} ${COINS[trade.coin].symbol}) — net payout: **${netAmount.toFixed(8)} ${COINS[trade.coin].symbol}**\n\n` +
              `<@${trade.sender_id}>, once you've received your side of the deal, hit **Release Funds**. Either party can agree to cancel or flag a dispute.`,
            components: [fundedActionRow(trade.id)],
          });
        }
      }
    } catch (err) {
      console.error(`[monitor] trade ${trade.id} error:`, err.message);
    }
  }
}

function startMonitor(client) {
  setInterval(() => processPendingTrades(client).catch(e => console.error('[monitor] loop error:', e)), POLL_MS);
  console.log(`[monitor] polling pending trades every ${POLL_MS / 1000}s`);
}

module.exports = { startMonitor, processPendingTrades, checkDeposit };
