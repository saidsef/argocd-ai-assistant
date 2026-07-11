import { QueryProvider } from "../model/provider";
import { LlmProvider } from "./llmProvider";

export function createProvider(): QueryProvider {
    return new LlmProvider();
}
