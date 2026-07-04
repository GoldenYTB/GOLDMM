require('dotenv').config();
const { ethers } = require('ethers');

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.ETH_RPC_URL);
}

async function getBalance(address) {
  const provider = getProvider();
  const balanceWei = await provider.getBalance(address);
  return { balanceWei, balanceETH: Number(ethers.formatEther(balanceWei)) };
}

async function getCurrentBlock() {
  const provider = getProvider();
  return provider.getBlockNumber();
}

// sweep/send native ETH. amountEth optional - if omitted sends max minus estimated gas
async function sendETH(fromPrivateKey, toAddress, amountEth) {
  const provider = getProvider();
  const wallet = new ethers.Wallet(fromPrivateKey, provider);
  const feeData = await provider.getFeeData();
  let value;
  if (amountEth) {
    value = ethers.parseEther(amountEth.toString());
  } else {
    const balance = await provider.getBalance(wallet.address);
    const gasLimit = 21000n;
    const gasCost = gasLimit * (feeData.maxFeePerGas || feeData.gasPrice);
    value = balance - gasCost;
    if (value <= 0n) throw new Error('Insufficient ETH balance to cover gas');
  }
  const tx = await wallet.sendTransaction({ to: toAddress, value });
  return tx.hash;
}

module.exports = { getProvider, getBalance, getCurrentBlock, sendETH };
