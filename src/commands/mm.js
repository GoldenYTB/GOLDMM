const { SlashCommandBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { query, logEvent } = require('../db');
const { COINS } = require('../../config/coins');
const { payout, getHotWalletBalance, hotWalletFor } = require('../payouts');

const data = new SlashCommandBuilder()
  .setName('mm')
  .setDescription('GoldMM crypto escrow')
  .addSubcommand(sub =>
    sub.setName('panel')
      .setDescription('(Admin) Post the "start a trade" panel in this channel')
  )
  .addSubcommandGroup(group =>
    group.setName('admin')
      .setDescription('Admin dispute resolution')
      .addSubcommand(sub =>
        sub.setName('resolve')
          .setDescription('Resolve a disputed trade')
          .addIntegerOption(o => o.setName('trade_id').setDescription('Trade ID').setRequired(true))
          .addStringOption(o => o.setName('action').setDescription('Release to receiver or refund to sender').setRequired(true)
            .addChoices({ name: 'Release to receiver', value: 'release' }, { name: 'Refund to sender', value: 'refund' }))
      )
      .addSubcommand(sub =>
        sub.setName('status')
          .setDescription('Look up a trade')
          .addIntegerOption(o => o.setName('trade_id').setDescription('Trade ID').setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName('wallet')
          .setDescription('Check the hot wallet balance for a coin')
          .addStringOption(o => o.setName('coin').setDescription('Coin').setRequired(true)
            .addChoices(...Object.keys(COINS).map(c => ({ name: COINS[c].label, value: c }))))
      )
      .addSubcommand(sub =>
        sub.setName('withdraw')
          .setDescription('Pay yourself (or any address) out of the hot wallet')
          .addStringOption(o => o.setName('coin').setDescription('Coin').setRequired(true)
            .addChoices(...Object.keys(COINS).map(c => ({ name: COINS[c].label, value: c }))))
          .addNumberOption(o => o.setName('amount').setDescription('Amount in coin units').setRequired(true))
          .addStringOption(o => o.setName('to_address').setDescription('Destination address').setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName('addresses')
          .setDescription('View the durable log of every wallet address the bot has generated')
          .addStringOption(o => o.setName('coin').setDescription('Filter by coin (optional)')
            .addChoices(...Object.keys(COINS).map(c => ({ name: COINS[c].label, value: c }))))
      )
  );

function isAdmin(interaction) {
  return !process.env.ADMIN_ROLE_ID || interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID);
}

// ---------- Panel: persistent "start a trade" message ----------
async function handlePanel(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });

  const embed = new EmbedBuilder()
    .setTitle('🛡️ GoldMM — Start an Escrow Trade')
    .setColor(0xD4AF37)
    .setDescription(
      'Pick the coin you\'ll be trading with below. You\'ll be asked for the other party, ' +
      'what you\'re giving, and what they\'re giving, then a private ticket opens for the two of you.'
    )
    .setFooter({ text: 'Fees: free under $10 · 2% $10-50 · 3% $50-100 · 5% $100+' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId('panel_coin_select')
    .setPlaceholder('Select a coin to start a trade')
    .addOptions(Object.keys(COINS).map(c => ({ label: COINS[c].label, value: c })));

  const row = new ActionRowBuilder().addComponents(menu);
  await interaction.channel.send({ embeds: [embed], components: [row] });
  await interaction.reply({ content: 'Panel posted.', ephemeral: true });
}

// ---------- Shared ticket creation, used by the panel flow ----------
async function createTicketTrade(interaction, coin, counterpartyUser, youGive, theyGive) {
  const guild = interaction.guild;
  const { rows } = await query(
    `INSERT INTO trades (guild_id, coin, initiator_id, initiator_offer, counterparty_id, counterparty_offer)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [guild.id, coin, interaction.user.id, youGive, counterpartyUser.id, theyGive]
  );
  const trade = rows[0];
  await logEvent(trade.id, 'created', interaction.user.id, `coin=${coin}`);

  const overwrites = [
    { id: guild.roles.everyone, deny: ['ViewChannel'] },
    { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
    { id: counterpartyUser.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
  ];
  if (process.env.ADMIN_ROLE_ID) {
    overwrites.push({ id: process.env.ADMIN_ROLE_ID, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] });
  }
  const channel = await guild.channels.create({
    name: `mm-${trade.id}-${COINS[coin].symbol.toLowerCase()}`,
    type: ChannelType.GuildText,
    parent: process.env.TICKET_CATEGORY_ID || undefined,
    permissionOverwrites: overwrites,
  });
  await query(`UPDATE trades SET channel_id=$1 WHERE id=$2`, [channel.id, trade.id]);

  const embed = new EmbedBuilder()
    .setTitle(`GoldMM Trade #${trade.id}`)
    .setColor(0xD4AF37)
    .setDescription(
      `Coin: **${COINS[coin].label}**\n\n` +
      `<@${interaction.user.id}> is giving: **${youGive}**\n` +
      `<@${counterpartyUser.id}> is giving: **${theyGive}**\n\n` +
      `Both of you: tap below to say whether you're the one **sending crypto** or **receiving crypto** in this deal.`
    )
    .setFooter({ text: 'Fees: free under $10 · 2% $10-50 · 3% $50-100 · 5% $100+' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`claim_sender_${trade.id}`).setLabel("I'm Sending Crypto").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`claim_receiver_${trade.id}`).setLabel("I'm Receiving Crypto").setStyle(ButtonStyle.Success),
  );

  await channel.send({ content: `<@${interaction.user.id}> <@${counterpartyUser.id}>`, embeds: [embed], components: [row] });
  return { trade, channel };
}

// ---------- Admin resolve (shared between slash command and the in-channel dispute buttons) ----------
async function resolveTrade(client, tradeId, action, resolvedByLabel) {
  const { rows } = await query(`SELECT * FROM trades WHERE id=$1`, [tradeId]);
  const trade = rows[0];
  if (!trade) throw new Error('Trade not found.');
  if (trade.status !== 'disputed' && trade.status !== 'funded') {
    throw new Error(`Trade is '${trade.status}', not eligible for admin resolution.`);
  }

  if (action === 'release') {
    if (!trade.receiver_payout_address) throw new Error('No receiver payout address on file yet — ask them to submit one first.');
    const netAmount = Number(trade.amount_received) - Number(trade.fee_amount || 0);
    const txHash = await payout(trade.coin, trade.receiver_payout_address, netAmount);
    await query(`UPDATE trades SET status='released', released_by=$1, payout_tx_hash=$2, released_at=now() WHERE id=$3`, [resolvedByLabel, txHash, tradeId]);
    await logEvent(tradeId, 'resolved', resolvedByLabel, `admin release, tx=${txHash}`);
    return `✅ Trade #${tradeId} resolved: released ${netAmount} ${COINS[trade.coin].symbol} to <@${trade.receiver_id}>. Tx: \`${txHash}\``;
  } else {
    if (!trade.sender_refund_address) throw new Error('No sender refund address on file yet — ask them to submit one first.');
    const txHash = await payout(trade.coin, trade.sender_refund_address, Number(trade.amount_received));
    await query(`UPDATE trades SET status='cancelled', refund_tx_hash=$1, cancelled_at=now() WHERE id=$2`, [txHash, tradeId]);
    await logEvent(tradeId, 'resolved', resolvedByLabel, `admin refund, tx=${txHash}`);
    return `✅ Trade #${tradeId} resolved: refunded ${trade.amount_received} ${COINS[trade.coin].symbol} to <@${trade.sender_id}>. Tx: \`${txHash}\``;
  }
}

async function handleAdminResolve(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });
  const tradeId = interaction.options.getInteger('trade_id');
  const action = interaction.options.getString('action');
  await interaction.deferReply();
  try {
    const msg = await resolveTrade(interaction.client, tradeId, action, interaction.user.id);
    await interaction.editReply(msg);
  } catch (err) {
    await interaction.editReply(`❌ Resolution failed: ${err.message}`);
  }
}

