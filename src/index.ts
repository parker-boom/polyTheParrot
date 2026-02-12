import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Guild,
  Message,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import OpenAI from "openai";
import { CHECKIN_MARKER_REGEX, config, TEAM_CHANNEL_REGEX } from "./config.js";
import { loadPromptConfig, renderTemplate } from "./promptConfig.js";
import { buildTranscript, fetchAllMessages, renderTranscriptForPrompt } from "./transcript.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const FUN_FACTS = [
  "Fun fact: Parrots can mimic over 100 sounds.",
  "Fun fact: A group of parrots is called a pandemonium.",
  "Fun fact: Some parrots live for decades.",
  "Fun fact: Parrots use their feet like hands.",
  "Fun fact: Many parrots can solve simple puzzles.",
];

let cachedCheckinNumber: number | null = null;
const HACKATHON_INFO_FILE = path.join(process.cwd(), "knowledge", "hackathon-info.md");
const HACKATHON_INFO_PLACEHOLDER = "[[REPLACE_WITH_HACKATHON_INFO]]";

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function splitForDiscord(text: string, maxLen = 1900): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const parts: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if ((current + "\n" + line).length > maxLen) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }

      if (line.length > maxLen) {
        let start = 0;
        while (start < line.length) {
          parts.push(line.slice(start, start + maxLen));
          start += maxLen;
        }
      } else {
        current = line;
      }
    } else {
      current = current.length === 0 ? line : `${current}\n${line}`;
    }
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

function isTeamTextChannel(channel: TextChannel): boolean {
  return TEAM_CHANNEL_REGEX.test(channel.name);
}

function getTeamNumber(channelName: string): number {
  const match = channelName.match(TEAM_CHANNEL_REGEX);
  return match ? Number(match[1]) : 999;
}

async function getGuildOrThrow(): Promise<Guild> {
  const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
  await guild.roles.fetch();
  return guild;
}

async function getTeamChannels(guild: Guild): Promise<TextChannel[]> {
  await guild.channels.fetch();
  const channels = guild.channels.cache
    .filter((ch): ch is TextChannel => ch.type === ChannelType.GuildText)
    .filter(isTeamTextChannel)
    .sort((a, b) => getTeamNumber(a.name) - getTeamNumber(b.name));

  return [...channels.values()];
}

function getRoleForTeamChannel(guild: Guild, channel: TextChannel): string | null {
  const teamNumber = getTeamNumber(channel.name);
  const targets = [`team${teamNumber}`, `team ${teamNumber}`, `team-${teamNumber}`].map(normalize);
  const role = guild.roles.cache.find((r) => targets.includes(normalize(r.name)));
  return role?.id ?? null;
}

function mentionPrefix(roleId: string | null): string {
  return roleId ? `<@&${roleId}> ` : "";
}

async function sendToTeamChannel(guild: Guild, channel: TextChannel, body: string): Promise<void> {
  const roleId = getRoleForTeamChannel(guild, channel);
  await channel.send({
    content: `${mentionPrefix(roleId)}${body}`,
    allowedMentions: roleId ? { roles: [roleId] } : undefined,
  });
}

