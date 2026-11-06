require('dotenv').config();
const { REST, Routes } = require('discord.js');
const commands = require('../lib/commands');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error('Set DISCORD_TOKEN, CLIENT_ID, and GUILD_ID in your .env file.');
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('Deploying guild slash commands...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log('Slash commands deployed successfully.');
  } catch (error) {
    console.error('Failed to deploy commands:', error);
    process.exitCode = 1;
  }
})();
