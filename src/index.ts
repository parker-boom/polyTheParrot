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
import { loadModelConfig } from "./modelConfig.js";
import { loadPromptConfig, renderTemplate } from "./promptConfig.js";
import { buildTranscript, fetchAllMessages, renderTranscriptForPrompt } from "./transcript.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const CHECKIN_MESSAGES = [
  "Just checking in here team, how are things going? Can you give me a quick project update and let me know if you have any blockers.",
  "Quick pulse check, team. How is the project looking right now, and are any blockers slowing you down.",
  "Checking in on progress. Drop a short update on what you shipped and anything currently blocking momentum.",
  "How are things feeling right now, team? Share a brief status update and call out blockers if you have them.",
  "Status check: what is working well, what is in progress, and what blockers should we clear for you.",
  "Quick team sync from me. Where are you at with the build, and what blockers are getting in the way.",
  "Give me a fast snapshot of your project status and any blockers that need support.",
  "How is the project moving along? Send a short update and flag blockers so we can unblock you fast.",
  "Team check-in time. What did you finish recently, what is next, and what is blocking you right now.",
  "Dropping in for a quick update. How is the build going, and do you need help with any blockers.",
];

let cachedCheckinNumber: number | null = null;
const HACKATHON_INFO_FILE = path.join(process.cwd(), "knowledge", "hackathon-info.md");
const HACKATHON_INFO_PLACEHOLDER = "[[REPLACE_WITH_HACKATHON_INFO]]";
const MAX_TEAM_NUMBER = 3;

function logInfo(event: string, details: Record<string, string | number | boolean | undefined> = {}): void {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const prefix = `[Poly][${new Date().toISOString()}][${event}]`;
  console.log(suffix.length > 0 ? `${prefix} ${suffix}` : prefix);
}

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
    .filter((ch) => getTeamNumber(ch.name) <= MAX_TEAM_NUMBER)
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
  logInfo("checkin.counter.scan.start", {
    channel: controlChannel.name,
    channelId: controlChannel.id,
  });
  const history = await fetchAllMessages(controlChannel);
  let max = 0;

  for (const msg of history) {
    if (msg.authorId !== botUserId) {
      continue;
    }

    const fromMarker = msg.content.match(CHECKIN_MARKER_REGEX);
    if (fromMarker) {
      max = Math.max(max, Number(fromMarker[1]));
    }
  }

  logInfo("checkin.counter.scan.done", {
    channel: controlChannel.name,
    channelId: controlChannel.id,
    messages: history.length,
    latestCheckin: max,
  });
  return max;
}

async function registerCommands(guild: Guild): Promise<void> {
  const polyCommand = new SlashCommandBuilder()
    .setName("poly")
    .setDescription("Control Poly the Parrot")
    .addSubcommand((sub) =>
      sub
        .setName("checkin")
        .setDescription("Ask all teams for a check-in")
        .addStringOption((opt) =>
          opt
            .setName("ask")
            .setDescription("Optional extra thing to ask in this check-in")
            .setRequired(false),
        ),
    )
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
          for (let i = 1; i <= MAX_TEAM_NUMBER; i += 1) {
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
  const customAsk = interaction.options.getString("ask")?.trim() ?? "";
  logInfo("command.checkin.start", {
    byUserId: interaction.user.id,
    commandChannelId: interaction.channelId,
    hasCustomAsk: customAsk.length > 0,
  });

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

  const checkinMessage = CHECKIN_MESSAGES[(checkinNumber - 1) % CHECKIN_MESSAGES.length];
  const extraPromptBlock = await buildCheckinAddOn(customAsk, promptConfig.personality);
  const checkinBody = renderTemplate(promptConfig.checkinTemplate, {
    checkin_number: String(checkinNumber),
    checkin_message: checkinMessage,
    extra_prompt_block: extraPromptBlock,
  });

  const sent: string[] = [];
  const failed: string[] = [];

  for (const channel of teamChannels) {
    try {
      await sendToTeamChannel(guild, channel, checkinBody);
      sent.push(channel.name);
      logInfo("command.checkin.sent", { channel: channel.name, channelId: channel.id, checkinNumber });
    } catch {
      failed.push(channel.name);
      logInfo("command.checkin.failed", { channel: channel.name, channelId: channel.id, checkinNumber });
    }
  }

  const summary = [
    `Check-in #${checkinNumber} sent.`,
    `Delivered: ${sent.length}/${teamChannels.length}`,
    failed.length > 0 ? `Failed: ${failed.join(", ")}` : "Failed: none",
  ].join("\n");

  await interaction.editReply(summary);
  logInfo("command.checkin.done", {
    checkinNumber,
    delivered: sent.length,
    failed: failed.length,
  });
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
    logInfo("status.transcript.fetch.start", { channel: channel.name, channelId: channel.id });
    const transcript = await buildTranscript(channel, client.user!.id);
    logInfo("status.transcript.fetch.done", {
      channel: channel.name,
      channelId: channel.id,
      messages: transcript.messages.length,
      latestCheckin: transcript.latestCheckinNumber ?? "none",
    });
    teamTranscripts.push(renderTranscriptForPrompt(transcript));
  }

  const controlChannel = await guild.channels.fetch(config.POLY_CONTROL_CHANNEL_ID);
  let controlBlock = "";
  if (controlChannel && controlChannel.type === ChannelType.GuildText) {
    logInfo("status.transcript.fetch.start", { channel: controlChannel.name, channelId: controlChannel.id });
    const controlTranscript = await buildTranscript(controlChannel, client.user!.id);
    logInfo("status.transcript.fetch.done", {
      channel: controlChannel.name,
      channelId: controlChannel.id,
      messages: controlTranscript.messages.length,
      latestCheckin: controlTranscript.latestCheckinNumber ?? "none",
    });
    controlBlock = renderTranscriptForPrompt(controlTranscript);
  }

  return renderTemplate(promptTemplate, {
    info_doc: infoDoc,
    team_transcripts: teamTranscripts.join("\n\n---\n\n"),
    control_transcript: controlBlock || "[No control channel transcript found]",
  });
}

