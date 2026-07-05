const { getUsdPrice } = require('./pricing');

// Tiers: <$10 free, $10-50 2%, $50-100 3%, $100+ 5%
function feePercentForUsd(usdValue) {
  if (usdValue < 10) return 0;
  if (usdValue < 50) return 0.02;
  if (usdValue < 100) return 0.03;
  return 0.05;
}

// amount: coin amount received (number). Returns { usdValue, feePercent, feeAmount, netAmount }
async function calculateFee(coin, amount) {
  const price = await getUsdPrice(coin);
  const usdValue = amount * price;
  const feePercent = feePercentForUsd(usdValue);
  const feeAmount = amount * feePercent;
  const netAmount = amount - feeAmount;
  return { usdValue, feePercent, feeAmount, netAmount, price };
}

module.exports = { feePercentForUsd, calculateFee };
