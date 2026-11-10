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
  "These terms may change. A free renewal is made under the terms current at that time.",
];

/** Terms for commercial subscriptions, applied on top of DATASET_ACCESS_TERMS (final; bump DATASET_TERMS_VERSION in lib/dataset-grants.ts whenever this text changes). */
export const DATASET_COMMERCIAL_TERMS: readonly string[] = [
  "A commercial subscription is for companies, consultancies, investors, law firms and other non-educational organizations. It gives one named person weekly access to the dataset through a personal link. The link must not be shared. Access for a team is by arrangement through /contact.",
  "Don't share the personal link. The downloaded data remains licensed CC BY 4.0 and must be credited. These terms never narrow that licence.",
  "The price is $150 per month or $1,500 per year, plus applicable tax, billed by Stripe. A subscription renews until cancelled, and continues under the terms accepted at checkout until it is cancelled.",
  "Cancel at any time from \"Manage billing\" on the download page. Access continues to the end of the paid period.",
  "There are no refunds for partial periods, except where the law requires one or where a purchase is refused (for example a duplicate subscription or a revoked buyer), which is refunded automatically.",
  "Access may be revoked for misuse such as sharing links, and a revoked subscription is cancelled. After a revocation, new subscriptions using the same email address or Stripe account, or the same payment card where Stripe identifies it, are refused until the revoked grant is deleted, about 365 days after revocation.",
  "Free access for students, academics, journalists, nonprofits and government is separate and is reviewed by hand.",
];

/** Privacy notice for dataset access requests (final; bump DATASET_TERMS_VERSION in lib/dataset-grants.ts whenever this text changes). */
export const DATASET_PRIVACY_NOTICE: readonly string[] = [
  "Compute Atlas, operated by Edward Kubiak, is responsible for this data.",
  "A request stores the email, name, organization, role, category, intended use and links entered in the form, plus a hashed IP address.",
  "Each download through a personal link is logged with its time, the file and a hashed IP address. Each email sent is logged with the address stored only as a salted hash.",
  "These are used to review the request, to send access and edition email, and to trace a file found outside its grant back to that grant.",
  "This information is not sold, and is not used for marketing.",
  "Unverified requests are deleted after 7 days. Rejected requests are deleted 180 days after review. Revoked or expired grants are deleted 365 days after revocation or expiry, with their download records. The hashed IP on a request is cleared 90 days after review. Download records are deleted after 365 days, and their hashed IPs are cleared after 90 days. Email logs are deleted after 180 days. Commercial grants follow the same deletion schedule as other grants, so a revoked commercial grant, and the refusal of a repeat subscription that depends on it, ends when the revoked grant is deleted, about 365 days after revocation. Deleted or cleared records, including cleared hashed IPs, are copied to a local backup first, and that backup is deleted after 30 days. Deletions run at scheduled maintenance passes, so each can land a few days after its period.",
  "Data is processed by Vercel, Neon, Resend, Cloudflare and Stripe.",
  "For a commercial subscription, the email and name come from Stripe Checkout (the name falls back to the email if Stripe supplies none), along with the organization entered at checkout. The site stores the Stripe customer, subscription and checkout session ids, the paid-through date, the terms version, and a one-way hash of the card's fingerprint (never the card number), used only to enforce revocations. This is done to provide the service you asked for and to prevent misuse.",
  "A decision record for each checkout session keeps the session id, subscription id, invoice id, amount, outcome, refusal reason, timestamp and the linked grant ids (cleared when the grant is deleted), with no name or email. It is kept indefinitely, beyond the grant deletion schedule above, to prevent refund and access errors.",
  "Stripe event ids and types are logged, and processed Stripe event records are deleted after 90 days. Checkout and billing-portal attempts are rate-limited using hashed IP addresses, and those attempt records are deleted after 2 days.",
  "Stripe holds payment and billing details, and may collect a billing address, under its own privacy policy.",
  "To ask for a copy of your data, a correction or deletion, use the contact page at /contact.",
];
