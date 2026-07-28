#!/usr/bin/env python3
"""State helper for the Track B0 self-driving SEO runner.

Manages plans/.seo-runner-state.json, which tracks the SEO visibility
program's per-session progress across launchd-scheduled runs. The file
holds:

    {"current": <id|null>, "sessions": [
        {"id", "branch", "title", "status", "pr", "updated"}, ...
    ]}

Subcommands:

    next <state-file>
        Print the next actionable session as one JSON object on stdout:
        the first session with status "running" or "pr_open" (resume a
        run that didn't finish), else the first "pending" session. Prints
        nothing and exits 3 if no session is actionable. Exits 2 if the
        state file is missing or corrupt.

    set <state-file> <id> <status> [--pr N]
        Update the named session's "status" (and "pr" if given), stamp
        "updated" with the current UTC time, then recompute the top-level
        "current": it becomes <id>, UNLESS status is "merged"/"failed" and
        no other session is left "running"/"pr_open" — then it becomes
        null. Written atomically (temp file + os.replace). Exits 2 if
        <id> is not a known session id.

Stdlib only, per project convention. Errors go to stderr, data to stdout.
Exit 0 on success, 2 on error (missing file, bad id, write failure), 3 for
"next" when nothing is actionable (not an error — the caller checks this
exit code to know the program is complete).
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

RESUMABLE_STATUSES = ("running", "pr_open")


def _load_state(state_file: str) -> dict:
    try:
        with open(state_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        print(f"error: cannot read state file {state_file}: {exc}", file=sys.stderr)
        sys.exit(2)


def _write_state_atomic(state_file: str, state: dict) -> None:
    directory = os.path.dirname(os.path.abspath(state_file)) or "."
    tmp_path = os.path.join(directory, f".{os.path.basename(state_file)}.tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, state_file)
    except OSError as exc:
        print(f"error: cannot write state file {state_file}: {exc}", file=sys.stderr)
        sys.exit(2)


def cmd_next(args: argparse.Namespace) -> None:
    state = _load_state(args.state_file)
    sessions = state.get("sessions", [])

    for session in sessions:
        if session.get("status") in RESUMABLE_STATUSES:
            print(json.dumps(session))
            return

    for session in sessions:
        if session.get("status") == "pending":
            print(json.dumps(session))
            return

    sys.exit(3)


def cmd_set(args: argparse.Namespace) -> None:
    state = _load_state(args.state_file)
    sessions = state.get("sessions", [])

    target = None
    for session in sessions:
        if session.get("id") == args.id:
            target = session
            break

    if target is None:
        print(f"error: session id not found: {args.id}", file=sys.stderr)
        sys.exit(2)

    target["status"] = args.status
    if args.pr is not None:
        target["pr"] = args.pr
    target["updated"] = datetime.now(timezone.utc).isoformat()

    other_active = any(s.get("status") in RESUMABLE_STATUSES for s in sessions)
    if args.status in ("merged", "failed") and not other_active:
        state["current"] = None
    else:
        state["current"] = args.id

    _write_state_atomic(args.state_file, state)


def main() -> None:
    parser = argparse.ArgumentParser(description="SEO runner state helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    next_parser = subparsers.add_parser("next", help="print the next actionable session")
    next_parser.add_argument("state_file")
    next_parser.set_defaults(func=cmd_next)

    set_parser = subparsers.add_parser("set", help="update a session's status")
    set_parser.add_argument("state_file")
    set_parser.add_argument("id")
    set_parser.add_argument("status")
    set_parser.add_argument("--pr", type=int, default=None)
    set_parser.set_defaults(func=cmd_set)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # last-resort guard: callers branch on exit code
        # 0/2/3, so an uncaught traceback (which would otherwise exit 1) must
        # still be mapped to the documented error code.
        print(f"error: unexpected failure: {exc}", file=sys.stderr)
        sys.exit(2)
