#!/usr/bin/env python3
"""Open the real model-configurator scope dialog in an isolated OpenCode PTY."""

from __future__ import annotations

import argparse
import os
import pty
import re
import select
import signal
import sys
import time
from pathlib import Path


ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|P[^\x1b]*(?:\x1b\\))")
SCOPE_TITLE = "Configuration scope"
FAILURE_TITLE = "Model configurator failed"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("project")
    parser.add_argument("log")
    return parser.parse_args()


def visible(output: bytearray) -> str:
    return ANSI.sub("", output.decode(errors="replace"))


def main() -> int:
    args = parse_args()
    pid, descriptor = pty.fork()
    if pid == 0:
        os.execve(
            args.binary,
            [args.binary, args.project, "--print-logs", "--log-level", "DEBUG"],
            os.environ.copy(),
        )

    output = bytearray()
    started = time.monotonic()
    typed = False
    submitted = False
    success = False
    try:
        while time.monotonic() - started < 25:
            readable, _, _ = select.select([descriptor], [], [], 0.1)
            if readable:
                try:
                    output.extend(os.read(descriptor, 65536))
                except OSError:
                    break
            rendered = visible(output)
            elapsed = time.monotonic() - started
            if not typed and elapsed >= 8:
                os.write(descriptor, b"/model-configurator")
                typed = True
            if typed and not submitted and elapsed >= 10:
                os.write(descriptor, b"\r")
                submitted = True
            if FAILURE_TITLE in rendered:
                break
            if SCOPE_TITLE in rendered:
                success = True
                os.write(descriptor, b"\x1b")
                break
    finally:
        Path(args.log).write_bytes(output)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

    if success:
        print("PASS shouldOpenScopeDialogWhenSlashCommandRuns")
        return 0
    print(f"FAIL scope dialog did not open; inspect {args.log}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
