// Run once: node src/gen-mnemonic.js
// Copy the output into MASTER_MNEMONIC in your .env, then delete this output from your terminal history.
const bip39 = require('bip39');
const mnemonic = bip39.generateMnemonic(256); // 24 words
console.log('\nMASTER MNEMONIC (store offline, never commit, never share):\n');
console.log(mnemonic);
console.log('\nAdd this to your .env as MASTER_MNEMONIC="..."\n');