async function detectLastCheckinNumber(controlChannel: TextChannel, botUserId: string): Promise<number> {
  const history = await fetchAllMessages(controlChannel);
  let max = 0;

  for (const msg of history) {
    if (msg.authorId !== botUserId) {
      continue;
    }

    const fromMarker = msg.content.match(CHECKIN_MARKER_REGEX);
    if (fromMarker) {
      max = Math.max(max, Number(fromMarker[1]));
      continue;
    }

    const fromSummary = msg.content.match(/Check-in #(\d+)/i);
    if (fromSummary) {
      max = Math.max(max, Number(fromSummary[1]));
    }
  }

  return max;
}

async function registerCommands(guild: Guild): Promise<void> {
  const polyCommand = new SlashCommandBuilder()
    .setName("poly")
    .setDescription("Control Poly the Parrot")
    .addSubcommand((sub) => sub.setName("checkin").setDescription("Ask all teams for a check-in"))
    .addSubcommand((sub) => sub.setName("status").setDescription("Get a status report across all teams"))
    .addSubcommand((sub) =>
      sub
        .setName("send")
        .setDescription("Send a message to one team channel or all team channels")
        .addStringOption((opt) =>
          opt.setName("message").setDescription("Message to send to the selected team channel(s)").setRequired(true),
        )
        .addStringOption((opt) => {
          opt.setName("target").setDescription("Send to one team or all teams").setRequired(false);
          opt.addChoices({ name: "all", value: "all" });
          for (let i = 1; i <= 12; i += 1) {
            opt.addChoices({ name: `team-${i}`, value: `team-${i}` });
          }
          return opt;
        }),
    );

  await guild.commands.set([polyCommand]);
}

function ensureAuthorized(interaction: ChatInputCommandInteraction): string | null {
  if (interaction.user.id !== config.OWNER_USER_ID) {
    return "Only the bot owner can run Poly control commands.";
  }

  if (interaction.channelId !== config.POLY_CONTROL_CHANNEL_ID) {
    return "Run this command in the Poly control channel only.";
  }

  return null;
}

async function runCheckin(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const promptConfig = await loadPromptConfig();

  const guild = await getGuildOrThrow();
  const controlChannel = await guild.channels.fetch(config.POLY_CONTROL_CHANNEL_ID);
  if (!controlChannel || controlChannel.type !== ChannelType.GuildText) {
    throw new Error("Poly control channel is missing or not a text channel.");
  }

  const teamChannels = await getTeamChannels(guild);
  if (teamChannels.length === 0) {
    await interaction.editReply("No channels matching `team-*` were found.");
    return;
  }

  if (cachedCheckinNumber === null) {
    cachedCheckinNumber = await detectLastCheckinNumber(controlChannel, client.user!.id);
  }
  cachedCheckinNumber += 1;
  const checkinNumber = cachedCheckinNumber;

  const funFact = FUN_FACTS[(checkinNumber - 1) % FUN_FACTS.length];
  const checkinBody = renderTemplate(promptConfig.checkinTemplate, {
    checkin_number: String(checkinNumber),
    fun_fact: funFact,
  });

  const sent: string[] = [];
  const failed: string[] = [];

  for (const channel of teamChannels) {
    try {
      await sendToTeamChannel(guild, channel, checkinBody);
      sent.push(channel.name);
    } catch {
      failed.push(channel.name);
    }
  }

  const summary = [
    `Check-in #${checkinNumber} sent.`,
    `Delivered: ${sent.length}/${teamChannels.length}`,
    failed.length > 0 ? `Failed: ${failed.join(", ")}` : "Failed: none",
  ].join("\n");

  await interaction.editReply(summary);
}

type HackathonInfoResult = {
  ready: boolean;
  text: string;
  reason?: string;
};

async function loadHackathonInfo(): Promise<HackathonInfoResult> {
  try {
    const raw = await fs.readFile(HACKATHON_INFO_FILE, "utf8");
    const text = raw.trim();
    if (!text || text.includes(HACKATHON_INFO_PLACEHOLDER)) {
      return {
        ready: false,
        text,
        reason: `Fill in ${HACKATHON_INFO_FILE} with real hackathon details first.`,
      };
    }
    return { ready: true, text };
  } catch {
    return {
      ready: false,
      text: "",
      reason: `Missing required file ${HACKATHON_INFO_FILE}. Create it with your hackathon details.`,
    };
  }
}

async function buildStatusPrompt(guild: Guild, infoDoc: string, promptTemplate: string): Promise<string> {
  const teamChannels = await getTeamChannels(guild);
  if (teamChannels.length === 0) {
    return "No team channels found.";
  }

  const teamTranscripts = [];
  for (const channel of teamChannels) {
    const transcript = await buildTranscript(channel, client.user!.id);
    teamTranscripts.push(renderTranscriptForPrompt(transcript));
  }

  const controlChannel = await guild.channels.fetch(config.POLY_CONTROL_CHANNEL_ID);
  let controlBlock = "";
  if (controlChannel && controlChannel.type === ChannelType.GuildText) {
    const controlTranscript = await buildTranscript(controlChannel, client.user!.id);
    controlBlock = renderTranscriptForPrompt(controlTranscript);
  }

  return renderTemplate(promptTemplate, {
    info_doc: infoDoc,
    team_transcripts: teamTranscripts.join("\n\n---\n\n"),
    control_transcript: controlBlock || "[No control channel transcript found]",
  });
}

async function askOpenAI(prompt: string, instructions?: string): Promise<string> {
  const response = await openai.responses.create({
    model: config.OPENAI_MODEL,
    instructions,
    input: prompt,
  });

  const text = response.output_text?.trim();
  if (text && text.length > 0) {
    return text;
  }

  throw new Error("OpenAI did not return output text.");
}

async function runStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const guild = await getGuildOrThrow();
  const info = await loadHackathonInfo();
  if (!info.ready) {
    await interaction.editReply(info.reason ?? "Hackathon info doc is required.");
    return;
  }

  const promptConfig = await loadPromptConfig();
  const prompt = await buildStatusPrompt(guild, info.text, promptConfig.statusUserTemplate);
  const statusSystemInstructions = renderTemplate(promptConfig.statusSystemInstructions, {
    personality: promptConfig.personality,
  });

  const report = await askOpenAI(prompt, statusSystemInstructions);

  const chunks = splitForDiscord(report);
  await interaction.editReply(chunks[0]);
  for (let i = 1; i < chunks.length; i += 1) {
    await interaction.followUp(chunks[i]);
  }
}

