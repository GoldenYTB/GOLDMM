require('dotenv').config();
const { ethers } = require('ethers');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.BSC_RPC_URL);
}

function getContract(signerOrProvider) {
  return new ethers.Contract(process.env.USDT_BEP20_CONTRACT, ERC20_ABI, signerOrProvider);
}

async function getBalance(address) {
  const provider = getProvider();
  const contract = getContract(provider);
  const raw = await contract.balanceOf(address);
  return { balanceRaw: raw, balanceUSDT: Number(ethers.formatUnits(raw, 18)) };
}

async function getBnbBalance(address) {
  const provider = getProvider();
  const balanceWei = await provider.getBalance(address);
  return Number(ethers.formatEther(balanceWei));
}

// deposit addresses need a little BNB to pay gas before they can send the USDT out.
async function fundGas(hotWalletPrivateKey, toAddress, bnbAmount = '0.0015') {
  const provider = getProvider();
  const wallet = new ethers.Wallet(hotWalletPrivateKey, provider);
  const tx = await wallet.sendTransaction({ to: toAddress, value: ethers.parseEther(bnbAmount) });
  await tx.wait();
  return tx.hash;
}

async function sendUSDT(fromPrivateKey, toAddress, amount) {
  const provider = getProvider();
  const wallet = new ethers.Wallet(fromPrivateKey, provider);
  const contract = getContract(wallet);
  const raw = ethers.parseUnits(amount.toString(), 18);
  const tx = await contract.transfer(toAddress, raw);
  await tx.wait();
  return tx.hash;
}

module.exports = { getProvider, getBalance, getBnbBalance, fundGas, sendUSDT };
