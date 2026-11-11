/**
 * People and organizations who support the atlas and asked to be named.
 *
 * Opt-in only: the maintainer adds a name by hand when a supporter says yes.
 * Entries are supporters who asked to be named. Institutional entries are listed
 * for 12 months, after which the maintainer removes the entry.
 */
export interface Supporter {
  name: string;
  url?: string;
  kind: "individual" | "institution";
}

export const SUPPORTERS: readonly Supporter[] = [];
