export const MODELS = [
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "google",
    tagline: "Fastest",
    tier: "fast",
    inputPricePer1M: 0.3,
    outputPricePer1M: 2.5,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    tagline: "Balanced",
    tier: "balanced",
    inputPricePer1M: 3.0,
    outputPricePer1M: 15.0,
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    provider: "anthropic",
    tagline: "Most powerful",
    tier: "powerful",
    inputPricePer1M: 15.0,
    outputPricePer1M: 75.0,
  },
  {
    // "Copilot" is the display brand; the engine is a Microsoft Azure OpenAI
    // deployment (GPT-4o-class). The actual Azure deployment name is resolved
    // from AZURE_OPENAI_DEPLOYMENT at request time (see provider.ts), so this
    // `id` is only used as the stable selector value + audit/usage key.
    id: "copilot",
    label: "Copilot",
    provider: "azure",
    tagline: "Microsoft Copilot",
    tier: "copilot",
    inputPricePer1M: 2.5,
    outputPricePer1M: 10.0,
  },
];

export const DEFAULT_MODEL_ID = "gemini-2.5-flash";

export function getModelDef(id) {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}
