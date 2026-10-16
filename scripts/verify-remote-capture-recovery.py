"""Run only the five in-process capture recovery regressions; never inject OS input."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

TESTS = (
    "stalled_capture_has_bounded_wait_and_queue_across_retries",
    "unavailable_status_frame_is_valid_and_has_no_input_dimensions",
    "screen_input_generation_rejects_stale_coordinates_and_recovers",
    "authenticated_screen_session_survives_capture_loss_and_recovers",
    "cancelling_while_capture_is_pending_does_not_wait_for_capture",
)


def passed(output, exit_code):
    return exit_code == 0 and re.search(
        r"test result: ok\. 1 passed; 0 failed; 0 ignored;", output
    ) is not None


def main():
    root = Path(__file__).resolve().parent.parent
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if os.environ.get("GITHUB_SHA", sha) != sha:
        raise RuntimeError("Checkout SHA does not match the requested CI revision")
    report = {"sourceCommit": sha, "runId": os.environ.get("GITHUB_RUN_ID"),
              "platform": sys.platform, "scope": "in-process synthetic capture; OS input disabled",
              "tests": []}
    output = root / "remote-capture-recovery-evidence"
    output.mkdir(exist_ok=True)
    for name in TESTS:
        command = ["cargo", "test", "--locked", "--manifest-path", "crates/lattice-remote/Cargo.toml",
                   "--features", "agent", "--bin", "lattice-agent", "tests::" + name, "--", "--exact"]
        try:
            result = subprocess.run(command, cwd=root, text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, timeout=1200)
            log, code = result.stdout, result.returncode
        except subprocess.TimeoutExpired as error:
            log = error.stdout or b""
            if isinstance(log, bytes):
                log = log.decode("utf-8", errors="replace")
            log += "\nTest command exceeded its 1200 second bound.\n"
            code = 124
        (output / (name + ".log")).write_text(log, encoding="utf-8")
        entry = {"name": name, "command": command, "exitCode": code, "passed": passed(log, code)}
        report["tests"].append(entry)
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(name + ": " + ("PASS" if entry["passed"] else "FAIL"), flush=True)
    return 0 if all(test["passed"] for test in report["tests"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
