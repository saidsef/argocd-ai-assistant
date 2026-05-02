import { QueryProvider } from "../model/provider";
import { LlmProvider } from "./llmProvider";

export enum Provider {
  LLM = "LLM"
}

export function createProvider(provider: Provider): QueryProvider {
    return new LlmProvider();
}
