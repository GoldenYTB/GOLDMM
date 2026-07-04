const fetch = require('node-fetch');
require('dotenv').config();
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const { LITECOIN_NETWORK } = require('./networks');

const ECPair = ECPairFactory(ecc);
const TOKEN = process.env.BLOCKCYPHER_TOKEN ? `token=${process.env.BLOCKCYPHER_TOKEN}` : '';
const API = 'https://api.blockcypher.com/v1/ltc/main';

function withToken(url) {
  if (!TOKEN) return url;
  return url + (url.includes('?') ? '&' : '?') + TOKEN;
}

async function getBalance(address) {
  const res = await fetch(withToken(`${API}/addrs/${address}/balance`));
  if (!res.ok) throw new Error(`BlockCypher error ${res.status}`);
  const data = await res.json();
  return {
    confirmedSats: data.balance,
    unconfirmedSats: data.unconfirmed_balance,
    confirmedLTC: data.balance / 1e8,
  };
}

async function getConfirmations(address) {
  const res = await fetch(withToken(`${API}/addrs/${address}`));
  if (!res.ok) throw new Error(`BlockCypher error ${res.status}`);
  const data = await res.json();
  if (data.unconfirmed_n_tx > 0 && data.n_tx === data.unconfirmed_n_tx) return 0;
  return data.confirmed_txrefs && data.confirmed_txrefs.length
    ? Math.min(...data.confirmed_txrefs.map(t => t.confirmations))
    : 0;
}

// Confirmed spendable UTXOs, with the output script attached so we can build witnessUtxo entries
async function getSpendableUTXOs(address) {
  const res = await fetch(withToken(`${API}/addrs/${address}?unspentOnly=true&includeScript=true&confirmations=1`));
  if (!res.ok) throw new Error(`BlockCypher error ${res.status}`);
  const data = await res.json();
  const refs = (data.txrefs || []).filter(r => r.confirmations >= 1 && !r.spent);
  return refs.map(r => ({
    txid: r.tx_hash,
    vout: r.tx_output_n,
    value: r.value,
    scriptHex: r.script,
  }));
}

async function getFeeRatePerByte() {
  const res = await fetch(withToken(API));
  if (!res.ok) return 20; // sane fallback sat/byte
  const data = await res.json();
  const perKb = data.medium_fee_per_kb || 20000;
  return Math.max(Math.ceil(perKb / 1000), 1);
}

function estimateVBytes(numInputs, numOutputs) {
  return numInputs * 68 + numOutputs * 31 + 10;
}

async function broadcastTx(hex) {
  const res = await fetch(withToken(`${API}/txs/push`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: hex }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Broadcast failed: ${JSON.stringify(data)}`);
  return data.tx.hash;
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
