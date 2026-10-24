#!/usr/bin/env python3
"""CLI startup only: three batches of seven help and non-UTF-8 argv calls."""
import datetime
import hashlib
import json
import os
import pathlib
import platform
import statistics
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent
INVALID = b'\xffCANARY-NETWORK-PASSWORD'
CANARY = b'CANARY-NETWORK-PASSWORD'
USAGE = b'Usage: cargo run --release --offline --example benchmark -- [--scale | --soak SECONDS]\nSECONDS must be an integer from 1 to 3600.'
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'LANG': 'C', 'RUST_BACKTRACE': '0'}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def summary(rows):
    times = [row['wall_ms'] for row in rows]
    return {'n': len(times), 'median_ms': statistics.median(times),
            'mean_ms': statistics.mean(times), 'min_ms': min(times),
            'max_ms': max(times), 'stdev_ms': statistics.stdev(times)}


def run(binary, label, workload, batch, number, cwd):
    argument = b'--help' if workload == 'help' else INVALID
    argv = [os.fsencode(binary), argument]
    start = time.perf_counter_ns()
    output = subprocess.run(argv, cwd=cwd, env=ENV, capture_output=True,
                            check=False, timeout=2)
    wall_ms = (time.perf_counter_ns() - start) / 1_000_000
    combined = output.stdout + output.stderr
    leaked = CANARY in combined
    panic = b'panicked' in combined or b'panic' in combined.lower()
    usage = USAGE in combined or USAGE.replace(b'\n', b'\\n') in combined
    if workload == 'help':
        assert output.returncode == 0
        assert output.stdout == USAGE + b'\n' and output.stderr == b''
        assert usage and not leaked and not panic
    elif label == 'before':
        assert output.returncode == 101
        assert output.stdout == b'' and output.stderr
        assert leaked and panic and not usage
    else:
        assert output.returncode == 1
        assert output.stdout == b'' and output.stderr
        assert usage and not leaked and not panic
    return {'workload': workload, 'batch': batch, 'run': number, 'wall_ms': wall_ms,
            'returncode': output.returncode, 'status': 'success' if output.returncode == 0 else 'failure',
            'leaks_canary': leaked, 'panic_present': panic, 'static_usage_present': usage,
            'stdout_hex': output.stdout.hex(), 'stderr_hex': output.stderr.hex(),
            'argv_hex': [value.hex() for value in argv], 'cwd': str(cwd),
            'assertions': 'passed'}


def main():
    assert len(sys.argv) == 3 and sys.argv[1] in ['before', 'after'], 'usage: benchmark_cli_startup.py before|after /absolute/example-binary'
    label, binary = sys.argv[1], pathlib.Path(sys.argv[2]).resolve(strict=True)
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    rows = []
    for batch in range(1, 4):
        cwd = ROOT / 'runs' / label / f'batch-{batch}'
        cwd.mkdir(parents=True, exist_ok=False)
        for workload in ['help', 'non_utf8_argv']:
            for number in range(1, 8):
                rows.append(run(binary, label, workload, batch, number, cwd))
    data = {'label': label, 'started_utc': started,
            'finished_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'binary': str(binary), 'binary_sha256': sha256(binary.read_bytes()),
            'harness_sha256': sha256(pathlib.Path(__file__).read_bytes()),
            'corpus': {'help_arg_hex': b'--help'.hex(), 'non_utf8_arg_hex': INVALID.hex(),
                       'usage_hex': USAGE.hex(), 'batches': 3, 'runs_per_workload_per_batch': 7},
            'environment': {'subprocess_env': ENV, 'system': platform.system(),
                            'release': platform.release(), 'machine': platform.machine(),
                            'python': platform.python_version(), 'logical_cpus': os.cpu_count(),
                            'clock': str(time.get_clock_info('perf_counter'))},
            'summary': {workload: summary([row for row in rows if row['workload'] == workload])
                        for workload in ['help', 'non_utf8_argv']},
            'batch_summaries': {workload: [summary([row for row in rows if row['workload'] == workload and row['batch'] == batch])
                                          for batch in range(1, 4)]
                                for workload in ['help', 'non_utf8_argv']},
            'rows': rows}
    destination = ROOT / f'{label}-results.json'
    destination.write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps({'label': label, 'summary': data['summary'],
                      'batch_summaries': data['batch_summaries'],
                      'result_path': str(destination)}, indent=2))


if __name__ == '__main__':
    main()
