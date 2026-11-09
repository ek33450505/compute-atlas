/** Kill switch for approved-access dataset sharing; routes check it before any DB or body work. */
export function isDatasetSharingEnabled(): boolean {
  return process.env.DATASET_SHARING_ENABLED === "true";
}
