require('dotenv').config();
const { Connection, PublicKey, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');

function getConnection() {
  return new Connection(process.env.SOL_RPC_URL, 'confirmed');
}

async function getBalance(address) {
  const connection = getConnection();
  const lamports = await connection.getBalance(new PublicKey(address));
  return { lamports, sol: lamports / LAMPORTS_PER_SOL };
}

async function sendSOL(fromSecretKeyHex, toAddress, amountSol) {
  const connection = getConnection();
  const secretKey = Uint8Array.from(Buffer.from(fromSecretKeyHex, 'hex'));
  const fromKeypair = Keypair.fromSecretKey(secretKey);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: fromKeypair.publicKey, toPubkey: new PublicKey(toAddress), lamports })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [fromKeypair]);
  return sig;
}

module.exports = { getConnection, getBalance, sendSOL };
