// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * Every outbound subscription email must pass through `sendGated`, every
 * requester-facing dataset-sharing email through `sendGrantGated`, and the
 * maintainer's dataset alert through `sendDatasetAdminNoticeGated`, all in
 * lib/email-gate.ts. Each gate has its OWN set of senders (GATE_SENDERS): a
 * sender inside another gate's callback is a violation, because each gate
 * re-checks different state (a subscription row vs a grant row) before it
 * sends. Structural rules, enforced on the TypeScript AST of every production
 * file:
 *
 *  (a) Any access to Resend's `emails.send` / `emails["send"]` (a call, an
 *      alias, or `.call`/`.bind`/`.apply` on it) appears only inside
 *      `sendViaResend` in lib/email.ts, and `api.resend.com` is named nowhere
 *      else, so nothing can mail around the public senders.
 *  (b) A gated sender is referenced only as (or inside) an argument of ITS
 *      gate's call (the innermost enclosing gate call decides). A direct call, an alias (`const f = send...`),
 *      a renaming import/export (`import { send... as f }`), a string-keyed
 *      access (`m["send..."]`) or a destructure from `import()`/`require`
 *      fails.
 *
 * BOUNDARY: this is a tripwire for honest mistakes, not a proof. It catches
 * direct, aliased, string-keyed and destructured access to the gated senders
 * and to `emails.send` (including `.call`/`.bind` and aliases of it), and raw `api.resend.com`.
 * Transparent wrappers (parentheses, `!`, `as`, `satisfies`, `<T>x`) are
 * unwrapped before matching. Syntax alone cannot see a value that reaches a send through a function parameter (`function f({ send }) {}`)
 * or any path without a recognisable name or receiver. The real controls are
 * code review and the gate's own runtime re-checks.
 *
 *  (c) Every exported `send*` function in lib/email.ts is registered: in a
 *      gate's set in GATE_SENDERS, or in UNGATED_SENDERS with its reason, so a
 *      new sender cannot ship without a decision about its gate.
 *
 * TO GATE ANOTHER SENDER: add its name to the set of the gate it goes through
 * in GATE_SENDERS (`sendGated`: subscription mail; `sendGrantGated`: dataset
 * mail to a requester; `sendDatasetAdminNoticeGated`: the maintainer's dataset
 * alert), and route its call sites through that gate. A sender not yet gated
 * goes in PENDING_SENDERS until it is, usable only in its listed files and
 * never inside a gate callback; the test below fails on a stale
 * PENDING_SENDERS entry, so the list cannot rot.
 */

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "test-results",
  "playwright-report",
]);
const GATE_FILE = join("lib", "email-gate.ts");
const RESEND_OWNER = { file: join("lib", "email.ts"), fn: "sendViaResend" };

/**
 * Gate -> the senders it may carry: usable ONLY inside THAT gate's callback.
 * The digest senders are named here so a direct call cannot slip past.
 */
const GATE_SENDERS: Record<string, ReadonlySet<string>> = {
  // Subscription mail.
  sendGated: new Set([
    "sendConfirmEmail",
    "sendWatchStartedEmail",
    "sendChangeNotification",
    "sendChangeDigestEmail",
    "sendAreaDigestEmail",
  ]),
  // Dataset mail to a requester (the grant row is re-read before each send).
  sendGrantGated: new Set([
    "sendDatasetVerifyEmail",
    "sendDatasetAlreadyActiveEmail",
    "sendDatasetApprovedEmail",
    "sendDatasetRejectedEmail",
    "sendDatasetCommercialRedirectEmail",
    "sendDatasetLinkReissuedEmail",
    "sendDatasetRenewalReminderEmail",
    "sendDatasetEditionNoticeEmail",
  ]),
  // The maintainer's alert about a new dataset request.
  sendDatasetAdminNoticeGated: new Set(["sendDatasetAdminNewRequestEmail"]),
};
const GATE_FNS = Object.keys(GATE_SENDERS);
const GATED_SENDERS = new Set(Object.values(GATE_SENDERS).flatMap((names) => [...names]));

