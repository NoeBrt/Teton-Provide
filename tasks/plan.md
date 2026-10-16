# Implementation Plan: Simulated Transport First

## Objective and current scope

Define the stack now, then deliver a repeatable, clearly labeled simulation
of device discovery, connection, `hello` exchange, and recoverable failures.
No Jetson is available. The simulation is a development aid; real BLE and
real Wi-Fi remain required for the final challenge submission.

This update contains documentation only. Implementation tasks are tracked
in [todo.md](todo.md); architecture choices live in
[ARCHITECTURE.md](../docs/ARCHITECTURE.md) and their history in
[DECISIONS.md](../docs/DECISIONS.md).

## Dependency order

```text
Shared hello contract
        |
        v
Simulated discovery + local exchange
        |
        v
Failure injection + reconnect + simulated restart
        |
        v
SOFTWARE CHECKPOINT: labeled, repeatable demo

Hardware availability + host access
        |
        v
Hardware audit -> BlueZ peripheral -> Bleak configurator
        |
        v
RADIO CHECKPOINT: actual hello + reconnect + service restart/reboot
        |
        v
Secure-channel decision -> real Wi-Fi -> technician UX -> submission evidence
```

## Implementation slices

1. **Contract:** shared byte handler and input-rejection tests. No dependency on BLE.
2. **Demo:** separate configurator/device flows connected through bounded async
   queues and synthetic discovery. One command produces a labeled round trip.
3. **Recovery:** deterministic timeout/disconnect injection, retries, and simulated
   process lifecycle. Each test asserts an outcome, not merely that code ran.
4. **Real endpoint:** inspect actual hardware, pin compatible dependencies, expose
   the same handler through BlueZ, and exercise it with Bleak.
5. **Host lifecycle:** install the service and verify normal reconnect, restart,
   reboot, and offline operation without resetting Bluetooth manually.

Stop after the software checkpoint until hardware is available. Docker is optional
and does not block any software task. Add a container runner only for a demonstrated
reproducibility need; do not build a privileged Bluetooth lab by default.

## Verification strategy

Use pytest with synchronous tests calling `asyncio.run` where needed. Install
no BLE libraries for the simulation. Give every wait a deadline, keep queues
bounded, and discard session data after disconnect. Capture sanitized output
under `demo/` with a prominent `SIMULATION` label, command, environment, and result.

Tests must not silently skip hardware assertions and then report hardware
success. Maintain separate software and hardware evidence. Future commands
in `todo.md` are specifications, not commands that already work.

## Risks and unresolved gates

| Risk | Mitigation |
| --- | --- |
| Fake transport hides GATT/driver failures | Separate radio checkpoint with actual two-machine evidence |
| Device Python/BlueZ differs from laptop | Inspect before installation; lock tested versions per supported environment |
| Docker/socket restrictions persist | Socket-free simulation; optional container packaging only |
| Simulation becomes a second product | Reuse handler; keep only fault injection and wiring in the fake adapter |
| Security is bolted onto plaintext provisioning | Credential endpoint blocked until authenticated-channel review and tests |
| No Wi-Fi hardware by submission | Explicitly report incomplete challenge; simulated success cannot replace real evidence |

The future device model, adapter capability, host permissions, and authenticated
channel remain open. These do not block the harmless simulation. Confirm them
before claiming radio reliability or enabling credentials.
