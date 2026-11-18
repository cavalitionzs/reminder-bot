const { SlashCommandBuilder, ChannelType } = require("discord.js");

const weekdays = [
  ["Monday", "1"],
  ["Tuesday", "2"],
  ["Wednesday", "3"],
  ["Thursday", "4"],
  ["Friday", "5"],
  ["Saturday", "6"],
  ["Sunday", "7"],
];

const reminderCommand = new SlashCommandBuilder()
  .setName("reminder")
  .setDescription("Manage recurring weekly reminders")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a weekly reminder")
      .addStringOption((option) =>
        option
          .setName("weekday")
          .setDescription("Day of the week")
          .setRequired(true)
          .addChoices(...weekdays.map(([name, value]) => ({ name, value }))),
      )
      .addStringOption((option) =>
        option
          .setName("time")
          .setDescription("24-hour time, e.g. 18:00")
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Where the reminder is sent")
          .setRequired(true)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ),
      )
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription("Reminder text")
          .setRequired(true)
          .setMaxLength(1500),
      )
      .addStringOption((option) =>
        option
          .setName("timezone")
          .setDescription("IANA timezone; defaults to Asia/Jakarta")
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName("mention")
          .setDescription("Mention you when sending?")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Role to mention")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List this server’s active reminders"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("delete")
      .setDescription("Delete a reminder by its ID")
      .addIntegerOption((option) =>
        option
          .setName("id")
          .setDescription("Reminder ID")
          .setRequired(true)
          .setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("timezone").setDescription("Show the default timezone"),
  );

const findScheduleCommand = new SlashCommandBuilder()
  .setName("find_schedule")
  .setDescription("Find the latest Maintenance Schedule and show its end time (UTC)");

const maintenanceScheduleCommand = new SlashCommandBuilder()
  .setName("maintenance_schedule")
  .setDescription("Add a weekly reminder for a maintenance schedule (UTC)")
  .addStringOption((option) =>
    option
      .setName("weekday")
      .setDescription("Day of the week (UTC)")
      .setRequired(true)
      .addChoices(...weekdays.map(([name, value]) => ({ name, value }))),
  )
  .addStringOption((option) =>
    option
      .setName("time")
      .setDescription("UTC time, 24-hour, e.g. 09:00")
      .setRequired(true),
  )
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Where the reminder is sent")
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  )
  .addStringOption((option) =>
    option
      .setName("message")
      .setDescription("Reminder text (optional)")
      .setRequired(false)
      .setMaxLength(1500),
  )
  .addBooleanOption((option) =>
    option
      .setName("mention")
      .setDescription("Mention you when sending?")
      .setRequired(false),
  )
  .addRoleOption((option) =>
    option
      .setName("role")
      .setDescription("Role to mention")
      .setRequired(false),
  );

const maintenanceScheduleUpdateCommand = new SlashCommandBuilder()
  .setName("maintenance_schedule_update")
  .setDescription("Update the UTC time of an existing maintenance schedule")
  .addIntegerOption((option) =>
    option
      .setName("id")
      .setDescription("Maintenance schedule ID (see /reminder list)")
      .setRequired(true)
      .setMinValue(1),
  )
  .addStringOption((option) =>
    option
      .setName("time")
      .setDescription("New UTC time, 24-hour, e.g. 09:00")
      .setRequired(true),
  );

module.exports = [
  reminderCommand.toJSON(),
  findScheduleCommand.toJSON(),
  maintenanceScheduleCommand.toJSON(),
  maintenanceScheduleUpdateCommand.toJSON(),
];