async function runSend(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const message = interaction.options.getString("message", true).trim();
  const target = interaction.options.getString("target") ?? "all";

  const guild = await getGuildOrThrow();
  const teamChannels = await getTeamChannels(guild);
  if (teamChannels.length === 0) {
    await interaction.editReply("No channels matching `team-*` were found.");
    return;
  }

  const selectedChannels = target === "all" ? teamChannels : teamChannels.filter((c) => c.name === target);
  if (selectedChannels.length === 0) {
    await interaction.editReply(`Target channel \`${target}\` was not found.`);
    return;
  }

  const sent: string[] = [];
  const failed: string[] = [];
  for (const channel of selectedChannels) {
    try {
      await sendToTeamChannel(guild, channel, message);
      sent.push(channel.name);
    } catch {
      failed.push(channel.name);
    }
  }

  const summary = [
    `Sent message to ${sent.length}/${selectedChannels.length} channels.`,
    sent.length > 0 ? `Delivered: ${sent.join(", ")}` : "Delivered: none",
    failed.length > 0 ? `Failed: ${failed.join(", ")}` : "Failed: none",
  ].join("\n");

  await interaction.editReply(summary);
}

function stripBotMention(raw: string, botId: string): string {
  return raw.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

type StandbyDecision =
  | { action: "REPLY"; message: string }
  | { action: "ESCALATE"; reason: string; draft: string };

function parseStandbyDecision(raw: string): StandbyDecision {
  const normalized = raw.trim();
  const action = normalized.match(/ACTION:\s*(REPLY|ESCALATE)/i)?.[1]?.toUpperCase();

  if (action === "REPLY") {
    const message = normalized.match(/MESSAGE:\s*([\s\S]*)/i)?.[1]?.trim();
    if (message) {
      return { action: "REPLY", message };
    }
  }

  if (action === "ESCALATE") {
    const reason = normalized.match(/REASON:\s*([^\n]+)/i)?.[1]?.trim() ?? "Uncertain response.";
    const draft = normalized.match(/DRAFT:\s*([\s\S]*)/i)?.[1]?.trim() ?? "";
    return { action: "ESCALATE", reason, draft };
  }

  return {
    action: "ESCALATE",
    reason: "Could not parse assistant decision.",
    draft: normalized.slice(0, 500),
  };
}

async function runStandby(message: Message): Promise<void> {
  if (!client.user) {
    return;
  }
  if (message.author.bot) {
    return;
  }
  if (!message.mentions.users.has(client.user.id)) {
    return;
  }
  if (!message.guild) {
    return;
  }
  if (message.channel.type !== ChannelType.GuildText) {
    return;
  }
  if (!TEAM_CHANNEL_REGEX.test(message.channel.name)) {
    return;
  }

  const channel = message.channel as TextChannel;
  const transcript = await buildTranscript(channel, client.user.id);
  const promptConfig = await loadPromptConfig();
  const info = await loadHackathonInfo();
  const userQuestion = stripBotMention(message.content, client.user.id);
  const ownerMention = `<@${config.OWNER_USER_ID}>`;

  if (!info.ready) {
    await channel.send(`I need organizer context before I can answer reliably. ${ownerMention}`);
    const controlMissing = await message.guild.channels.fetch(config.POLY_CONTROL_CHANNEL_ID);
    if (controlMissing && controlMissing.type === ChannelType.GuildText) {
      await controlMissing.send(`${ownerMention} ${info.reason}`);
    }
    return;
  }

  const standbySystemInstructions = renderTemplate(promptConfig.standbySystemInstructions, {
    personality: promptConfig.personality,
  });
  const prompt = renderTemplate(promptConfig.standbyUserTemplate, {
    owner_user_id: config.OWNER_USER_ID,
    info_doc: info.text,
    channel_transcript: renderTranscriptForPrompt(transcript),
    user_question: userQuestion || "[No extra text provided beyond mention]",
  });

  const rawDecision = await askOpenAI(prompt, standbySystemInstructions);
  const decision = parseStandbyDecision(rawDecision);

  if (decision.action === "REPLY") {
    await channel.send(decision.message);
    return;
  }

  const guild = message.guild;
  const control = await guild.channels.fetch(config.POLY_CONTROL_CHANNEL_ID);
  await channel.send(
    renderTemplate(promptConfig.standbyEscalationMessage, {
      owner_user_id: config.OWNER_USER_ID,
    }),
  );

  if (control && control.type === ChannelType.GuildText) {
    const escalation = [
      `${ownerMention} escalation from ${channel.toString()}`,
      `Reason: ${decision.reason}`,
      `Question: ${userQuestion || "[Mention with no question text]"}`,
      decision.draft ? `Draft reply: ${decision.draft}` : "Draft reply: [none]",
      `Jump link: ${message.url}`,
    ].join("\n");
    await control.send(escalation);
  }
}

async function handlePolyCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const authError = ensureAuthorized(interaction);
  if (authError) {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: authError, ephemeral: true });
    } else {
      await interaction.reply({ content: authError, ephemeral: true });
    }
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === "checkin") {
    await runCheckin(interaction);
    return;
  }
  if (sub === "status") {
    await runStatus(interaction);
    return;
  }
  if (sub === "send") {
    await runSend(interaction);
    return;
  }
}

