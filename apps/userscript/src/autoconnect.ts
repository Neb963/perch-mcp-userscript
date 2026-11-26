import type { NativeIdentity } from "./native-types.js";

/**
 * A browser tab may renew only a pre-existing exact native Binding. Neither a
 * URL slug nor a matching public Generator is sufficient authorization.
 * Ambiguous matching bindings fail closed instead of silently choosing one.
 */
export function reconnectCandidate(
  workspaces: unknown,
  identity: NativeIdentity,
  browserInstallationId: string,
): Record<string, unknown> | null {
  if (!Array.isArray(workspaces) || !browserInstallationId) return null;
  const matches = workspaces.filter((item): item is Record<string, unknown> => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const w = item as Record<string, unknown>;
    const b = w.binding;
    if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
    const binding = b as Record<string, unknown>;
    return (
      typeof w.id === "string" &&
      w.paused !== true &&
      binding.generatorId === identity.generatorId &&
      binding.draftId === identity.draftId &&
      binding.slug === identity.slug &&
      binding.browserInstallationId === browserInstallationId
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}
