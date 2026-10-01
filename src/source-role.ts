export const SOURCE_ROLES = ["primary", "backup"] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export function isSourceRole(value: string): value is SourceRole {
  return SOURCE_ROLES.some((source) => source === value);
}

export function sourcePublicationMode(
  activeSource: SourceRole | null,
  source: SourceRole,
): "publish" | "standby" {
  return activeSource === source || (!activeSource && source === "primary") ? "publish" : "standby";
}