/**
 * Exported senders in lib/email.ts that deliberately bypass every gate. Each
 * answers a message the recipient (or the maintainer) is already part of, so
 * there is no subscription or grant row to re-check.
 */
const UNGATED_SENDERS = new Set([
  "sendContactEmail", // to the maintainer, about a contact-form message already stored
  "sendContactReply", // the maintainer's reply to a contact-form message
  "sendSubmissionReviewedEmail", // one transactional send to a submitter on review; no subscription involved
]);

/**
 * Not gated YET. Each may be used only in its listed files, never inside a
 * gate callback (it belongs to no gate yet). TO GATE ANOTHER SENDER: move its
 * name from PENDING_SENDERS into the set of the gate its call sites will go
 * through (GATE_SENDERS), and route those call sites through that gate; the
 * test fails on a stale PENDING_SENDERS entry. Currently empty.
 */
const PENDING_SENDERS: Record<string, string[]> = {};

const GUARDED = new Set([...GATED_SENDERS, ...Object.keys(PENDING_SENDERS)]);
const RESEND_HOST = "api.resend.com";

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

const lineOf = (sf: ts.SourceFile, n: ts.Node) =>
  sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

const isStringy = (
  n: ts.Node,
): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/** Strips every wrapper that does not change the value: `(x)`, `x!`, `x as T`, `x satisfies T`, `<T>x`, nested any depth. */
function unwrapTransparent(node: ts.Expression): ts.Expression {
  let cur = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

/** Text of a string-literal key, looking through transparent wrappers (`m[("x" as const)]`). */
function keyText(expr: ts.Expression): string | undefined {
  const k = unwrapTransparent(expr);
  return isStringy(k) ? k.text : undefined;
}

/** `emails` as an identifier, `.emails`, or `["emails"]`. */
function isEmailsReceiver(receiver: ts.Expression): boolean {
  const obj = unwrapTransparent(receiver);
  if (ts.isIdentifier(obj)) return obj.text === "emails";
  if (ts.isPropertyAccessExpression(obj)) return obj.name.text === "emails";
  if (ts.isElementAccessExpression(obj))
    return keyText(obj.argumentExpression) === "emails";
  return false;
}

/**
 * ANY access to `send` on an emails receiver, whatever its parent: a call
 * (`x.emails.send(p)`), an alias (`const s = x.emails.send`) or a
 * `.call`/`.bind`/`.apply` (`x.emails["send"].call(x.emails, p)`).
 */
function isResendSendAccess(
  node: ts.Node,
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  if (ts.isPropertyAccessExpression(node))
    return node.name.text === "send" && isEmailsReceiver(node.expression);
  if (ts.isElementAccessExpression(node)) {
    return (
      keyText(node.argumentExpression) === "send" &&
      isEmailsReceiver(node.expression)
    );
  }
  return false;
}

const bindingKey = (el: ts.BindingElement): string | undefined => {
  const key = el.propertyName ?? el.name;
  return ts.isIdentifier(key) || isStringy(key) ? key.text : undefined;
};

const bindsSend = (pattern: ts.ObjectBindingPattern): boolean =>
  pattern.elements.some((el) => bindingKey(el) === "send");

/**
 * `const { send } = x.emails`, `const { send: s } = emails`, and
 * `const { emails: { send } } = resend`: pulls Resend's `send` out without a
 * call expression for `isResendSendAccess` to see.
 */
function isResendSendDestructure(
  node: ts.Node,
): node is ts.VariableDeclaration {
  if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name))
    return false;
  if (
    node.initializer &&
    isEmailsReceiver(node.initializer) &&
    bindsSend(node.name)
  )
    return true;
  return node.name.elements.some(
    (el) =>
      bindingKey(el) === "emails" &&
      ts.isObjectBindingPattern(el.name) &&
      bindsSend(el.name),
  );
}

function insideFunctionNamed(node: ts.Node, name: string): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name?.text === name) return true;
  }
  return false;
}

/**
 * True when `name` sits in an argument of the INNERMOST enclosing gate call and
 * that gate's set carries it. (A pending sender is handled by `checkUse`, by file.)
 */
