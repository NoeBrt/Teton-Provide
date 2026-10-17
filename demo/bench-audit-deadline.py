#!/usr/bin/env python3
"""Controlled audit-host CLI corpus: 3x7 success, 3 exited-parent pipe holders."""
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
BUSCTL = r'''#!/bin/sh
printf '%s\n' "busctl $*" >> "$AUDIT_BENCH_CALL_LOG"
case "$*" in
'--system --no-pager --auto-start=no call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetNameOwner s org.bluez') printf 's ":1.23"\n' ;;
'--system --no-pager get-property :1.23 /org/bluez/hci0 org.bluez.Adapter1 Powered') printf 'b true\n' ;;
'--system --no-pager introspect :1.23 /org/bluez/hci0 org.bluez.GattManager1') printf '.RegisterApplication method oa{sv} - -\n' ;;
'--system --no-pager introspect :1.23 /org/bluez/hci0 org.bluez.LEAdvertisingManager1') printf '.RegisterAdvertisement method oa{sv} - -\n.SupportedInstances property y 1 const\n.ActiveInstances property y 0 -\n' ;;
*) exit 78 ;;
esac
'''
NMCLI = r'''#!/bin/sh
printf '%s\n' "nmcli $*" >> "$AUDIT_BENCH_CALL_LOG"
[ "$*" = '--terse --mode multiline --colors no --fields GENERAL.TYPE,GENERAL.NM-MANAGED device show' ] || exit 78
printf 'GENERAL.TYPE:ethernet\nGENERAL.NM-MANAGED:yes\n\nGENERAL.TYPE:wifi\nGENERAL.NM-MANAGED:yes\n'
'''
ESCAPED_BUSCTL = BUSCTL.replace("printf 's \":1.23\"\\n'", "/bin/sleep 6 & printf 's \":1.23\"\\n'")
SUCCESS = b'''HOST PREFLIGHT (read-only, adapter hci0)
PASS BLUETOOTH_POWERED
PASS GATT_REGISTRATION_API
PASS ADVERTISING_REGISTRATION_API
PASS NETWORKMANAGER_MANAGED_WIFI
Prerequisites observed; registration permissions and radio exchange remain unverified.
Phone client, secure provisioning, and real Wi-Fi joining remain unverified.
'''
DEADLINE = b'''HOST PREFLIGHT (read-only, adapter hci0)
FAIL BLUEZ_RUNNING TIMEOUT
PASS NETWORKMANAGER_MANAGED_WIFI
Host preflight blocked; run from the Ubuntu host terminal and check the failed prerequisites.
Phone client, secure provisioning, and real Wi-Fi joining remain unverified.
'''
EXPECTED_CALLS = [
    'busctl --system --no-pager --auto-start=no call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetNameOwner s org.bluez',
    'busctl --system --no-pager get-property :1.23 /org/bluez/hci0 org.bluez.Adapter1 Powered',
    'busctl --system --no-pager introspect :1.23 /org/bluez/hci0 org.bluez.GattManager1',
    'busctl --system --no-pager introspect :1.23 /org/bluez/hci0 org.bluez.LEAdvertisingManager1',
    'nmcli --terse --mode multiline --colors no --fields GENERAL.TYPE,GENERAL.NM-MANAGED device show',
]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def summary(rows):
    values = [row['wall_ms'] for row in rows]
    return {'n': len(values), 'median_ms': statistics.median(values),
            'mean_ms': statistics.mean(values), 'min_ms': min(values),
            'max_ms': max(values), 'stdev_ms': statistics.stdev(values)}


def fixture(label, group, escaped):
    path = ROOT / 'fixtures' / label / group
    path.mkdir(parents=True, exist_ok=False)
    for name, contents in [('busctl', ESCAPED_BUSCTL if escaped else BUSCTL), ('nmcli', NMCLI)]:
        file = path / name
        file.write_text(contents)
        file.chmod(0o700)
    return path


