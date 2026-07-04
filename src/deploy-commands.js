require('dotenv').config();
const { REST, Routes } = require('discord.js');
const mm = require('./commands/mm');

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const body = [mm.data.toJSON()];
  if (process.env.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.GUILD_ID),
      { body }
    );
    console.log('Registered guild commands (instant).');
  } else {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body });
    console.log('Registered global commands (may take up to 1hr to propagate).');
  }
}

// Still runnable directly: node src/deploy-commands.js
if (require.main === module) {
  registerCommands().catch(err => console.error(err));
}

module.exports = { registerCommands };
