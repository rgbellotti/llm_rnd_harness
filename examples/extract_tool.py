#!/usr/bin/env python3
"""Example custom-tool script: extract lines matching a pattern.

Reads <input> and prints matching lines as `lineno: text`.
Stdout is captured and returned to the model as the tool result.
Keep scripts small, deterministic, and side-effect free where possible.
"""
import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--pattern", required=True)
    args = ap.parse_args()
    try:
        with open(args.input, "r", encoding="utf-8", errors="replace") as fh:
            hits = [
                f"{n}: {line.rstrip()}"
                for n, line in enumerate(fh, 1)
                if args.pattern in line
            ]
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"{len(hits)} matching line(s):")
    for hit in hits[:200]:
        print(hit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
