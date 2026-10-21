import type { EmailSendsTableRow } from "@/app/admin/email-sends/email-sends-table";

/** Result of the address lookup. Deliberately carries no address, hash or input echo. */
export interface LookupState {
  message: string | null;
  rows: EmailSendsTableRow[];
}

export const INITIAL_LOOKUP_STATE: LookupState = { message: null, rows: [] };
