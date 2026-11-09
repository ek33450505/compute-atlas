/** Access terms for the approved-access dataset (final; bump DATASET_TERMS_VERSION in lib/dataset-grants.ts whenever this text changes). */
export const DATASET_ACCESS_TERMS: readonly string[] = [
  "The Compute Atlas dataset is licensed CC BY 4.0. These access terms do not narrow that licence; they cover only the personal access link issued to a recipient.",
  "Credit Compute Atlas when publishing work that uses the data.",
  "Credit does not imply endorsement. Do not suggest that Compute Atlas endorses a publication, product or conclusion.",
  "Access is personal to the person it was issued to, and may be revoked at the maintainer's discretion.",
  "Don't share your personal link. The files you download remain licensed CC BY 4.0.",
  "The data is source-cited, not guaranteed, and is provided without warranty of any kind.",
  "To the extent the law allows, Compute Atlas and its operator are not liable for any use of the data.",
  "Files may carry recipient-specific identifiers.",
  "These terms may change. A renewal is made under the terms current at that time.",
];

/** Privacy notice for dataset access requests (final; bump DATASET_TERMS_VERSION in lib/dataset-grants.ts whenever this text changes). */
export const DATASET_PRIVACY_NOTICE: readonly string[] = [
  "Compute Atlas, operated by Edward Kubiak, is responsible for this data.",
  "A request stores the email, name, organization, role, category, intended use and links entered in the form, plus a hashed IP address.",
  "Each download through a personal link is logged with its time, the file and a hashed IP address. Each email sent is logged with the address stored only as a salted hash.",
  "These are used to review the request, to send access and edition email, and to trace a file found outside its grant back to that grant.",
  "This information is not sold, and is not used for marketing.",
  "Unverified requests are deleted after 7 days. Rejected requests are deleted 180 days after review. Revoked or expired grants are deleted 365 days after revocation or expiry, with their download records. The hashed IP on a request is cleared 90 days after review. Download records are deleted after 365 days, and their hashed IPs are cleared after 90 days. Email logs are deleted after 180 days. Deleted or cleared records, including cleared hashed IPs, are copied to a local backup first, and that backup is deleted after 30 days. Deletions run at scheduled maintenance passes, so each can land a few days after its period.",
  "Data is processed by Vercel, Neon, Resend and Cloudflare.",
  "To ask for a copy of your data, a correction or deletion, use the contact page at /contact.",
];
