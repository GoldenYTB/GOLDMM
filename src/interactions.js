const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const QRCode = require('qrcode');
const { query, logEvent, logWalletAddress } = require('./db');
const { COINS } = require('../config/coins');
const { deriveAddress } = require('./wallets');
const { payout } = require('./payouts');
const { getUsdPrice } = require('./pricing');
const mm = require('./commands/mm');

async function getTrade(tradeId) {
  const { rows } = await query(`SELECT * FROM trades WHERE id=$1`, [tradeId]);
  return rows[0];
}

function isSetupParticipant(trade, userId) {
  return trade.initiator_id === userId || trade.counterparty_id === userId;
}

function isParticipant(trade, userId) {
  return trade.sender_id === userId || trade.receiver_id === userId;
}

// ---------- Step 1: claim sender/receiver roles ----------
async function handleClaimRole(interaction, tradeId, role) {
  const trade = await getTrade(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });
  if (!isSetupParticipant(trade, interaction.user.id)) return interaction.reply({ content: 'Not your trade.', ephemeral: true });
  if (trade.status !== 'setup') return interaction.reply({ content: 'Roles are already locked in for this trade.', ephemeral: true });

  const column = role === 'sender' ? 'sender_id' : 'receiver_id';
  const otherColumn = role === 'sender' ? 'receiver_id' : 'sender_id';

  if (trade[column] && trade[column] !== interaction.user.id) {
    return interaction.reply({ content: `Someone already claimed that role.`, ephemeral: true });
  }
  if (trade[otherColumn] === interaction.user.id) {
    return interaction.reply({ content: "You already claimed the other role. Can't be both.", ephemeral: true });
  }

  await query(`UPDATE trades SET ${column}=$1 WHERE id=$2`, [interaction.user.id, tradeId]);
  await logEvent(tradeId, 'role_claimed', interaction.user.id, role);

  const updated = await getTrade(tradeId);
  if (updated.sender_id && updated.receiver_id) {
    await query(`UPDATE trades SET status='awaiting_amount' WHERE id=$1`, [tradeId]);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`enter_amount_${tradeId}`).setLabel('Enter Amount (USD)').setStyle(ButtonStyle.Primary),
    );
    await interaction.reply({
      content: `✅ Roles locked in.\nSender (pays crypto): <@${updated.sender_id}>\nReceiver (gets paid): <@${updated.receiver_id}>\n\n<@${updated.sender_id}>, enter the USD amount you'll be sending.`,
      components: [row],
    });
  } else {
    await interaction.reply({ content: `Got it — waiting on the other party to claim their role.`, ephemeral: true });
  }
}

