# AGENTS.md

Guide for AI coding agents working on this repo. Read [README.md](README.md) first, then
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SECURITY.md](docs/SECURITY.md) before touching the protocol.

## Layout

- `configurator/`: Provide., the technician app (Expo / React Native, TypeScript). One code base for iPhone and
  desktop; `desktop/` holds the Tauri shell and its Rust Bluetooth bridge. Expo specifics:
  [configurator/AGENTS.md](configurator/AGENTS.md).
- `device/`: the sensor service and the workshop tools, one Rust crate. `bin/` for the programs, `src/` for the
  protocol library, `tests/` for integration tests.
- `docs/`, `evidence/`, `tools/`: documentation, logs of real and simulated runs, test bench and demo scripts.

## Commands

```sh
# Configurator
cd configurator && npm ci
npm test && npm run typecheck && npm run lint
npm run web                                   # demo mode at ?demo=1, no hardware
cd desktop/src-tauri && cargo test            # desktop Bluetooth bridge

# Device (from device/)
cargo test --features provision,stage         # macOS: everything except BlueZ and the host audit
cargo test --features ble,stage --all-targets --locked                       # Ubuntu: the full suite
cargo clippy --features ble,stage --all-targets --locked -- -D warnings      # Ubuntu
cargo install --path . --features stage --bin teton-workshop --locked   # the workshop tool, once
teton-workshop uninstall <ssh-host>         # undo deploy on a test sensor: Wi-Fi forgotten, service removed
teton-workshop issue "Name" --customer DEMO  # a technician code, for manual tests
teton-workshop deploy <ssh-host> --customer DEMO   # install, key and certify a blank sensor over SSH, from target/linux-<arch>/
```

## Rules

- **No secrets in the repo**: authority private keys, technician codes, Wi-Fi passwords, a sensor's `state/`.
  Pass secrets on stdin or from a 0600 file, never as a command argument.
- **Ask before changing the Bluetooth protocol** or the advertisement. The primary packet is full (31 bytes).
- **Never weaken a check** to get a green run: certificate, technician code, test or lint rule.
- **One code base**: the desktop reuses the app's screens and logic. Only the Bluetooth, storage and camera adapters
  differ per platform.
- **Test first**, and run the checks above before each commit.
- **Claims need proof**: a real-hardware result goes in `evidence/real/`, labelled real or simulated.

## Skills

I built this repo with two skill sets. Use them for the same jobs:

- [**agent-skills**](https://github.com/addyosmani/agent-skills) (Addy Osmani, MIT): `/spec` and `/plan` before a
  feature, `/build` and `/test` for test-driven changes, `/review` and `/code-simplify` before a commit, `/ship`
  before a deploy.
- [**stop-slop**](https://github.com/hardikpandya/stop-slop) (Hardik Pandya, MIT): on every text a reader sees,
  README and `docs/`. Short sentences, active voice, no filler.
