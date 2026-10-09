import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when the calling module is the process entrypoint (i.e. run as a CLI,
 * not imported). Callers pass their own `import.meta.url`.
 *
 * The naive `import.meta.url === \`file://${process.argv[1]}\`` is false when
 * argv[1] goes through a symlink (macOS tmpdir lives under the /private
 * symlink) or contains characters URL-encoding changes (spaces). The script
 * then does nothing and exits 0, silently. Resolving the real path and
 * building the URL with pathToFileURL fixes both.
 *
 * Leaf module: keep it free of imports from other scripts.
 */
export function isEntrypoint(
  importMetaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (argv1 === undefined) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