def run(binary, path, label, workload, batch, run_number):
    call_log = path / f'calls-{run_number}.txt'
    env = {'PATH': f'{path}:/usr/bin:/bin', 'LC_ALL': 'C', 'LANG': 'C',
           'AUDIT_BENCH_CALL_LOG': str(call_log)}
    started = time.perf_counter_ns()
    output = subprocess.run([str(binary)], cwd=path, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            check=False, timeout=12, start_new_session=True)
    wall_ms = (time.perf_counter_ns() - started) / 1_000_000
    calls = call_log.read_text().splitlines()
    corrected_deadline = workload == 'escaped_parent' and label == 'after'
    expected_output = DEADLINE if corrected_deadline else SUCCESS
    expected_code = 1 if corrected_deadline else 0
    expected_calls = [EXPECTED_CALLS[0], EXPECTED_CALLS[-1]] if corrected_deadline else EXPECTED_CALLS
    assert output.returncode == expected_code, (label, workload, output.returncode)
    assert output.stdout == expected_output, (label, workload, output.stdout)
    assert output.stderr == b'', (label, workload, output.stderr)
    assert calls == expected_calls, (label, workload, calls)
    if workload == 'escaped_parent':
        assert (wall_ms < 5500) if corrected_deadline else (wall_ms >= 5900), wall_ms
    return {'workload': workload, 'batch': batch, 'run': run_number,
            'wall_ms': wall_ms, 'exit_code': output.returncode,
            'command_invocations': len(calls), 'stdout': output.stdout.decode(),
            'stderr': output.stderr.decode(), 'command': [str(binary)],
            'cwd': str(path), 'env': env, 'output_and_call_assertions': 'passed'}


def main():
    assert len(sys.argv) == 3 and sys.argv[1] in ['before', 'after'], 'usage: benchmark.py before|after /absolute/audit-host'
    label, binary = sys.argv[1], pathlib.Path(sys.argv[2]).resolve(strict=True)
    assert ESCAPED_BUSCTL != BUSCTL
    assert ESCAPED_BUSCTL.count('/bin/sleep 6 &') == 1
    rows = []
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for batch in range(1, 4):
        path = fixture(label, f'normal-batch-{batch}', False)
        rows.extend(run(binary, path, label, 'normal', batch, number) for number in range(1, 8))
    for number in range(1, 4):
        path = fixture(label, f'escaped-parent-{number}', True)
        rows.append(run(binary, path, label, 'escaped_parent', number, 1))
    details = {'label': label, 'started_utc': started,
               'finished_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'binary': str(binary), 'binary_sha256': sha256(binary.read_bytes()),
               'harness_sha256': sha256(pathlib.Path(__file__).read_bytes()),
               'fixture_sha256': {name: sha256(value.encode()) for name, value in
                                  [('busctl', BUSCTL), ('escaped_busctl', ESCAPED_BUSCTL), ('nmcli', NMCLI)]},
               'environment': {'system': platform.system(), 'release': platform.release(),
                               'machine': platform.machine(), 'python': platform.python_version(),
                               'logical_cpus': os.cpu_count(),
                               'clock': str(time.get_clock_info('perf_counter')),
                               'shell_realpath': str(pathlib.Path('/bin/sh').resolve()),
                               'timeout_version': subprocess.check_output(['/usr/bin/timeout', '--version'], text=True).splitlines()[0]},
               'rows': rows,
               'summary': {workload: summary([row for row in rows if row['workload'] == workload])
                           for workload in ['normal', 'escaped_parent']},
               'normal_batch_summaries': [summary([row for row in rows if row['workload'] == 'normal' and row['batch'] == batch])
                                          for batch in range(1, 4)]}
    (ROOT / f'{label}-results.json').write_text(json.dumps(details, indent=2) + '\n')
    print(json.dumps({'label': label, 'summary': details['summary'],
                      'normal_batch_summaries': details['normal_batch_summaries'],
                      'result_path': str(ROOT / f'{label}-results.json')}, indent=2))


if __name__ == '__main__':
    main()