client.once("ready", async () => {
  const tag = client.user?.tag ?? "unknown";
  console.log(`Poly is online as ${tag}`);

  try {
    await loadPromptConfig();
  } catch (error) {
    console.error("Prompt config error:", error);
  }

  const info = await loadHackathonInfo();
  if (!info.ready) {
    console.warn(info.reason);
  }

  try {
    const guild = await getGuildOrThrow();
    await registerCommands(guild);
    console.log("Slash commands synced.");
  } catch (error) {
    console.error("Failed to sync slash commands:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }
  if (interaction.commandName !== "poly") {
    return;
  }

  try {
    await handlePolyCommand(interaction);
  } catch (error: unknown) {
    const code = (error as { code?: number }).code;
    const message =
      code === RESTJSONErrorCodes.MissingPermissions
        ? "Poly is missing Discord permissions for that action."
        : "Something failed while running that command.";

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true });
    } else {
      await interaction.reply({ content: message, ephemeral: true });
    }
    console.error(error);
  }
});

client.on("messageCreate", async (message) => {
  try {
    await runStandby(message);
  } catch (error) {
    console.error("Standby handler failed:", error);
  }
});

client.login(config.DISCORD_BOT_TOKEN).catch((error) => {
  console.error("Discord login failed:", error);
  process.exit(1);
});