// ---------- Step 2: sender enters USD amount ----------
async function openAmountModal(interaction, tradeId) {
  const trade = await getTrade(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });
  if (interaction.user.id !== trade.sender_id) return interaction.reply({ content: 'Only the sender enters the amount.', ephemeral: true });

  const modal = new ModalBuilder().setCustomId(`amount_modal_${tradeId}`).setTitle('Amount to Send (USD)');
  const input = new TextInputBuilder()
    .setCustomId('usd_amount')
    .setLabel('USD value')
    .setPlaceholder('e.g. 25')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleAmountModalSubmit(interaction, tradeId) {
  const trade = await getTrade(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });
  if (interaction.user.id !== trade.sender_id) return interaction.reply({ content: 'Only the sender enters the amount.', ephemeral: true });

  const raw = interaction.fields.getTextInputValue('usd_amount').trim();
  const usdAmount = parseFloat(raw);
  if (!usdAmount || usdAmount <= 0) {
    return interaction.reply({ content: 'Enter a valid positive USD amount.', ephemeral: true });
  }

  await interaction.deferReply();
  const price = await getUsdPrice(trade.coin);
  const coinAmount = usdAmount / price;

  await query(
    `UPDATE trades SET amount_usd_requested=$1, amount_coin_quoted=$2, quote_price_usd=$3,
     amount_confirmed_sender=false, amount_confirmed_receiver=false WHERE id=$4`,
    [usdAmount, coinAmount, price, tradeId]
  );
  await logEvent(tradeId, 'amount_quoted', interaction.user.id, `$${usdAmount} = ${coinAmount} ${trade.coin}`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_amount_${tradeId}`).setLabel('Confirm Amount').setStyle(ButtonStyle.Success),
  );
  await interaction.editReply({
    content:
      `**Quote:** $${usdAmount} ≈ **${coinAmount.toFixed(8)} ${COINS[trade.coin].symbol}** ` +
      `(1 ${COINS[trade.coin].symbol} = $${price})\n\n` +
      `<@${trade.sender_id}> and <@${trade.receiver_id}>, both confirm this amount to generate the deposit address.`,
    components: [row],
  });
}

async function handleConfirmAmount(interaction, tradeId) {
  const trade = await getTrade(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });
  if (!isParticipant(trade, interaction.user.id)) return interaction.reply({ content: 'Not your trade.', ephemeral: true });
  if (!trade.amount_coin_quoted) return interaction.reply({ content: 'No amount has been quoted yet.', ephemeral: true });

  const isSender = interaction.user.id === trade.sender_id;
  const column = isSender ? 'amount_confirmed_sender' : 'amount_confirmed_receiver';
  await query(`UPDATE trades SET ${column}=true WHERE id=$1`, [tradeId]);
  await logEvent(tradeId, 'amount_confirmed', interaction.user.id);

  const updated = await getTrade(tradeId);
  if (updated.amount_confirmed_sender && updated.amount_confirmed_receiver) {
    await interaction.reply('Both confirmed. Generating deposit address...');
    await generateDepositAddress(interaction, updated);
  } else {
    await interaction.reply({ content: 'Confirmed. Waiting on the other party.', ephemeral: true });
  }
}

// ---------- Step 3: generate deposit address + QR ----------
async function generateDepositAddress(interaction, trade) {
  const derived = deriveAddress(trade.coin, trade.id);
  await query(
    `UPDATE trades SET deposit_address=$1, derivation_index=$2, status='pending' WHERE id=$3`,
    [derived.address, trade.id, trade.id]
  );
  await logEvent(trade.id, 'deposit_address_generated', 'system', derived.address);
  await logWalletAddress(trade.coin, trade.id, derived.address, 'deposit', trade.id);

  const symbol = COINS[trade.coin].symbol;
  const qrBuffer = await QRCode.toBuffer(derived.address, { width: 300, margin: 1 });
  const attachment = new AttachmentBuilder(qrBuffer, { name: 'deposit-qr.png' });

  const embed = new EmbedBuilder()
    .setTitle(`Deposit Address — Trade #${trade.id}`)
    .setColor(0xD4AF37)
    .setDescription(
      `<@${trade.sender_id}>, send exactly:\n\n` +
      `**${Number(trade.amount_coin_quoted).toFixed(8)} ${symbol}**\n\n` +
      `to:\n\`${derived.address}\`\n\n` +
      `Only send **${symbol}** to this address. Funds are held in escrow until you release them.`
    )
    .setImage('attachment://deposit-qr.png');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`copy_info_${trade.id}`).setLabel('📋 Copy Info').setStyle(ButtonStyle.Secondary),
  );

  const channel = await interaction.client.channels.fetch(trade.channel_id).catch(() => null);
  if (channel) await channel.send({ embeds: [embed], files: [attachment], components: [row] });
}

async function handleCopyInfo(interaction, tradeId) {
  const trade = await getTrade(tradeId);
  if (!trade || !trade.deposit_address) return interaction.reply({ content: 'No deposit address yet.', ephemeral: true });
  const symbol = COINS[trade.coin].symbol;
  await interaction.reply({
    content: `\`\`\`\nAmount: ${Number(trade.amount_coin_quoted).toFixed(8)} ${symbol}\nAddress: ${trade.deposit_address}\n\`\`\`\nTap and hold to copy.`,
    ephemeral: true,
  });
}

// ---------- Wallet address submission (receiver payout / sender refund), collected on demand ----------
async function openAddressModal(interaction, tradeId) {
  const trade = await getTrade(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });
  if (!isParticipant(trade, interaction.user.id)) return interaction.reply({ content: 'Not your trade.', ephemeral: true });

  const modal = new ModalBuilder().setCustomId(`address_modal_${tradeId}`).setTitle('Your Wallet Address');
  const input = new TextInputBuilder()
    .setCustomId('address')
    .setLabel(`Your ${COINS[trade.coin].symbol} address`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleAddressModalSubmit(interaction, tradeId) {
  const trade = await getTrade(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });
  if (!isParticipant(trade, interaction.user.id)) return interaction.reply({ content: 'Not your trade.', ephemeral: true });

  const address = interaction.fields.getTextInputValue('address').trim();
  const isSender = interaction.user.id === trade.sender_id;
  const column = isSender ? 'sender_refund_address' : 'receiver_payout_address';
  await query(`UPDATE trades SET ${column}=$1 WHERE id=$2`, [address, tradeId]);
  await logEvent(tradeId, 'address_submitted', interaction.user.id, `${column}=${address}`);

  await interaction.reply({ content: `Saved your address.`, ephemeral: true });

  const updated = await getTrade(tradeId);
  // If release was already requested by the sender and we were just waiting on the receiver's
  // payout address, complete the payout now.
  if (!isSender && updated.released_by === updated.sender_id && updated.status === 'funded') {
    await executeRelease(interaction, updated);
  }
  // If both parties already agreed to cancel and we were waiting on the sender's refund address, complete it.
  if (isSender && updated.cancel_agreed_sender && updated.cancel_agreed_receiver && updated.status === 'funded') {
    await executeCancel(interaction, updated);
  }
}

