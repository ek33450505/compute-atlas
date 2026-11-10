/**
 * People and organizations who support the atlas and asked to be named.
 *
 * Opt-in only: the maintainer adds a name by hand when a sponsor or tipper says
 * yes. Institutions are listed while a commercial license runs or, for a one-off
 * institutional contribution, for 12 months (after which the maintainer
 * removes the entry).
 */
export interface Supporter {
  name: string;
  url?: string;
  kind: "individual" | "institution";
}

export const SUPPORTERS: readonly Supporter[] = [];
