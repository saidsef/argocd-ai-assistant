export const FeatureFlags = {
  ArgoCDMCP: 'mcp-for-argocd'
} as const;

export type FeatureFlagName = typeof FeatureFlags[keyof typeof FeatureFlags];

const userFeatureFlags: Record<FeatureFlagName, boolean> = {
  [FeatureFlags.ArgoCDMCP]: false
};

export function isFeatureEnabled(flagName: FeatureFlagName): boolean {
  return userFeatureFlags[flagName] || false;
}
