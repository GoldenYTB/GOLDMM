const fetch = require('node-fetch');
require('dotenv').config();
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const { LITECOIN_NETWORK } = require('./networks');

const ECPair = ECPairFactory(ecc);

// Alchemy's UTXO API handles balance/confirmations/UTXO/broadcast lookups. Free tier is
// 30M compute units/month with no daily cap — far more headroom than BlockCypher's free
// 2,000/day, which is what was causing 429 rate-limit errors during normal polling.
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || 'docs-demo'; // demo key is heavily rate-limited, get your own free key at alchemy.com
const ALCHEMY_BASE = `https://litecoin-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}/api/v2`;

// Fee-rate estimation stays on BlockCypher's endpoint since it's only called once per
// sweep/payout (not every 30s poll cycle), so it doesn't hit the same rate limits that
// balance-polling used to. Still uses your token if you have one.
const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN ? `token=${process.env.BLOCKCYPHER_TOKEN}` : '';
const BLOCKCYPHER_API = 'https://api.blockcypher.com/v1/ltc/main';

async function getBalance(address) {
  const res = await fetch(`${ALCHEMY_BASE}/address/${address}`);
  if (!res.ok) throw new Error(`Alchemy error ${res.status}`);
  const data = await res.json();
  const confirmedSats = parseInt(data.balance, 10) || 0;
  const unconfirmedSats = parseInt(data.unconfirmedBalance, 10) || 0;
  return {
    confirmedSats,
    unconfirmedSats,
    confirmedLTC: confirmedSats / 1e8,
  };
}

async function getConfirmations(address) {
  const res = await fetch(`${ALCHEMY_BASE}/utxo/${address}?confirmed=true`);
  if (!res.ok) throw new Error(`Alchemy error ${res.status}`);
  const utxos = await res.json();
  if (!utxos.length) return 0;
  return Math.min(...utxos.map(u => u.confirmations));
}

// Confirmed spendable UTXOs. Alchemy doesn't return the output script directly, so we
// reconstruct it ourselves from the address — reliable since we generated the address
// ourselves and know its exact type (P2WPKH).
async function getSpendableUTXOs(address) {
  const res = await fetch(`${ALCHEMY_BASE}/utxo/${address}?confirmed=true`);
  if (!res.ok) throw new Error(`Alchemy error ${res.status}`);
  const utxos = await res.json();
  const outputScript = bitcoin.address.toOutputScript(address, LITECOIN_NETWORK).toString('hex');
  return utxos
    .filter(u => u.confirmations >= 1)
    .map(u => ({
      txid: u.txid,
      vout: u.vout,
      value: parseInt(u.value, 10),
      scriptHex: outputScript,
    }));
}

async function getFeeRatePerByte() {
  try {
    const url = BLOCKCYPHER_TOKEN ? `${BLOCKCYPHER_API}?${BLOCKCYPHER_TOKEN}` : BLOCKCYPHER_API;
    const res = await fetch(url);
    if (!res.ok) return 20; // sane fallback sat/byte
    const data = await res.json();
    const perKb = data.medium_fee_per_kb || 20000;
    return Math.max(Math.ceil(perKb / 1000), 1);
  } catch (e) {
    return 20; // never let a fee-lookup hiccup block a sweep/payout entirely
  }
}

function estimateVBytes(numInputs, numOutputs) {
  return numInputs * 68 + numOutputs * 31 + 10;
}

async function broadcastTx(hex) {
  const res = await fetch(`${ALCHEMY_BASE}/sendtx/${hex}`);
  const data = await res.json();
  if (!res.ok || !data.result) throw new Error(`Broadcast failed: ${JSON.stringify(data)}`);
  return data.result;
}

// Selects UTXOs up to targetSats + estimated fee. If targetSats is null, selects ALL utxos (sweep).
function selectUTXOs(utxos, targetSats, feeRatePerByte, numOutputs) {
  if (targetSats === null) {
    const total = utxos.reduce((s, u) => s + u.value, 0);
    const fee = estimateVBytes(utxos.length, numOutputs) * feeRatePerByte;
    return { selected: utxos, totalIn: total, fee };
  }
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  let selected = [];
  let totalIn = 0;
  for (const u of sorted) {
    selected.push(u);
    totalIn += u.value;
    const fee = estimateVBytes(selected.length, numOutputs) * feeRatePerByte;
    if (totalIn >= targetSats + fee) {
      return { selected, totalIn, fee };
    }
  }
  throw new Error('Insufficient confirmed UTXOs to cover amount + fee');
}

function buildAndSignPsbt({ utxos, fromWIF, outputs }) {
  const keyPair = ECPair.fromWIF(fromWIF, LITECOIN_NETWORK);
  const psbt = new bitcoin.Psbt({ network: LITECOIN_NETWORK });

  for (const u of utxos) {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: {
        script: Buffer.from(u.scriptHex, 'hex'),
        value: u.value,
      },
    });
  }
  for (const o of outputs) {
    psbt.addOutput({ address: o.address, value: o.value });
  }
  for (let i = 0; i < utxos.length; i++) {
    psbt.signInput(i, keyPair);
  }
  psbt.finalizeAllInputs();
  return psbt.extractTransaction().toHex();
}

// Sweep the FULL confirmed balance at `fromAddress` to `toAddress`. Moves a trade's
// deposit into the central hot wallet.
async function sweepAll(fromWIF, fromAddress, toAddress) {
  const utxos = await getSpendableUTXOs(fromAddress);
  if (!utxos.length) throw new Error('No spendable UTXOs found to sweep');
  const feeRate = await getFeeRatePerByte();
  const { selected, totalIn, fee } = selectUTXOs(utxos, null, feeRate, 1);
  const sendValue = totalIn - fee;
  if (sendValue <= 0) throw new Error('Balance too small to cover network fee');

  const hex = buildAndSignPsbt({
    utxos: selected,
    fromWIF,
    outputs: [{ address: toAddress, value: sendValue }],
  });
  const txHash = await broadcastTx(hex);
  return { txHash, amountSwept: sendValue / 1e8, feeSats: fee };
}

// Send a specific LTC amount from `fromAddress` (hot wallet) to `toAddress`, with any
// change returned to `fromAddress`. Used for release payouts and cancel refunds.
async function sendLTC(fromWIF, fromAddress, toAddress, amountLTC) {
  const targetSats = Math.round(amountLTC * 1e8);
  const utxos = await getSpendableUTXOs(fromAddress);
  if (!utxos.length) throw new Error('No spendable UTXOs in hot wallet');
  const feeRate = await getFeeRatePerByte();

  const { selected, totalIn, fee } = selectUTXOs(utxos, targetSats, feeRate, 2);
  const change = totalIn - targetSats - fee;

  const outputs = [{ address: toAddress, value: targetSats }];
  if (change > 546) { // dust threshold
    outputs.push({ address: fromAddress, value: change });
  }

  const hex = buildAndSignPsbt({ utxos: selected, fromWIF, outputs });
  const txHash = await broadcastTx(hex);
  return { txHash };
}

module.exports = {
  getBalance,
  getConfirmations,
  getSpendableUTXOs,
  getFeeRatePerByte,
  sweepAll,
  sendLTC,
  broadcastTx,
  buildAndSignPsbt,
  selectUTXOs,
};
