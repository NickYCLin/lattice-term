import { groupCliProxyModels, type CliProxyModel } from "./cliProxyApi";

/**
 * What a model is for, guessed from its id. CLIProxyAPI's `/v1/models` only
 * returns `id` and `owned_by`, so the name is the only signal available; the
 * UI labels the result as a guess.
 */
export type CliProxyModelCapability = "text" | "image" | "video" | "audio" | "embedding";

/**
 * `owned_by` is often the upstream channel the proxy logged in through
 * (for example `antigravity` serving Claude, Gemini and GPT-OSS alike), so the
 * maker is read from the model id first and `owned_by` is only a fallback.
 */
const VENDORS: readonly [vendor: string, pattern: RegExp][] = [
  ["Anthropic", /^(claude|anthropic)/],
  ["Google", /^(gemini|gemma|imagen|veo|learnlm|lyria|text-embedding-0|embedding-0|nano-banana)/],
  ["OpenAI", /^(gpt|chatgpt|o\d|codex|dall-e|whisper|tts-|text-embedding|omni-moderation|sora|davinci|babbage)/],
  ["xAI", /^grok/],
  ["DeepSeek", /^deepseek/],
  ["Qwen", /^(qwen|qwq|qvq|wan\d)/],
  ["Moonshot", /^(kimi|moonshot)/],
  ["Zhipu", /^(glm|chatglm|cogview|cogvideo)/],
  ["Meta", /^(llama|meta-llama)/],
  ["Mistral", /^(mistral|codestral|devstral|magistral|pixtral|ministral)/],
  ["MiniMax", /^(minimax|abab)/],
];

const CAPABILITIES: readonly [capability: CliProxyModelCapability, pattern: RegExp][] = [
  ["embedding", /embed/],
  ["video", /(^|[-_.])(veo|sora|video|cogvideo|kling|seedance)|wan\d/],
  ["image", /(^|[-_.])(image|imagen|dall-e|flux|cogview|seedream)|nano-banana/],
  ["audio", /(^|[-_.])(tts|voice|audio|speech|whisper|transcribe|realtime|lyria|music)/],
];

function modelName(id: string): string {
  // Proxies sometimes prefix `models/` or `vendor/`; the last segment is the model.
  const segments = id.trim().toLowerCase().split("/");
  return segments[segments.length - 1] ?? "";
}

export function cliProxyModelVendor(model: CliProxyModel): string | null {
  const id = model.id.trim().toLowerCase();
  const name = modelName(model.id);
  const match = VENDORS.find(([, pattern]) => pattern.test(name) || pattern.test(id));
  return match?.[0] ?? (model.ownedBy?.trim() || null);
}

export function cliProxyModelCapability(model: CliProxyModel): CliProxyModelCapability {
  const name = modelName(model.id);
  return CAPABILITIES.find(([, pattern]) => pattern.test(name))?.[0] ?? "text";
}

export interface CliProxyCatalogEntry {
  model: CliProxyModel;
  capability: CliProxyModelCapability;
}

export interface CliProxyVendorGroup {
  vendor: string | null;
  models: CliProxyCatalogEntry[];
}

/** Models grouped by maker, strongest first, unknown makers last. */
export function cliProxyCatalogByVendor(models: readonly CliProxyModel[]): CliProxyVendorGroup[] {
  // Group on the maker but keep each original entry, so the proxy's own
  // `owned_by` channel is still shown and duplicate ids stay distinct.
  type Keyed = CliProxyModel & { original: CliProxyModel };
  const keyed: Keyed[] = models.map(model => ({ id: model.id, ownedBy: cliProxyModelVendor(model), original: model }));
  return groupCliProxyModels(keyed).map(group => ({
    vendor: group.brand,
    models: (group.models as readonly Keyed[]).map(({ original }) => ({
      model: original, capability: cliProxyModelCapability(original),
    })),
  }));
}
