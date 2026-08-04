export type ModelConfiguratorOptions = {
  profilesDir?: string
}

export function normalizePluginOptions(raw: unknown): ModelConfiguratorOptions {
  if (!isRecord(raw) || typeof raw.profilesDir !== "string") return {}
  const profilesDir = raw.profilesDir.trim()
  return profilesDir ? { profilesDir } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
