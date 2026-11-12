// Dependency-free so presentational components can format a date without importing the data layer.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-11-10" -> "10 November 2026"; anything else comes back unchanged. */
export function formatEditionDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) return iso;
  return `${Number(m[3])} ${month} ${m[1]}`;
}
