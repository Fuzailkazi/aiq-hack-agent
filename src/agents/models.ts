/** Provider-switchable model factory for ADK agents. */
import type { BaseLlm } from "@google/adk";
import { type ModelsConfig, modelFor, type Provider, type Role } from "../config";
import { OpenAILlm } from "./openaiLlm";

export type Model = string | BaseLlm;

/** Gemini: the model id string (resolved natively by ADK). OpenAI: our Chat Completions adapter. */
export function buildModel(provider: Provider, role: Role, models: ModelsConfig): Model {
  const id = modelFor(models, provider, role);
  return provider === "openai" ? new OpenAILlm(id) : id;
}
