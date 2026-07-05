require('dotenv').config();
const { deriveAddress, deriveEVM } = require('./wallets');
const eth = require('./chains/eth');
const bsc = require('./chains/bsc');
const sol = require('./chains/sol');
const ltc = require('./chains/ltc');

const btc = require('./chains/btc');
const { logWalletAddress } = require('./db');
const { COINS } = require('../config/coins');

const HOT_INDEX = parseInt(process.env.HOT_WALLET_INDEX || '0', 10);

function hotWalletFor(coin) {
  // BTC/LTC/SOL each need their own hot wallet keypair at a fixed index.
  // ETH and USDT_BEP20 share the same EVM key.
  if (coin === 'USDT_BEP20') return deriveEVM(HOT_INDEX);
  return deriveAddress(coin, HOT_INDEX);
}

// Records every hot wallet address into the durable wallet_log table. Safe to call
// repeatedly (e.g. every startup) — ON CONFLICT DO NOTHING keeps the first record.
async function logAllHotWallets() {
  for (const coin of Object.keys(COINS)) {
    const hot = hotWalletFor(coin);
    await logWalletAddress(coin, HOT_INDEX, hot.address, 'hot_wallet', null);
    console.log(`[wallets] ${coin} hot wallet: ${hot.address}`);
  }
}

// Check how much is currently sitting in the hot wallet for a given coin
async function getHotWalletBalance(coin) {
  const hot = hotWalletFor(coin);
  if (coin === 'BTC') {
    const bal = await btc.getBalance(hot.address);
    return { address: hot.address, balance: bal.confirmedBTC };
  }
  if (coin === 'LTC') {
    const bal = await ltc.getBalance(hot.address);
    return { address: hot.address, balance: bal.confirmedLTC };
  }
  if (coin === 'ETH') {
    const bal = await eth.getBalance(hot.address);
    return { address: hot.address, balance: bal.balanceETH };
  }
  if (coin === 'USDT_BEP20') {
    const bal = await bsc.getBalance(hot.address);
    return { address: hot.address, balance: bal.balanceUSDT };
  }
  if (coin === 'SOL') {
    const bal = await sol.getBalance(hot.address);
    return { address: hot.address, balance: bal.sol };
  }
  throw new Error(`Unsupported coin: ${coin}`);
}

// Sweep the full balance sitting at a trade's deposit address into the central hot wallet.
// Returns { txHash, amountSwept }
async function sweepToHotWallet(coin, tradeIndex) {
  const hot = hotWalletFor(coin);
  const deposit = coin === 'USDT_BEP20' ? deriveEVM(tradeIndex) : deriveAddress(coin, tradeIndex);

  if (coin === 'BTC') {
    // Placeholder: BTC UTXO sweep needs a PSBT built from deposit's UTXOs via bitcoinjs-lib.
    // Wire this to Blockstream's UTXO endpoint + fee estimate before going live with real BTC.
    throw new Error('BTC sweep not yet implemented - see TODO in payouts.js');
  }
  if (coin === 'LTC') {
    const swept = await ltc.sweepAll(deposit.privateKeyWIF, deposit.address, hot.address);
    return { txHash: swept.txHash, amountSwept: swept.amountSwept };
  }
  if (coin === 'ETH') {
    const txHash = await eth.sendETH(deposit.privateKey, hot.address); // sweeps balance minus gas
    return { txHash };
  }
  if (coin === 'USDT_BEP20') {
    // deposit address needs a little BNB first to pay for the transfer's gas
    await bsc.fundGas(hot.privateKey, deposit.address);
    const balance = await bsc.getBalance(deposit.address);
    const txHash = await bsc.sendUSDT(deposit.privateKey, hot.address, balance.balanceUSDT);
    return { txHash, amountSwept: balance.balanceUSDT };
  }
  if (coin === 'SOL') {
    const balance = await sol.getBalance(deposit.address);
    const rentExempt = 0.00089088; // approx min lamport reserve, leave a hair for fee
    const sendable = Math.max(balance.sol - rentExempt - 0.000005, 0);
    const txHash = await sol.sendSOL(deposit.secretKey, hot.address, sendable);
    return { txHash, amountSwept: sendable };
  }
  throw new Error(`Unsupported coin for sweep: ${coin}`);
}

// Pay out `amount` of `coin` from the hot wallet to `toAddress`
async function payout(coin, toAddress, amount) {
  const hot = coin === 'USDT_BEP20' ? deriveEVM(HOT_INDEX) : deriveAddress(coin, HOT_INDEX);
  if (coin === 'ETH') return eth.sendETH(hot.privateKey, toAddress, amount);
  if (coin === 'USDT_BEP20') return bsc.sendUSDT(hot.privateKey, toAddress, amount);
  if (coin === 'SOL') return sol.sendSOL(hot.secretKey, toAddress, amount);
  if (coin === 'LTC') {
    const sent = await ltc.sendLTC(hot.privateKeyWIF, hot.address, toAddress, amount);
    return sent.txHash;
  }
  if (coin === 'BTC') throw new Error(`${coin} payout not yet implemented - see TODO in payouts.js`);
  throw new Error(`Unsupported coin for payout: ${coin}`);
}

module.exports = { hotWalletFor, getHotWalletBalance, sweepToHotWallet, payout, logAllHotWallets };