// ---------- Release (sender-only, unilateral once they've received their side of the deal) ----------
function fundedActionRow(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`release_${tradeId}`).setLabel('Release Funds').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`agree_cancel_${tradeId}`).setLabel('Agree Cancel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`dispute_${tradeId}`).setLabel('Dispute / Scam').setStyle(ButtonStyle.Danger),
  );
}

async function executeRelease(interaction, trade) {
  const netAmount = Number(trade.amount_received) - Number(trade.fee_amount || 0);
  try {
    const txHash = await payout(trade.coin, trade.receiver_payout_address, netAmount);
    await query(`UPDATE trades SET status='released', payout_tx_hash=$1, released_at=now() WHERE id=$2`, [txHash, trade.id]);
    await logEvent(trade.id, 'released', trade.sender_id, `tx=${txHash}`);
    const channel = await interaction.client.channels.fetch(trade.channel_id).catch(() => null);
    if (channel) {
      await channel.send(`✅ Released **${netAmount.toFixed(8)} ${COINS[trade.coin].symbol}** to <@${trade.receiver_id}>. Tx: \`${txHash}\``);
    }
  } catch (err) {
    const channel = await interaction.client.channels.fetch(trade.channel_id).catch(() => null);
    if (channel) await channel.send(`❌ Release failed: ${err.message}. An admin will need to resolve this manually.`);
  }
}

async function handleRelease(interaction, tradeId) {
  const trade = await getTrade(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });
  if (interaction.user.id !== trade.sender_id) return interaction.reply({ content: 'Only the sender can release funds.', ephemeral: true });
  if (trade.status !== 'funded') return interaction.reply({ content: `Trade is '${trade.status}', can't release.`, ephemeral: true });

  await query(`UPDATE trades SET released_by=$1 WHERE id=$2`, [trade.sender_id, tradeId]);
  await logEvent(tradeId, 'release_requested', interaction.user.id);

  if (trade.receiver_payout_address) {
    await interaction.reply('Releasing funds...');
    await executeRelease(interaction, trade);
  } else {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`submit_address_${tradeId}`).setLabel('Submit Payout Address').setStyle(ButtonStyle.Primary),
    );
    await interaction.reply({
      content: `Release requested. <@${trade.receiver_id}>, submit your payout address to receive the funds.`,
      components: [row],
    });
  }
}

// ---------- Cancel (mutual agreement) ----------
async function executeCancel(interaction, trade) {
  try {
    const txHash = await payout(trade.coin, trade.sender_refund_address, Number(trade.amount_received));
    await query(`UPDATE trades SET status='cancelled', refund_tx_hash=$1, cancelled_at=now() WHERE id=$2`, [txHash, trade.id]);
    await logEvent(trade.id, 'cancelled', 'system', `refund tx=${txHash}`);
    const channel = await interaction.client.channels.fetch(trade.channel_id).catch(() => null);
    if (channel) await channel.send(`✅ Refunded **${trade.amount_received} ${COINS[trade.coin].symbol}** to <@${trade.sender_id}>. Tx: \`${txHash}\``);
  } catch (err) {
    const channel = await interaction.client.channels.fetch(trade.channel_id).catch(() => null);
    if (channel) await channel.send(`❌ Refund failed: ${err.message}. An admin will need to resolve this manually.`);
  }
}

async function handleAgreeCancel(interaction, tradeId) {
  const trade = await getTrade(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });
  if (!isParticipant(trade, interaction.user.id)) return interaction.reply({ content: 'Not your trade.', ephemeral: true });
  if (!['funded', 'pending'].includes(trade.status)) return interaction.reply({ content: `Trade is '${trade.status}', can't cancel.`, ephemeral: true });

  const isSender = interaction.user.id === trade.sender_id;
  const column = isSender ? 'cancel_agreed_sender' : 'cancel_agreed_receiver';
  await query(`UPDATE trades SET ${column}=true WHERE id=$1`, [tradeId]);
  await logEvent(tradeId, 'cancel_agreed', interaction.user.id);

  const updated = await getTrade(tradeId);
  if (updated.cancel_agreed_sender && updated.cancel_agreed_receiver) {
    if (updated.status === 'pending') {
      await query(`UPDATE trades SET status='cancelled', cancelled_at=now() WHERE id=$1`, [tradeId]);
      await logEvent(tradeId, 'cancelled', 'system', 'no funds were deposited');
      return interaction.reply('Both parties agreed to cancel. No funds were deposited, trade closed.');
    }
    if (updated.sender_refund_address) {
      await interaction.reply('Both parties agreed to cancel. Refunding sender...');
      await executeCancel(interaction, updated);
    } else {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`submit_address_${tradeId}`).setLabel('Submit Refund Address').setStyle(ButtonStyle.Primary),
      );
      await interaction.reply({
        content: `Both parties agreed to cancel. <@${updated.sender_id}>, submit your refund address to get your funds back.`,
        components: [row],
      });
    }
  } else {
    await interaction.reply({ content: `Your cancel agreement is recorded. Waiting on the other party.`, ephemeral: true });
  }
}

