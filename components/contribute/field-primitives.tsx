// ---------------------------------------------------------------------------
// Field-level error primitives (from a Zod `issues` array on a 400 response)
// — extracted out of contribute-facility-form.tsx so suggest-correction.tsx
// can reuse the same parsing/rendering without duplicating it. Moved
// verbatim; no behavior change.
// ---------------------------------------------------------------------------

export type FieldIssues = Record<string, string>;

interface ZodIssue {
  path: (string | number)[];
  message: string;
}

export function issuesToFieldMap(issues: unknown): FieldIssues {
  const map: FieldIssues = {};
  if (!Array.isArray(issues)) return map;
  for (const issue of issues) {
    if (
      issue &&
      typeof issue === "object" &&
      "path" in issue &&
      "message" in issue &&
      Array.isArray((issue as { path: unknown }).path)
    ) {
      const path = String((issue as ZodIssue).path[0] ?? "");
      if (path) map[path] = String((issue as ZodIssue).message);
    }
  }
  return map;
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}
