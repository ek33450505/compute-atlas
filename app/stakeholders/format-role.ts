/**
 * Human-readable label for a stakeholder role, e.g. "controlling_owner" ->
 * "Controlling owner". Derives the label mechanically from the enum value
 * (`stakeholderRoleEnum` in lib/schema.ts) rather than a hand-maintained
 * lookup table, so a role added to the enum renders sensibly with no edit
 * here. Shared by the /stakeholders index and per-person hub.
 */
export function formatStakeholderRole(role: string): string {
  const spaced = role.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
