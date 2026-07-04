require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const mm = require('./commands/mm');
const interactions = require('./interactions');
const { startMonitor } = require('./monitor');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function tradeIdFrom(customId) {
  return parseInt(customId.split('_').pop(), 10);
}

client.once('ready', () => {
  console.log(`GoldMM online as ${client.user.tag}`);
  startMonitor(client);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'mm') {
      const sub = interaction.options.getSubcommand();
      const group = interaction.options.getSubcommandGroup(false);

      if (!group && sub === 'panel') return mm.handlePanel(interaction);
      if (group === 'admin' && sub === 'resolve') return mm.handleAdminResolve(interaction);
      if (group === 'admin' && sub === 'status') return mm.handleAdminStatus(interaction);
      return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'panel_coin_select') {
      return interactions.handleCoinSelect(interaction);
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('claim_sender_')) return interactions.handleClaimRole(interaction, tradeIdFrom(id), 'sender');
      if (id.startsWith('claim_receiver_')) return interactions.handleClaimRole(interaction, tradeIdFrom(id), 'receiver');
      if (id.startsWith('enter_amount_')) return interactions.openAmountModal(interaction, tradeIdFrom(id));
      if (id.startsWith('confirm_amount_')) return interactions.handleConfirmAmount(interaction, tradeIdFrom(id));
      if (id.startsWith('copy_info_')) return interactions.handleCopyInfo(interaction, tradeIdFrom(id));
      if (id.startsWith('submit_address_')) return interactions.openAddressModal(interaction, tradeIdFrom(id));
      if (id.startsWith('release_')) return interactions.handleRelease(interaction, tradeIdFrom(id));
      if (id.startsWith('agree_cancel_')) return interactions.handleAgreeCancel(interaction, tradeIdFrom(id));
      if (id.startsWith('dispute_')) return interactions.handleDispute(interaction, tradeIdFrom(id));
      if (id.startsWith('admin_release_')) return interactions.handleAdminAction(interaction, tradeIdFrom(id), 'release');
      if (id.startsWith('admin_refund_')) return interactions.handleAdminAction(interaction, tradeIdFrom(id), 'refund');
    }

    if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      if (id.startsWith('ticket_modal_')) return interactions.handleTicketModalSubmit(interaction, id.replace('ticket_modal_', ''));
      if (id.startsWith('amount_modal_')) return interactions.handleAmountModalSubmit(interaction, tradeIdFrom(id));
      if (id.startsWith('address_modal_')) return interactions.handleAddressModalSubmit(interaction, tradeIdFrom(id));
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