async function handleDispute(interaction, tradeId) {
  const trade = await getTrade(tradeId);
  if (!trade) return interaction.reply({ content: 'Trade not found.', ephemeral: true });
  if (!isParticipant(trade, interaction.user.id)) return interaction.reply({ content: 'Not your trade.', ephemeral: true });

  await query(`UPDATE trades SET status='disputed', disputed_by=$1 WHERE id=$2`, [interaction.user.id, tradeId]);
  await logEvent(tradeId, 'disputed', interaction.user.id);

  const mention = process.env.ADMIN_ROLE_ID ? `<@&${process.env.ADMIN_ROLE_ID}>` : 'An admin';
  await interaction.reply({
    content: `🚨 Trade disputed by <@${interaction.user.id}>. ${mention}, please review and resolve below — this releases or refunds the escrowed funds directly, no further agreement needed from either party.`,
    components: [adminActionRow(tradeId)],
  });
}

// ---------- Panel: coin select -> ticket form modal ----------
async function handleCoinSelect(interaction) {
  const coin = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`ticket_modal_${coin}`).setTitle(`New ${COINS[coin].label} Trade`);

  const counterpartyInput = new TextInputBuilder()
    .setCustomId('counterparty')
    .setLabel('Other user (@mention or user ID)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  const youGiveInput = new TextInputBuilder()
    .setCustomId('you_give')
    .setLabel('What are you giving?')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  const theyGiveInput = new TextInputBuilder()
    .setCustomId('they_give')
    .setLabel('What is the other person giving?')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(counterpartyInput),
    new ActionRowBuilder().addComponents(youGiveInput),
    new ActionRowBuilder().addComponents(theyGiveInput),
  );
  await interaction.showModal(modal);
}

async function handleTicketModalSubmit(interaction, coin) {
  const raw = interaction.fields.getTextInputValue('counterparty').trim();
  const idMatch = raw.match(/\d{15,20}/);
  if (!idMatch) {
    return interaction.reply({ content: "Couldn't find a valid user ID or mention in that field. Try again.", ephemeral: true });
  }
  const counterpartyId = idMatch[0];
  if (counterpartyId === interaction.user.id) {
    return interaction.reply({ content: "You can't run a trade with yourself.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const counterparty = await interaction.client.users.fetch(counterpartyId).catch(() => null);
  if (!counterparty) return interaction.editReply("Couldn't find that user in this server.");
  if (counterparty.bot) return interaction.editReply("Counterparty can't be a bot.");

  const youGive = interaction.fields.getTextInputValue('you_give').trim();
  const theyGive = interaction.fields.getTextInputValue('they_give').trim();

  const { channel } = await mm.createTicketTrade(interaction, coin, counterparty, youGive, theyGive);
  await interaction.editReply(`Trade started: ${channel}`);
}

// ---------- Admin quick-action buttons (posted when a trade is disputed) ----------
function adminActionRow(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_release_${tradeId}`).setLabel('Admin: Release to Receiver').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`admin_refund_${tradeId}`).setLabel('Admin: Refund to Sender').setStyle(ButtonStyle.Danger),
  );
}

async function handleAdminAction(interaction, tradeId, action) {
  if (!mm.isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });
  await interaction.deferReply();
  try {
    const msg = await mm.resolveTrade(interaction.client, tradeId, action, interaction.user.id);
    await interaction.editReply(msg);
  } catch (err) {
    await interaction.editReply(`❌ Resolution failed: ${err.message}`);
  }
}

module.exports = {
  handleClaimRole,
  openAmountModal,
  handleAmountModalSubmit,
  handleConfirmAmount,
  handleCopyInfo,
  openAddressModal,
  handleAddressModalSubmit,
  handleRelease,
  handleAgreeCancel,
  handleDispute,
  handleCoinSelect,
  handleTicketModalSubmit,
  handleAdminAction,
  fundedActionRow,
};
