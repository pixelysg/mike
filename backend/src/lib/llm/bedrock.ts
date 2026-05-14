import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";
import { toClaudeTools } from "./tools";
import { bedrockModelId } from "./models";

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [key: string]: unknown };

type NativeMessage = {
    role: "user" | "assistant";
    content: string | ContentBlock[];
};

type BedrockCredentials = {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
};

const MAX_TOKENS = 16384;

function parseCredentials(raw?: string | null): BedrockCredentials | null {
    if (!raw?.trim()) return null;
    try {
        return JSON.parse(raw) as BedrockCredentials;
    } catch {
        return null;
    }
}

function client(apiKeyJson?: string | null): AnthropicBedrock {
    const creds = parseCredentials(apiKeyJson);
    return new AnthropicBedrock({
        awsAccessKey: creds?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || "",
        awsSecretKey: creds?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "",
        awsRegion: creds?.region || process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || "us-east-1",
        ...(creds?.sessionToken ? { awsSessionToken: creds.sessionToken } : {}),
    });
}

function toNativeMessages(
    messages: StreamChatParams["messages"],
): NativeMessage[] {
    return messages.map((m) => ({ role: m.role, content: m.content }));
}

export async function streamBedrock(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        enableThinking,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const bedrock = client(apiKeys?.["amazon-bedrock"]);
    const claudeTools = toClaudeTools(tools);
    const resolvedModel = bedrockModelId(model);

    const messages: NativeMessage[] = toNativeMessages(params.messages);
    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const stream = bedrock.messages.stream({
            model: resolvedModel,
            system: systemPrompt,
            messages: messages as Anthropic.MessageParam[],
            tools: claudeTools.length
                ? (claudeTools as unknown as Tool[])
                : undefined,
            max_tokens: MAX_TOKENS,
            ...(enableThinking
                ? ({
                      thinking: { type: "adaptive" },
                      output_config: { effort: "high" },
                  } as unknown as Record<string, unknown>)
                : {}),
        });

        let sawThinking = false;

        stream.on("text", (delta) => {
            callbacks.onContentDelta?.(delta);
        });
        if (enableThinking) {
            stream.on("thinking", (delta) => {
                sawThinking = true;
                callbacks.onReasoningDelta?.(delta);
            });
        }

        const final = await stream.finalMessage();
        if (sawThinking) callbacks.onReasoningBlockEnd?.();
        const stopReason = final.stop_reason;
        const assistantBlocks = final.content as ContentBlock[];

        const toolCalls: NormalizedToolCall[] = [];
        for (const block of assistantBlocks) {
            if (block.type === "text") {
                const txt = (block as { text: string }).text;
                if (typeof txt === "string") fullText += txt;
            } else if (block.type === "tool_use") {
                const tu = block as {
                    id: string;
                    name: string;
                    input: unknown;
                };
                const call: NormalizedToolCall = {
                    id: tu.id,
                    name: tu.name,
                    input: (tu.input as Record<string, unknown>) ?? {},
                };
                callbacks.onToolCallStart?.(call);
                toolCalls.push(call);
            }
        }

        if (stopReason !== "tool_use" || !toolCalls.length || !runTools) {
            break;
        }

        const results = await runTools(toolCalls);

        messages.push({ role: "assistant", content: assistantBlocks });
        messages.push({
            role: "user",
            content: results.map((r) => ({
                type: "tool_result",
                tool_use_id: r.tool_use_id,
                content: r.content,
            })),
        });
    }

    return { fullText };
}

export async function completeBedrockText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { "amazon-bedrock"?: string | null };
}): Promise<string> {
    const bedrock = client(params.apiKeys?.["amazon-bedrock"]);
    const resolvedModel = bedrockModelId(params.model);
    const resp = await bedrock.messages.create({
        model: resolvedModel,
        max_tokens: params.maxTokens ?? 512,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.user }],
    });
    const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    return text;
}

export type { NormalizedToolResult };