async function askOpenAI(prompt: string, instructions?: string): Promise<string> {
  const modelConfig = await loadModelConfig();
  logInfo("openai.request", {
    model: modelConfig.model,
    reasoningEffort: modelConfig.reasoningEffort,
    promptChars: prompt.length,
  });

  const response = await openai.responses.create({
    model: modelConfig.model,
    instructions,
    input: prompt,
    reasoning: {
      effort: modelConfig.reasoningEffort,
    },
    max_output_tokens: modelConfig.maxOutputTokens,
  });

  const text = response.output_text?.trim();
  if (text && text.length > 0) {
    logInfo("openai.response", {
      model: modelConfig.model,
      responseChars: text.length,
      responseId: response.id,
    });
    return text;
  }

  throw new Error("OpenAI did not return output text.");
}

async function buildCheckinAddOn(raw: string, personality: string): Promise<string> {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return "";
  }

  const rewriteInstructions = [
    personality,
    "Rewrite organizer instructions into one direct line addressed to the team.",
    "Voice must be organizer-to-team, not teammate-to-team.",
    "Use second-person language (you/your team).",
    "Do not use first-person team voice (we/us/our).",
    "Output only the final message text.",
    "Keep it short, natural, conversational, and specific.",
    "Do not mention the organizer request itself.",
    "Do not include labels, quotes, or explanations.",
  ].join("\n");

  const rewritePrompt = [
    "Convert this add-on request into the exact line Poly should post in team chat.",
    "Examples:",
    'Input: "Ask if they are doing a live demo"',
    'Output: "Are you planning to do a live demo?"',
    'Input: "Ask how they are feeling about the 3pm deadline"',
    'Output: "How are you all feeling about the 3pm deadline, and are you on track?"',
    `Request: ${compact}`,
  ].join("\n");

  try {
    const rewritten = await askOpenAI(rewritePrompt, rewriteInstructions);
    const finalLine = rewritten.trim();
    if (finalLine.length > 0) {
      return `\n\n${finalLine}`;
    }
  } catch {
    logInfo("command.checkin.addon.rewrite.fallback", { reason: "openai_error" });
  }

  return `\n\n${compact}`;
}

async function runStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  logInfo("command.status.start", {
    byUserId: interaction.user.id,
    commandChannelId: interaction.channelId,
  });
  const guild = await getGuildOrThrow();
  const info = await loadHackathonInfo();
  if (!info.ready) {
    await interaction.editReply(info.reason ?? "Hackathon info doc is required.");
    logInfo("command.status.blocked", { reason: info.reason ?? "missing_hackathon_info" });
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
  logInfo("command.status.done", {
    chunks: chunks.length,
    reportChars: report.length,
  });
}

