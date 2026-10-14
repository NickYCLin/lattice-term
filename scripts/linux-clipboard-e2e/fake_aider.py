#!/usr/bin/env python3

"""Nonce-bound, byte-transparent PTY fixture for the Linux clipboard E2E."""

from __future__ import annotations

import os
import re
import sys
import termios
import tty
from pathlib import Path


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing {name}")
    return value


def write_all(fd: int, data: bytes) -> None:
    while data:
        written = os.write(fd, data)
        data = data[written:]


def write_private_file(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        write_all(fd, data)
    finally:
        os.close(fd)


def main() -> int:
    nonce = required_environment("LATTICETERM_E2E_NONCE")
    log_path = Path(required_environment("LATTICETERM_E2E_PTY_LOG"))
    pid_path = Path(required_environment("LATTICETERM_E2E_FAKE_PID_FILE"))
    output_ack_path = Path(required_environment("LATTICETERM_E2E_FAKE_OUTPUT_ACK"))
    trigger = f"E2E_TEXT_CTRL_V_{nonce.replace('-', '_')}".encode()
    # A cursor-position query follows the visible marker. If the output event
    # reaches xterm's parser, xterm must answer with ESC[row;colR through the
    # normal input channel, giving the harness a renderer-independent proof.
    copy_target = f"E2ECOPYTARGET {nonce}\r\n".encode() + b"\x1b[6n"

    os.umask(0o077)
    write_private_file(pid_path, f"{os.getpid()}\n".encode())
    log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    previous_settings = termios.tcgetattr(stdin_fd)
    tty.setraw(stdin_fd, termios.TCSANOW)
    pending = b""
    emitted = False
    image_marker_emitted = False
    image_pending = b""

    try:
        while True:
            chunk = os.read(stdin_fd, 4096)
            if not chunk:
                return 0
            write_all(log_fd, chunk)
            if os.environ.get("LATTICETERM_E2E_DESKTOP_UI") == "1" and not image_marker_emitted:
                image_pending = (image_pending + chunk)[-4096:]
                if re.search(rb"latticeterm-clip-[A-Za-z0-9._-]+\.png", image_pending):
                    write_all(stdout_fd, b"\x1b[2J\x1b[H[Image #1]\r\n\x1b[6n")
                    image_marker_emitted = True
            if not emitted:
                combined = pending + chunk
                if trigger in combined:
                    # The marker is generated only in response to bytes that
                    # traversed WebKit/xterm -> Rust -> the real child PTY.
                    write_all(stdout_fd, copy_target)
                    write_private_file(output_ack_path, b"COPY_TARGET_WRITTEN\n")
                    emitted = True
                pending = combined[-len(trigger) :]
    finally:
        termios.tcsetattr(stdin_fd, termios.TCSANOW, previous_settings)
        os.close(log_fd)


if __name__ == "__main__":
    raise SystemExit(main())
