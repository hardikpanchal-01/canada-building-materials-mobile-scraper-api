import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { getModelDef, DEFAULT_MODEL_ID } from "./models.mjs";

export function getModel(
  modelId = DEFAULT_MODEL_ID,
  keys = {},
) {
  const def = getModelDef(modelId);

  if (def.provider === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: keys.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
    });
    return anthropic(def.id);
  }

  if (def.provider === "azure") {
    // Microsoft Copilot is backed by an Azure OpenAI resource. `resourceName`
    // is the Azure resource (https://<resourceName>.openai.azure.com); the
    // value passed to azure() is the *deployment* name, not an OpenAI model id.
    const azure = createAzure({
      resourceName: keys.azureResourceName || process.env.AZURE_OPENAI_RESOURCE_NAME,
      apiKey: keys.azureApiKey || process.env.AZURE_OPENAI_API_KEY,
    });
    return azure(
      keys.azureDeployment || process.env.AZURE_OPENAI_DEPLOYMENT || def.id,
    );
  }

  const google = createGoogleGenerativeAI({
    apiKey: keys.googleApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  });
  return google(def.id);
}

export const model = getModel(DEFAULT_MODEL_ID);
