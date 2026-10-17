#!/usr/bin/env python3
"""Black-box regression: run after building the release benchmark example."""

import os
from pathlib import Path
import subprocess
import sys


def check(binary):
    cases = [
        ([b"--help"], 0),
        ([b"--unknown-CANARY"], 1),
        ([b"\xffCANARY-NETWORK-PASSWORD"], 1),
        ([b"--soak", b"\xffCANARY-NETWORK-PASSWORD"], 1),
    ]
    for arguments, expected_code in cases:
        result = subprocess.run(
            [os.fsencode(binary), *arguments], capture_output=True, timeout=3
        )
        assert result.returncode == expected_code, result.returncode
        output = result.stdout + result.stderr
        assert b"Usage:" in output
        assert b"CANARY" not in output
        assert b"panicked" not in output
        assert len(output) < 1024
        assert not (result.stderr if expected_code == 0 else result.stdout)
    print("PASS benchmark CLI: help and three redacted invalid-argument cases")


if __name__ == "__main__":
    assert len(sys.argv) == 2, "Usage: benchmark_cli.py /path/to/benchmark"
    check(Path(sys.argv[1]).resolve(strict=True))
