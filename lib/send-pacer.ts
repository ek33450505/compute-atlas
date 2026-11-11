/** Gap between two sends that reached Resend: 600 ms keeps the API under 2 requests a second. */
export const DATASET_NOTICE_PACE_MS = 600;

/** The wait to run at the top of each send callback. */
export type Pacer = () => Promise<void>;

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns the wait to run at the top of each send callback. The gate invokes the callback only when it has
 * decided to mail, so a suppressed or ineligible grant costs no wait; the first send waits for nothing.
 */
export function makePacer(paceMs: number = DATASET_NOTICE_PACE_MS, sleep: (ms: number) => Promise<void> = realSleep): Pacer {
  let sentOne = false;
  return async () => {
    if (sentOne && paceMs > 0) await sleep(paceMs);
    sentOne = true;
  };
}
