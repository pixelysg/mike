import type { Provider } from "./types";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MAIN_MODELS = ["gpt-5.5", "gpt-5.4"] as const;
export const BEDROCK_MAIN_MODELS = [
    "amazon-bedrock/claude-fable-5",
    "amazon-bedrock/claude-opus-4-8",
    "amazon-bedrock/claude-opus-4-7",
    "amazon-bedrock/claude-opus-4-6",
    "amazon-bedrock/claude-sonnet-4-6",
] as const;

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = ["claude-sonnet-4-6"] as const;
export const GEMINI_MID_MODELS = ["gemini-3.5-flash", "gemini-3-flash-preview"] as const;
export const OPENAI_MID_MODELS = ["gpt-5.4"] as const;
export const BEDROCK_MID_MODELS = ["amazon-bedrock/claude-sonnet-4-6"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.4-lite"] as const;
export const BEDROCK_LOW_MODELS = ["amazon-bedrock/claude-haiku-4-5"] as const;

export const DEFAULT_MAIN_MODEL = "gemini-3-flash-preview";
export const DEFAULT_TITLE_MODEL = "gemini-3.1-flash-lite-preview";
export const DEFAULT_TABULAR_MODEL = "gemini-3-flash-preview";

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...BEDROCK_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...BEDROCK_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
    ...BEDROCK_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    if (model.startsWith("amazon-bedrock/")) return "amazon-bedrock";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    throw new Error(`Unknown model id: ${model}`);
}

// Global cross-region inference profile IDs (verbatim from the AWS Bedrock
// model cards). The "global." prefix routes to the lowest-latency region with
// capacity; switch to a "us."/"eu." prefix if data residency requires it.
const BEDROCK_MODEL_IDS: Record<string, string> = {
    "claude-fable-5": "global.anthropic.claude-fable-5",
    "claude-opus-4-8": "global.anthropic.claude-opus-4-8",
    "claude-opus-4-7": "global.anthropic.claude-opus-4-7",
    "claude-opus-4-6": "global.anthropic.claude-opus-4-6-v1",
    "claude-sonnet-4-6": "global.anthropic.claude-sonnet-4-6",
    "claude-haiku-4-5": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
};

export function bedrockModelId(model: string): string {
    const stripped = model.replace("amazon-bedrock/", "");
    const mapped = BEDROCK_MODEL_IDS[stripped];
    if (!mapped) throw new Error(`No Bedrock model ID mapping for: ${stripped}`);
    return mapped;
}

export function resolveModel(id: string | null | undefined, fallback: string): string {
    if (id && ALL_MODELS.has(id)) return id;
    return fallback;
}
