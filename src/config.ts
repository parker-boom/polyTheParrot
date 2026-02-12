import dotenv from "dotenv";

dotenv.config();

type RequiredConfig = {
  DISCORD_BOT_TOKEN: string;
  OPENAI_API_KEY: string;
  DISCORD_GUILD_ID: string;
  POLY_CONTROL_CHANNEL_ID: string;
  OWNER_USER_ID: string;
  OPENAI_MODEL: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: RequiredConfig = {
  DISCORD_BOT_TOKEN: requireEnv("DISCORD_BOT_TOKEN"),
  OPENAI_API_KEY: requireEnv("OPENAI_API_KEY"),
  DISCORD_GUILD_ID: requireEnv("DISCORD_GUILD_ID"),
  POLY_CONTROL_CHANNEL_ID: requireEnv("POLY_CONTROL_CHANNEL_ID"),
  OWNER_USER_ID: requireEnv("OWNER_USER_ID"),
  OPENAI_MODEL: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
};

export const TEAM_CHANNEL_REGEX = /^team-(\d{1,2})$/i;
export const CHECKIN_MARKER_REGEX = /\[POLY_CHECKIN #(\d+)\]/i;