function insideGateArgument(node: ts.Node, name: string): boolean {
  for (let cur: ts.Node = node; cur.parent; cur = cur.parent) {
    const p = cur.parent;
    if (
      ts.isCallExpression(p) &&
      ts.isIdentifier(unwrapTransparent(p.expression)) &&
      GATE_FNS.includes((unwrapTransparent(p.expression) as ts.Identifier).text) &&
      p.arguments.includes(cur as ts.Expression)
    ) {
      const gate = (unwrapTransparent(p.expression) as ts.Identifier).text;
      return GATE_SENDERS[gate].has(name);
    }
  }
  return false;
}

/** Gates whose set carries `name`, for messages. */
const gatesFor = (name: string): string[] => GATE_FNS.filter((g) => GATE_SENDERS[g].has(name));

/** Names of the `send[A-Z]*` functions a module exports (declarations, consts and export specifiers). */
export function exportedSenderNames(source: string, fileName: string): Set<string> {
  const names = new Set<string>();
  const isSender = (n: string) => /^send[A-Z]/.test(n);
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const stmt of parse(source, fileName).statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && exported(stmt) && isSender(stmt.name.text)) {
      names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt) && exported(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && isSender(d.name.text)) names.add(d.name.text);
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) if (isSender(el.name.text)) names.add(el.name.text);
    }
  }
  return names;
}

/** Identifier is a declaration/import/export name, not a use. */
function isNamePosition(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p) ||
    (ts.isFunctionDeclaration(p) && p.name === id)
  );
}

const nameText = (n: ts.ModuleExportName | undefined): string | undefined =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined;

/** Names in GUARDED that `source` really references: AST identifiers or string keys, never comments. */
export function guardedReferences(source: string, fileName: string): Set<string> {
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && GUARDED.has(node.text) && !isNamePosition(node)) {
      found.add(node.text);
    } else if (isStringy(node) && GUARDED.has(node.text)) {
      found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source, fileName));
  return found;
}

export function findGateViolations(source: string, fileName: string): string[] {
  const sf = parse(source, fileName);
  const out: string[] = [];
  const flag = (n: ts.Node, msg: string) =>
    out.push(`${fileName}:${lineOf(sf, n)} ${msg}`);

  const checkUse = (node: ts.Node, name: string) => {
    if (insideGateArgument(node, name)) return;
    if (name in PENDING_SENDERS && PENDING_SENDERS[name].includes(fileName))
      return;
    const gates = gatesFor(name);
    if (name in PENDING_SENDERS) {
      flag(node, `${name} is not gated yet: use it only in ${PENDING_SENDERS[name].join(", ")}, never inside a gate callback`);
      return;
    }
    const where = gates.length > 0 ? `a ${gates.join("()/")}() callback` : "a gate callback";
    flag(node, `${name} used outside ${where}: route it through ${gates.length > 0 ? gates.join("/") : "its gate"} (a sender inside another gate's callback is a violation)`);
  };

  const visit = (node: ts.Node) => {
    if (isResendSendAccess(node)) {
      if (!(
        fileName === RESEND_OWNER.file &&
        insideFunctionNamed(node, RESEND_OWNER.fn)
      )) {
        flag(
          node,
          `emails.send() outside ${RESEND_OWNER.fn} in ${RESEND_OWNER.file}: send through the public senders`,
        );
      }
    }
    if (isResendSendDestructure(node)) {
      if (!(
        fileName === RESEND_OWNER.file &&
        insideFunctionNamed(node, RESEND_OWNER.fn)
      )) {
        flag(
          node,
          `send destructured from a Resend emails receiver outside ${RESEND_OWNER.fn} in ${RESEND_OWNER.file}`,
        );
      }
    }
    if (
      isStringy(node) &&
      node.text.includes(RESEND_HOST) &&
      fileName !== RESEND_OWNER.file
    ) {
      flag(
        node,
        `${RESEND_HOST} named outside ${RESEND_OWNER.file}: send through the public senders`,
      );
    }
    if (
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (node.text.includes(RESEND_HOST) && fileName !== RESEND_OWNER.file) {
        flag(
          node,
          `${RESEND_HOST} named outside ${RESEND_OWNER.file}: send through the public senders`,
        );
      }
    }
    if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
      const original = nameText(node.propertyName);
      if (original && GUARDED.has(original)) {
        flag(
          node,
          `${original} renamed in an import/export: an alias hides call sites from this guard`,
        );
      }
      return; // children are name positions, handled here
    }
    if (
      ts.isIdentifier(node) &&
      GUARDED.has(node.text) &&
      !isNamePosition(node)
    ) {
      checkUse(node, node.text);
    } else if (
      isStringy(node) &&
      GUARDED.has(node.text) &&
      fileName !== RESEND_OWNER.file
    ) {
      // m["sendConfirmEmail"], { "sendConfirmEmail": f } = await import(...). Not in lib/email.ts, whose senders pass their own names to sendViaResend as log labels.
      checkUse(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function* productionFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        yield* productionFiles(join(dir, entry.name));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)
    ) {
      yield join(dir, entry.name);
    }
  }
}

