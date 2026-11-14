import { compareModelStrength } from "./cliProxyApi";
import { cliProxyModelCapability, cliProxyModelVendor } from "./cliProxyModelCatalog";

interface ModelIdentity { id: string; ownedBy?: string | null }
export interface PickerModelGroup<T> { brand: string | null; models: T[] }

const names = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function modelName(id: string): string {
  const parts = id.trim().toLowerCase().split("/");
  return (parts[parts.length - 1] ?? "").replace(/\[[^\]]*\]$/, "");
}

function brandOf(model: ModelIdentity): string | null {
  if (/^(opus|sonnet|haiku)(?:[-.]|$)/.test(modelName(model.id))) return "Anthropic";
  const maker = cliProxyModelVendor({ id: model.id, ownedBy: null });
  if (maker) return maker;
  const owner = model.ownedBy?.trim() || null;
  // These values identify a route (or missing metadata), not a model maker.
  return owner && /^(antigravity|cliproxyapi|unknown|none)$/i.test(owner) ? null : owner;
}

/** Product-family tiers, not benchmark scores. Versions only break tier ties. */
function tier(model: ModelIdentity, brand: string | null): number {
  const name = modelName(model.id);
  if (cliProxyModelCapability({ id: model.id, ownedBy: null }) !== "text") return 100;
  const has = (part: string) => new RegExp(`(?:^|[-_.])${part}(?:$|[-_.])`).test(name);
  switch (brand?.toLowerCase()) {
    case "anthropic": return has("opus") ? 0 : has("sonnet") ? 1 : has("haiku") ? 2 : 3;
    case "google": return has("ultra") ? 0 : has("pro") ? 1 : has("lite") ? 3 : has("flash") ? 2 : 4;
    case "openai": return has("pro") ? 0 : has("nano") ? 3 : has("mini") ? 2 : 1;
    case "mistral": return has("large") ? 0 : has("medium") ? 1 : has("small") ? 2 : 3;
    default: return 0;
  }
}

function versionName(id: string): string {
  // A snapshot date is not a model generation or a Claude minor version.
  return modelName(id).replace(/[-_.](?:19|20)\d{6}(?=[-_.]|$)/g, "");
}

/** Group by maker (not proxy channel), then family tier and descending version. */
export function groupPickerModels<T>(models: readonly T[], identify: (model: T) => ModelIdentity): PickerModelGroup<T>[] {
  const groups = new Map<string | null, PickerModelGroup<T>>();
  for (const model of models) {
    const brand = brandOf(identify(model));
    const key = brand?.toLowerCase() ?? null;
    const group = groups.get(key);
    if (group) group.models.push(model);
    else groups.set(key, { brand, models: [model] });
  }
  return [...groups.values()].sort((left, right) => left.brand === null ? (right.brand === null ? 0 : 1)
    : right.brand === null ? -1 : names.compare(left.brand, right.brand)).map(group => ({
      ...group,
      models: group.models.sort((left, right) => {
        const a = identify(left), b = identify(right);
        return tier(a, group.brand) - tier(b, group.brand)
          || compareModelStrength(versionName(a.id), versionName(b.id));
      }),
    }));
}