async function runSend(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const message = interaction.options.getString("message", true).trim();
  const target = interaction.options.getString("target") ?? "all";
  logInfo("command.send.start", {
    byUserId: interaction.user.id,
    commandChannelId: interaction.channelId,
    target,
    messageChars: message.length,
  });

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
      logInfo("command.send.sent", { channel: channel.name, channelId: channel.id, target });
    } catch {
      failed.push(channel.name);
      logInfo("command.send.failed", { channel: channel.name, channelId: channel.id, target });
    }
  }

  const summary = [
    `Sent message to ${sent.length}/${selectedChannels.length} channels.`,
    sent.length > 0 ? `Delivered: ${sent.join(", ")}` : "Delivered: none",
    failed.length > 0 ? `Failed: ${failed.join(", ")}` : "Failed: none",
  ].join("\n");

  await interaction.editReply(summary);
  logInfo("command.send.done", {
    target,
    delivered: sent.length,
    failed: failed.length,
  });
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
  logInfo("standby.mention.received", {
    channel: channel.name,
    channelId: channel.id,
    fromUserId: message.author.id,
    messageId: message.id,
  });

  const transcript = await buildTranscript(channel, client.user.id);
  logInfo("standby.transcript.loaded", {
    channel: channel.name,
    channelId: channel.id,
    messages: transcript.messages.length,
    latestCheckin: transcript.latestCheckinNumber ?? "none",
  });
  const promptConfig = await loadPromptConfig();
  const info = await loadHackathonInfo();
  const userQuestion = stripBotMention(message.content, client.user.id);
  const ownerMention = `<@${config.OWNER_USER_ID}>`;
  const infoDocForStandby = info.ready
    ? info.text
    : "No hackathon context doc is currently filled. Use only channel context and general helpful behavior.";

  const standbySystemInstructions = renderTemplate(promptConfig.standbySystemInstructions, {
    personality: promptConfig.personality,
  });
  const prompt = renderTemplate(promptConfig.standbyUserTemplate, {
    owner_user_id: config.OWNER_USER_ID,
    info_doc: infoDocForStandby,
    channel_transcript: renderTranscriptForPrompt(transcript),
    user_question: userQuestion || "[No extra text provided beyond mention]",
  });

  const rawDecision = await askOpenAI(prompt, standbySystemInstructions);
  const decision = parseStandbyDecision(rawDecision);

  if (decision.action === "REPLY") {
    await channel.send(decision.message);
    logInfo("standby.reply.sent", {
      channel: channel.name,
      channelId: channel.id,
      responseChars: decision.message.length,
    });
    return;
  }

  const guild = message.guild;
  const control = await guild.channels.fetch(config.POLY_CONTROL_CHANNEL_ID);
  await channel.send(
    renderTemplate(promptConfig.standbyEscalationMessage, {
      owner_user_id: config.OWNER_USER_ID,
    }),
  );
  logInfo("standby.escalated", {
    channel: channel.name,
    channelId: channel.id,
    reason: decision.reason,
  });

  if (control && control.type === ChannelType.GuildText) {
    const issueSummary =
      decision.reason.length > 140 ? `${decision.reason.slice(0, 137).trimEnd()}...` : decision.reason;
    const escalation = `${ownerMention} hey, ${channel.toString()} is having an issue (${issueSummary}). take a look: ${message.url}`;
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
  logInfo("bot.ready", { user: tag });

  try {
    await loadPromptConfig();
    logInfo("prompt.config.loaded");
  } catch (error) {
    console.error("Prompt config error:", error);
  }

  try {
    const modelConfig = await loadModelConfig();
    logInfo("model.config.loaded", {
      model: modelConfig.model,
      reasoningEffort: modelConfig.reasoningEffort,
      maxOutputTokens: modelConfig.maxOutputTokens,
    });
  } catch (error) {
    console.error("Model config error:", error);
  }

  const info = await loadHackathonInfo();
  if (!info.ready) {
    console.warn(info.reason);
  } else {
    logInfo("hackathon.info.loaded", { chars: info.text.length });
  }

  try {
    const guild = await getGuildOrThrow();
    await registerCommands(guild);
    logInfo("commands.synced", { guildId: guild.id });
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
