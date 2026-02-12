import { promises as fs } from "node:fs";
import path from "node:path";

export type PromptConfig = {
  personality: string;
  checkinTemplate: string;
  statusSystemInstructions: string;
  statusUserTemplate: string;
  standbySystemInstructions: string;
  standbyUserTemplate: string;
  standbyEscalationMessage: string;
};

const REQUIRED_KEYS: Array<keyof PromptConfig> = [
  "personality",
  "checkinTemplate",
  "statusSystemInstructions",
  "statusUserTemplate",
  "standbySystemInstructions",
  "standbyUserTemplate",
  "standbyEscalationMessage",
];

const PLACEHOLDER_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

export async function loadPromptConfig(): Promise<PromptConfig> {
  const promptPath = path.join(process.cwd(), "prompts", "config.json");
  const raw = await fs.readFile(promptPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<PromptConfig>;

  for (const key of REQUIRED_KEYS) {
    const value = parsed[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Prompt config is missing a non-empty "${key}" in prompts/config.json`);
    }
  }

  return parsed as PromptConfig;
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    out = out.replace(pattern, value);
  }

  const unresolved = [...out.matchAll(PLACEHOLDER_REGEX)].map((m) => m[1]);
  if (unresolved.length > 0) {
    throw new Error(`Template has unresolved placeholders: ${unresolved.join(", ")}`);
  }

  return out;
}
