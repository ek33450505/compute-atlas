"use client";

import { createContext, useContext } from "react";

/**
 * Whether the correction dialog offers the "email me when this is reviewed"
 * field. The flag is `SUBMISSION_NOTIFY_ENABLED`, read on the server by
 * `submissionNotifyEnabled()` (lib/submission-notify.ts, server-only, imports
 * the DB client) and passed down as a plain boolean. Defaults to `false`, so a
 * dialog rendered outside a provider never shows or sends the field. Renders
 * no DOM.
 */
const CorrectionNotifyContext = createContext(false);

export function CorrectionNotifyProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return <CorrectionNotifyContext value={enabled}>{children}</CorrectionNotifyContext>;
}

export function useCorrectionNotifyEnabled(): boolean {
  return useContext(CorrectionNotifyContext);
}
