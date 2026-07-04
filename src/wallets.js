require('dotenv').config();
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const bitcoin = require('bitcoinjs-lib');
const { ECPairFactory } = require('ecpair');
const { ethers } = require('ethers');
const { Keypair } = require('@solana/web3.js');
const { derivePath } = require('ed25519-hd-key');
const { LITECOIN_NETWORK } = require('./chains/networks');

const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

function getSeed() {
  const mnemonic = process.env.MASTER_MNEMONIC;
  if (!mnemonic) throw new Error('MASTER_MNEMONIC not set in .env - run `node src/gen-mnemonic.js` first');
  return bip39.mnemonicToSeedSync(mnemonic);
}


// index = trades.id (unique per trade, safe as a non-hardened derivation index)

function deriveBTC(index) {
  const root = bip32.fromSeed(getSeed(), bitcoin.networks.bitcoin);
  const child = root.derivePath(`m/84'/0'/0'/0/${index}`);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: bitcoin.networks.bitcoin });
  return { address, privateKeyWIF: child.toWIF(), path: `m/84'/0'/0'/0/${index}` };
}

function deriveLTC(index) {
  const root = bip32.fromSeed(getSeed(), LITECOIN_NETWORK);
  const child = root.derivePath(`m/84'/2'/0'/0/${index}`);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: LITECOIN_NETWORK });
  return { address, privateKeyWIF: child.toWIF(LITECOIN_NETWORK), path: `m/84'/2'/0'/0/${index}` };
}

// Shared by ETH and USDT_BEP20 (BSC) since both are EVM secp256k1 addresses
function deriveEVM(index) {
  const seed = getSeed();
  const root = ethers.HDNodeWallet.fromSeed(seed);
  const child = root.derivePath(`m/44'/60'/0'/0/${index}`);
  return { address: child.address, privateKey: child.privateKey, path: `m/44'/60'/0'/0/${index}` };
}

function deriveSOL(index) {
  const seed = getSeed();
  const { key } = derivePath(`m/44'/501'/${index}'/0'`, seed.toString('hex'));
  const keypair = Keypair.fromSeed(key);
  return { address: keypair.publicKey.toBase58(), secretKey: Buffer.from(keypair.secretKey).toString('hex'), path: `m/44'/501'/${index}'/0'` };
}

// coin: BTC | LTC | ETH | SOL | USDT_BEP20
function deriveAddress(coin, index) {
  switch (coin) {
    case 'BTC': return deriveBTC(index);
    case 'LTC': return deriveLTC(index);
    case 'ETH': return deriveEVM(index);
    case 'USDT_BEP20': return deriveEVM(index);
    case 'SOL': return deriveSOL(index);
    default: throw new Error(`Unsupported coin: ${coin}`);
  }
}

module.exports = { deriveAddress, deriveBTC, deriveLTC, deriveEVM, deriveSOL };