describe("email send gate guard", () => {
  it("no production file mails around its gate", () => {
    const violations: string[] = [];
    const usedIn = new Map<string, Set<string>>();
    let scanned = 0;
    let sawResend = false;
    let sawGatedCall = false;
    for (const file of productionFiles(ROOT)) {
      const rel = relative(ROOT, file);
      const source = readFileSync(file, "utf-8");
      scanned++;
      if (rel === RESEND_OWNER.file && source.includes("emails.send("))
        sawResend = true;
      if (
        GATE_FNS.some((gate) => source.includes(`${gate}(`)) &&
        [...GATED_SENDERS].some((name) => source.includes(name)) &&
        rel !== GATE_FILE
      )
        sawGatedCall = true;
      violations.push(...findGateViolations(source, rel));
      if (rel !== RESEND_OWNER.file) {
        for (const name of guardedReferences(source, rel)) {
          if (name in PENDING_SENDERS) {
            usedIn.set(name, (usedIn.get(name) ?? new Set()).add(rel));
          }
        }
      }
    }
    // Non-vacuity: the scan reached the one sanctioned send and a real gated call site.
    expect(scanned).toBeGreaterThan(50);
    expect(sawResend).toBe(true);
    expect(sawGatedCall).toBe(true);
    expect(violations).toEqual([]);

    // A pending allowlist entry that no longer references its sender is stale: promote the sender to GATED_SENDERS.
    for (const [name, files] of Object.entries(PENDING_SENDERS)) {
      for (const f of files) {
        expect(
          usedIn.get(name)?.has(f),
          `${f} no longer uses ${name}: move it to GATED_SENDERS`,
        ).toBe(true);
      }
    }
  });

  it("keeps the gate sender sets pairwise disjoint, and disjoint from UNGATED_SENDERS", () => {
    const seen = new Map<string, string>();
    const sets: Array<[string, ReadonlySet<string>]> = [...Object.entries(GATE_SENDERS), ["UNGATED_SENDERS", UNGATED_SENDERS]];
    for (const [setName, names] of sets) {
      for (const n of names) {
        expect(seen.has(n), `${n} is in both ${seen.get(n)} and ${setName}`).toBe(false);
        seen.set(n, setName);
      }
    }
  });

  it("registers every exported send* function in lib/email.ts: gated in some gate's set, or ungated with a reason", () => {
    const exportedNames = exportedSenderNames(readFileSync(join(ROOT, RESEND_OWNER.file), "utf-8"), RESEND_OWNER.file);
    // Non-vacuity: the parser sees the known senders.
    expect(exportedNames.has("sendConfirmEmail")).toBe(true);
    expect(exportedNames.has("sendDatasetVerifyEmail")).toBe(true);

    const unregistered = [...exportedNames].filter((n) => !GATED_SENDERS.has(n) && !UNGATED_SENDERS.has(n));
    expect(unregistered, "add each to its gate's set in GATE_SENDERS, or to UNGATED_SENDERS with a reason").toEqual([]);
    for (const n of UNGATED_SENDERS) {
      expect(exportedNames.has(n), `${n} is in UNGATED_SENDERS but no longer exported`).toBe(true);
      expect(GATED_SENDERS.has(n), `${n} is both gated and ungated`).toBe(false);
    }
  });

  describe("detector (mutation fixtures)", () => {
    it("exportedSenderNames reads declarations, consts and export specifiers, not private or non-send names", () => {
      const names = exportedSenderNames(
        "export async function sendA() {}\nexport const sendB = () => 1;\nfunction sendPrivate() {}\nexport function sender() {}\nexport function sendC() {}\nexport { sendC as sendD };",
        "lib/x.ts",
      );
      expect([...names].sort()).toEqual(["sendA", "sendB", "sendC", "sendD"]);
    });

    const flagged = (code: string, file = "lib/x.ts") =>
      findGateViolations(code, file);

    it.each([
      ["await sendConfirmEmail(c);"],
      ["const f = sendWatchStartedEmail;"],
      ["after(() => sendConfirmEmail(c));"],
      ["sendGated(db, o, send); sendConfirmEmail(c);"],
      ["sendOther(db, o, () => sendConfirmEmail(c));"],
      ["const r = await resend.emails.send(payload);"],
      ["emails.send(payload);"],
      // (a) aliases
      ['import { sendConfirmEmail as f } from "@/lib/email";'],
      ['export { sendConfirmEmail as g } from "@/lib/email";'],
      ['export { sendWatchStartedEmail as "g" } from "@/lib/email";'],
      // (b) string-keyed access, and Resend's send
      ['email["sendConfirmEmail"](c);'],
      ["email[`sendWatchStartedEmail`](c);"],
      ['resend.emails["send"](payload);'],
      ['resend["emails"].send(payload);'],
      ['emails["send"](payload);'],
      // aliasing and indirect invocation of the same member
      ["const s = resend.emails.send; await s(p);"],
      ['const s = resend.emails["send"];'],
      ['const s = resend["emails"].send;'],
      ["await resend.emails.send.call(resend.emails, p);"],
      ["const s = resend.emails.send.bind(resend.emails);"],
      // transparent wrappers do not hide the receiver
      ["(resend.emails).send(p);"],
      ["resend.emails!.send(p);"],
      ["(resend.emails as any).send(p);"],
      ["(resend.emails satisfies X).send(p);"],
      ["((resend.emails as unknown as X)!).send(p);"],
      ["(<X>resend.emails).send(p);"],
      ['resend.emails[("send" as const)](p);'],
      ['(resend["emails" as string] as X).send(p);'],
      ["const { send } = (resend.emails as X);"],
      ["await resend.emails.send.apply(resend.emails, [p]);"],
      ["const { send } = resend.emails;"],
      ["const { send: s } = x.emails;"],
      ['const { "send": s } = x["emails"];'],
      ["const { send } = emails;"],
      ["const { emails: { send } } = resend;"],
      ["const { emails: { send: s } } = new Resend(key);"],
      // (c) the HTTP API
      ['await fetch("https://api.resend.com/emails", init);'],
      ["await fetch(`https://api.resend.com/emails`, init);"],
      ["await fetch(`${base}/x?host=api.resend.com/${p}`, init);"],
      // (d) destructuring from import()/require
      ['const { sendConfirmEmail } = await import("@/lib/email");'],
      ['const { sendConfirmEmail: f } = require("@/lib/email");'],
      ['const { "sendWatchStartedEmail": f } = await import("@/lib/email");'],
      // gated senders called bare, outside a sendGated callback
      ["await sendChangeNotification(x);"],
      ['import { sendChangeNotification as n } from "@/lib/email";'],
    ])("flags %s", (code) => {
      expect(flagged(code)).toHaveLength(1);
    });

    it("flags emails.send() in lib/email.ts outside sendViaResend", () => {
      expect(
        flagged(
          "function other() { return r.emails.send(p); }",
          "lib/email.ts",
        ),
      ).toHaveLength(1);
    });

    it("counts only real references as a use: a comment mention is not one", () => {
      expect(guardedReferences("// sendChangeNotification is pending\n/* sendChangeNotification */ const x = 1;", "lib/x.ts").size).toBe(0);
      expect(guardedReferences("await sendChangeNotification(x);", "lib/x.ts").has("sendChangeNotification")).toBe(true);
    });

    it("allows a gated sender only inside a sendGated callback", () => {
      // No file may call a gated sender bare.
      expect(
        flagged("await sendChangeNotification(x);", join("lib", "notify.ts")),
      ).toHaveLength(1);
      expect(
        flagged(
          "await sendGated(db, o, () => sendChangeNotification(x));",
          join("lib", "notify.ts"),
        ),
      ).toHaveLength(0);
    });

    it("allows each dataset sender only inside its own gate, and flags it beside the gate", () => {
      const pairs = [
        ["sendGrantGated", "sendDatasetVerifyEmail"],
        ["sendDatasetAdminNoticeGated", "sendDatasetAdminNewRequestEmail"],
      ];
      for (const [gate, sender] of pairs) {
        const inside = `await ${gate}(db, o, () => ${sender}(x));`;
        expect(flagged(inside, join("lib", "notify.ts"))).toHaveLength(0);
        expect(flagged(`${inside}\nawait ${sender}(x);`, join("lib", "notify.ts"))).toHaveLength(1);
      }
    });

    it.each([
      ["a subscription sender inside sendGrantGated", "sendGrantGated(db, o, () => sendChangeNotification(x));"],
      ["a subscription sender inside the admin gate", "sendDatasetAdminNoticeGated(db, o, () => sendConfirmEmail(x));"],
      ["a dataset sender inside sendGated", "sendGated(db, o, () => sendDatasetVerifyEmail(x));"],
      ["the admin sender inside sendGrantGated", "sendGrantGated(db, o, () => sendDatasetAdminNewRequestEmail(x));"],
      ["a requester dataset sender inside the admin gate", "sendDatasetAdminNoticeGated(db, o, () => sendDatasetApprovedEmail(x));"],
      ["a sender in the innermost wrong gate of a nested pair", "sendGated(db, o, () => sendGrantGated(db, o, () => sendConfirmEmail(x)));"],
    ])("flags %s", (_label, code) => {
      expect(flagged(code, join("lib", "notify.ts"))).toHaveLength(1);
    });

    it.each([
      ["sendGated(db, o, () => sendConfirmEmail(c));"],
      ["sendGated(db, o, sendWatchStartedEmail);"],
      ["sendGated(getDb(), o, async () => { return sendConfirmEmail(c); });"],
      ["sendGated(db, o, () => sendChangeNotification(x));"],
      ["(sendGated as G)(db, o, () => sendConfirmEmail(c));"],
      ["const { id } = resend.emails;"],
      ["const { send } = mailer;"],
      ["const { emails: { list } } = resend;"],
      // Documented boundary: a parameter's origin is invisible to a syntax-only guard.
      ["function f({ send }: X) { send(p); }"],
      ['import { sendConfirmEmail } from "@/lib/email";'],
      ["export async function sendConfirmEmail() {}"],
      ['const s = "an api host is not the Resend host";'],
    ])("allows %s", (code) => {
      expect(flagged(code)).toHaveLength(0);
    });

    it("allows destructuring send inside sendViaResend only", () => {
      expect(
        flagged(
          "function sendViaResend() { const { send } = r.emails; }",
          "lib/email.ts",
        ),
      ).toHaveLength(0);
      expect(
        flagged(
          "function other() { const { send } = r.emails; }",
          "lib/email.ts",
        ),
      ).toHaveLength(1);
    });

    it("allows emails.send() and the Resend host inside lib/email.ts", () => {
      expect(
        flagged(
          "async function sendViaResend() { return r.emails.send(p); }",
          "lib/email.ts",
        ),
      ).toHaveLength(0);
      expect(
        flagged('const u = "https://api.resend.com";', "lib/email.ts"),
      ).toHaveLength(0);
    });
  });
});
