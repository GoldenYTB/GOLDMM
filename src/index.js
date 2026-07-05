require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const bip39 = require('bip39');
const mm = require('./commands/mm');
const interactions = require('./interactions');
const { startMonitor } = require('./monitor');
const { registerCommands } = require('./deploy-commands');
const { initSchema } = require('./db');
const { logAllHotWallets } = require('./payouts');

if (!process.env.MASTER_MNEMONIC) {
  const generated = bip39.generateMnemonic(256);
  console.log('\n\n===================================================================');
  console.log('MASTER_MNEMONIC is not set. Generated a new one for you below.');
  console.log('Copy this into your Render Environment tab as MASTER_MNEMONIC, save,');
  console.log('and it will redeploy automatically. This value is only shown once —');
  console.log('back it up somewhere offline. The bot will not start until it is set.');
  console.log('===================================================================\n');
  console.log(generated);
  console.log('\n===================================================================\n\n');
  const app = express();
  app.get('/', (req, res) => res.send('GoldMM is waiting for MASTER_MNEMONIC to be set — check the Logs tab.'));
  app.listen(process.env.PORT || 3000, () => console.log(`Health server on port ${process.env.PORT || 3000} (waiting for MASTER_MNEMONIC)`));
  return; // eslint-disable-line
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function tradeIdFrom(customId) {
  return parseInt(customId.split('_').pop(), 10);
}

client.once('ready', async () => {
  console.log(`GoldMM online as ${client.user.tag}`);
  try {
    await initSchema();
  } catch (err) {
    console.error('[startup] FATAL: could not verify/create database schema:', err.message);
    console.error('[startup] Check DATABASE_URL is correct. The bot will not function correctly without this.');
  }
  try {
    await logAllHotWallets();
  } catch (err) {
    console.error('[startup] failed to log hot wallet addresses:', err.message);
  }
  try {
    await registerCommands();
  } catch (err) {
    console.error('[startup] failed to register commands:', err.message);
  }
  startMonitor(client);
});

// Belt-and-braces: never let one bad interaction take the whole process down.
process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection - bot stayed alive]', err);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'mm') {
      const sub = interaction.options.getSubcommand();
      const group = interaction.options.getSubcommandGroup(false);

      if (!group && sub === 'panel') { await mm.handlePanel(interaction); return; }
      if (group === 'admin' && sub === 'resolve') { await mm.handleAdminResolve(interaction); return; }
      if (group === 'admin' && sub === 'status') { await mm.handleAdminStatus(interaction); return; }
      if (group === 'admin' && sub === 'wallet') { await mm.handleAdminWallet(interaction); return; }
      if (group === 'admin' && sub === 'withdraw') { await mm.handleAdminWithdraw(interaction); return; }
      if (group === 'admin' && sub === 'addresses') { await mm.handleAdminAddresses(interaction); return; }
      await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'panel_coin_select') {
      await interactions.handleCoinSelect(interaction);
      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('claim_sender_')) { await interactions.handleClaimRole(interaction, tradeIdFrom(id), 'sender'); return; }
      if (id.startsWith('claim_receiver_')) { await interactions.handleClaimRole(interaction, tradeIdFrom(id), 'receiver'); return; }
      if (id.startsWith('enter_amount_')) { await interactions.openAmountModal(interaction, tradeIdFrom(id)); return; }
      if (id.startsWith('confirm_amount_')) { await interactions.handleConfirmAmount(interaction, tradeIdFrom(id)); return; }
      if (id.startsWith('copy_info_')) { await interactions.handleCopyInfo(interaction, tradeIdFrom(id)); return; }
      if (id.startsWith('submit_address_')) { await interactions.openAddressModal(interaction, tradeIdFrom(id)); return; }
      if (id.startsWith('release_')) { await interactions.handleRelease(interaction, tradeIdFrom(id)); return; }
      if (id.startsWith('agree_cancel_')) { await interactions.handleAgreeCancel(interaction, tradeIdFrom(id)); return; }
      if (id.startsWith('dispute_')) { await interactions.handleDispute(interaction, tradeIdFrom(id)); return; }
      if (id.startsWith('admin_release_')) { await interactions.handleAdminAction(interaction, tradeIdFrom(id), 'release'); return; }
      if (id.startsWith('admin_refund_')) { await interactions.handleAdminAction(interaction, tradeIdFrom(id), 'refund'); return; }
    }

    if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      if (id.startsWith('ticket_modal_')) { await interactions.handleTicketModalSubmit(interaction, id.replace('ticket_modal_', '')); return; }
      if (id.startsWith('amount_modal_')) { await interactions.handleAmountModalSubmit(interaction, tradeIdFrom(id)); return; }
      if (id.startsWith('address_modal_')) { await interactions.handleAddressModalSubmit(interaction, tradeIdFrom(id)); return; }
    }
  } catch (err) {
    console.error('[interaction error]', err);
    const payload = { content: `Something went wrong: ${err.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);

// Dummy health server so Render's free-tier web service doesn't idle/timeout the process
const app = express();
app.get('/', (req, res) => res.send('GoldMM is running.'));
app.listen(process.env.PORT || 3000, () => console.log(`Health server on port ${process.env.PORT || 3000}`));