async function handleAdminStatus(interaction) {
  const tradeId = interaction.options.getInteger('trade_id');
  const { rows } = await query(`SELECT * FROM trades WHERE id=$1`, [tradeId]);
  const t = rows[0];
  if (!t) return interaction.reply({ content: 'Trade not found.', ephemeral: true });
  await interaction.reply({
    content: '```json\n' + JSON.stringify(t, null, 2) + '\n```',
    ephemeral: true,
  });
}

async function handleAdminWallet(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });
  const coin = interaction.options.getString('coin');
  await interaction.deferReply({ ephemeral: true });
  try {
    const { address, balance } = await getHotWalletBalance(coin);
    await interaction.editReply(`**${COINS[coin].label} hot wallet**\nAddress: \`${address}\`\nBalance: **${balance} ${COINS[coin].symbol}**`);
  } catch (err) {
    await interaction.editReply(`❌ Couldn't check balance: ${err.message}`);
  }
}

async function handleAdminWithdraw(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });
  const coin = interaction.options.getString('coin');
  const amount = interaction.options.getNumber('amount');
  const toAddress = interaction.options.getString('to_address');

  await interaction.deferReply({ ephemeral: true });
  try {
    const txHash = await payout(coin, toAddress, amount);
    console.log(`[admin_withdraw] ${interaction.user.tag} sent ${amount} ${coin} to ${toAddress}, tx=${txHash}`);
    await interaction.editReply(`✅ Sent **${amount} ${COINS[coin].symbol}** to \`${toAddress}\`.\nTx: \`${txHash}\``);
  } catch (err) {
    await interaction.editReply(`❌ Withdrawal failed: ${err.message}`);
  }
}

async function handleAdminAddresses(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: 'Admins only.', ephemeral: true });
  const coin = interaction.options.getString('coin');

  await interaction.deferReply({ ephemeral: true });
  try {
    const { rows } = coin
      ? await query(`SELECT * FROM wallet_log WHERE coin=$1 ORDER BY created_at DESC LIMIT 40`, [coin])
      : await query(`SELECT * FROM wallet_log ORDER BY created_at DESC LIMIT 40`);

    if (!rows.length) return interaction.editReply('No addresses logged yet.');

    const lines = rows.map(r =>
      `${r.purpose === 'hot_wallet' ? '🔥' : '📥'} **${r.coin}** idx ${r.derivation_index}${r.trade_id ? ` (trade #${r.trade_id})` : ''}: \`${r.address}\``
    );
    // Discord messages cap at 2000 chars — trim if needed
    let content = lines.join('\n');
    if (content.length > 1900) content = content.slice(0, 1900) + '\n… (truncated, query wallet_log directly in Neon for the full list)';

    await interaction.editReply(`**Wallet address log** (most recent ${rows.length}):\n${content}`);
  } catch (err) {
    await interaction.editReply(`❌ Couldn't fetch address log: ${err.message}`);
  }
}

module.exports = { data, isAdmin, handlePanel, createTicketTrade, resolveTrade, handleAdminResolve, handleAdminStatus, handleAdminWallet, handleAdminWithdraw, handleAdminAddresses };
