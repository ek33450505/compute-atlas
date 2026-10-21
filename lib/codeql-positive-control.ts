// DO NOT MERGE. CodeQL positive control (backlog N-1), on a scratch branch only.
//
// Two deliberate, well-known flaws in a production path (lib/, which the
// advanced-setup config extracts). If the javascript-typescript analysis is
// alive, it must report both on this branch's PR:
//   - js/incomplete-url-substring-sanitization (substring host check)
//   - js/incomplete-hostname-regexp (unescaped "." in a hostname regexp)
// The PR is closed unmerged once the alerts are confirmed.

export function isTrustedRedirect(target: string): boolean {
  return target.indexOf("compute-atlas.com") !== -1;
}

export function isOwnHost(host: string): boolean {
  return /^(www|api).compute-atlas.com$/.test(host);
}
