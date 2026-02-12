import { TextChannel } from "discord.js";
import { CHECKIN_MARKER_REGEX } from "./config.js";

export type TranscriptMessage = {
  id: string;
  authorId: string;
  authorName: string;
  createdAt: Date;
  content: string;
};

export type ChannelTranscript = {
  channelId: string;
  channelName: string;
  messages: TranscriptMessage[];
  latestCheckinNumber: number | null;
  latestCheckinTimestamp: Date | null;
};

function cleanContent(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length === 0 ? "[no text]" : compact;
}

function formatMessageLine(msg: TranscriptMessage): string {
  return `[${msg.createdAt.toISOString()}] ${msg.authorName}: ${msg.content}`;
}

export async function fetchAllMessages(channel: TextChannel): Promise<TranscriptMessage[]> {
  const all: TranscriptMessage[] = [];
  let before: string | undefined;

  while (true) {
    const page = await channel.messages.fetch({ limit: 100, before });
    if (page.size === 0) {
      break;
    }

    const batch = [...page.values()].map((m) => ({
      id: m.id,
      authorId: m.author.id,
      authorName: m.member?.displayName ?? m.author.username,
      createdAt: m.createdAt,
      content: cleanContent(m.content),
    }));
    all.push(...batch);
    before = page.lastKey();
  }

  all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return all;
}

export async function buildTranscript(channel: TextChannel, botUserId: string): Promise<ChannelTranscript> {
  const messages = await fetchAllMessages(channel);

  let latestCheckinNumber: number | null = null;
  let latestCheckinTimestamp: Date | null = null;

  for (const message of messages) {
    if (message.authorId !== botUserId) {
      continue;
    }

    const markerMatch = message.content.match(CHECKIN_MARKER_REGEX);
    if (!markerMatch) {
      continue;
    }

    latestCheckinNumber = Number(markerMatch[1]);
    latestCheckinTimestamp = message.createdAt;
  }

  return {
    channelId: channel.id,
    channelName: channel.name,
    messages,
    latestCheckinNumber,
    latestCheckinTimestamp,
  };
}

export function renderTranscriptForPrompt(transcript: ChannelTranscript): string {
  const header = [
    `Channel: ${transcript.channelName}`,
    `Latest check-in number: ${transcript.latestCheckinNumber ?? "none found"}`,
    `Latest check-in timestamp: ${transcript.latestCheckinTimestamp?.toISOString() ?? "none found"}`,
    "Messages:",
  ].join("\n");

  const body = transcript.messages.map(formatMessageLine).join("\n");
  return `${header}\n${body || "[No messages in this channel]"}`;
}
