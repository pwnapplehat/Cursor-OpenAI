import type { TokenUsage } from "@cursor/sdk";
import type { ChatCompletionUsage } from "../types/openai";
import { estimateTokens } from "../utils/tokenEstimate";

/**
 * Maps Cursor's `TokenUsage` onto OpenAI's usage shape. Falls back to a
 * clearly-approximate character-based estimate when Cursor did not report
 * real usage for this run (the SDK docs note usage is "absent when none
 * did") - some OpenAI client libraries assume `usage` is always present.
 */
export function toOpenAIUsage(usage: TokenUsage | undefined, fallbackPromptText: string, fallbackCompletionText: string): ChatCompletionUsage {
  if (usage) {
    const promptTokens = usage.inputTokens;
    const completionTokens = usage.outputTokens;
    const totalTokens = usage.totalTokens || promptTokens + completionTokens;
    const result: ChatCompletionUsage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };
    if (usage.cacheReadTokens > 0) {
      result.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens };
    }
    if (usage.reasoningTokens !== undefined) {
      result.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
    }
    return result;
  }

  const promptTokens = estimateTokens(fallbackPromptText);
  const completionTokens = estimateTokens(fallbackCompletionText);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}
