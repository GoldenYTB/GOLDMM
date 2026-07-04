require('dotenv').config();
const { REST, Routes } = require('discord.js');
const mm = require('./commands/mm');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
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
  } catch (err) {
    console.error(err);
  }
})();
