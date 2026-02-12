import { promises as fs } from "node:fs";
import path from "node:path";

const MODEL_CONFIG_FILE = path.join(process.cwd(), "config", "openai.json");
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

export type ModelConfig = {
  model: string;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxOutputTokens?: number;
};

export async function loadModelConfig(): Promise<ModelConfig> {
  const raw = await fs.readFile(MODEL_CONFIG_FILE, "utf8");
  const parsed = JSON.parse(raw) as Partial<ModelConfig>;

  if (typeof parsed.model !== "string" || parsed.model.trim().length === 0) {
    throw new Error(`Model config is missing a non-empty "model" in ${MODEL_CONFIG_FILE}`);
  }

  if (typeof parsed.reasoningEffort !== "string" || !REASONING_EFFORTS.has(parsed.reasoningEffort)) {
    throw new Error(
      `Model config must include valid "reasoningEffort" in ${MODEL_CONFIG_FILE}. Allowed: none|minimal|low|medium|high|xhigh`,
    );
  }

  if (
    parsed.maxOutputTokens !== undefined &&
    (!Number.isInteger(parsed.maxOutputTokens) || parsed.maxOutputTokens <= 0)
  ) {
    throw new Error(`If set, "maxOutputTokens" must be a positive integer in ${MODEL_CONFIG_FILE}`);
  }

  return parsed as ModelConfig;
}
