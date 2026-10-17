#![cfg(unix)]

use std::fs;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct HostFixture(PathBuf);

impl HostFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "iot-host-audit-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        for (name, source) in [
            (
                "busctl",
                "#!/bin/sh\ncase \"$*\" in\n\
                 '--system --no-pager --auto-start=no call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetNameOwner s org.bluez') printf 's \":1.23\"\\n' ;;\n\
                 '--system --no-pager get-property :1.23 /org/bluez/hci0 org.bluez.Adapter1 Powered') printf 'b true\\n' ;;\n\
                 '--system --no-pager introspect :1.23 /org/bluez/hci0 org.bluez.GattManager1') printf '.RegisterApplication method oa{sv} - -\\n' ;;\n\
                 '--system --no-pager introspect :1.23 /org/bluez/hci0 org.bluez.LEAdvertisingManager1') printf '.RegisterAdvertisement method oa{sv} - -\\n.SupportedInstances property y 1 const\\n.ActiveInstances property y 0 -\\n' ;;\n\
                 *) exit 78 ;;\nesac\n",
            ),
            (
                "nmcli",
                "#!/bin/sh\n[ \"$*\" = '--terse --mode multiline --colors no --fields GENERAL.TYPE,GENERAL.NM-MANAGED device show' ] || exit 78\n\
                 printf 'GENERAL.TYPE:ethernet\\nGENERAL.NM-MANAGED:yes\\n\\nGENERAL.TYPE:wifi\\nGENERAL.NM-MANAGED:yes\\n'\n",
            ),
        ] {
            let file = root.join(name);
            fs::write(&file, source).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(root)
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_audit-host"));
        command
            .args(args)
            .env("PATH", format!("{}:/usr/bin:/bin", self.0.display()));
        command
    }

    fn replace(&self, name: &str, source: &str) {
        fs::write(self.0.join(name), source).unwrap();
    }
}

impl Drop for HostFixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn observed_prerequisites_do_not_claim_a_radio_or_wifi_success() {
    let host = HostFixture::new();
    let output = host.run(&[]);
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "HOST PREFLIGHT (read-only, adapter hci0)\n\
         PASS BLUETOOTH_POWERED\n\
         PASS GATT_REGISTRATION_API\n\
         PASS ADVERTISING_REGISTRATION_API\n\
         PASS NETWORKMANAGER_MANAGED_WIFI\n\
         Prerequisites observed; registration permissions and radio exchange remain unverified.\n\
         Phone client, secure provisioning, and real Wi-Fi joining remain unverified.\n"
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn a_visible_advertising_api_with_no_supported_instance_is_not_ready() {
    let host = HostFixture::new();
    let script = fs::read_to_string(host.0.join("busctl")).unwrap();
    host.replace(
        "busctl",
        &script.replace(
            ".SupportedInstances property y 1",
            ".SupportedInstances property y 0",
        ),
    );
    let output = host.run(&[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("FAIL ADVERTISING_REGISTRATION_API NOT_CONFIRMED")
    );
}

#[test]
fn missing_or_malformed_advertising_capacity_is_not_ready() {
    let host = HostFixture::new();
    let script = fs::read_to_string(host.0.join("busctl")).unwrap();
    for replacement in [
        ".MissingInstances property y 1",
        ".SupportedInstances property y invalid",
    ] {
        host.replace(
            "busctl",
            &script.replace(".SupportedInstances property y 1", replacement),
        );
        assert_eq!(host.run(&[]).status.code(), Some(1));
    }
}

#[test]
fn available_advertising_slots_are_not_reduced_by_active_slots_again() {
    let host = HostFixture::new();
    let script = fs::read_to_string(host.0.join("busctl")).unwrap();
    host.replace(
        "busctl",
        &script.replace(
            ".ActiveInstances property y 0",
            ".ActiveInstances property y 1",
        ),
    );
    assert!(host.run(&[]).status.success());
}

#[test]
fn managed_ethernet_does_not_make_unmanaged_wifi_acceptable() {
    let host = HostFixture::new();
    for reply in [
        "GENERAL.TYPE:ethernet\\nGENERAL.NM-MANAGED:yes\\nGENERAL.TYPE:wifi\\nGENERAL.NM-MANAGED:no\\n",
        "GENERAL.TYPE:wifi\\n",
        "GENERAL.TYPE:wifi\\nGENERAL.NM-MANAGED:unknown\\n",
    ] {
        host.replace("nmcli", &format!("#!/bin/sh\nprintf '{reply}'\n"));
        let output = host.run(&[]);
        assert_eq!(output.status.code(), Some(1));
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .contains("FAIL NETWORKMANAGER_MANAGED_WIFI NOT_CONFIRMED")
        );
    }
}

#[test]
fn failed_commands_never_expose_their_stdout_or_stderr() {
    let host = HostFixture::new();
    host.replace("busctl", "#!/bin/sh\nprintf 'CANARY-NETWORK-PASSWORD\\n'\nprintf 'CANARY-NETWORK-PASSWORD\\n' >&2\nexit 1\n");
    let output = host.run(&[]);
    assert_eq!(output.status.code(), Some(1));
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("FAIL BLUEZ_RUNNING COMMAND_FAILED"));
    assert!(!text.contains("CANARY-NETWORK-PASSWORD"));
    assert!(output.stderr.is_empty());
}

#[test]
fn malformed_successful_output_is_rejected_without_being_echoed() {
    let host = HostFixture::new();
    for script in [
        "#!/bin/sh\nprintf 'b true\\nCANARY-NETWORK-PASSWORD\\n'\n",
        "#!/bin/sh\nprintf '\\377\\n'\n",
    ] {
        host.replace("busctl", script);
        let output = host.run(&[]);
        assert_eq!(output.status.code(), Some(1));
        assert!(
            !String::from_utf8(output.stdout)
                .unwrap()
                .contains("CANARY-NETWORK-PASSWORD")
        );
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn missing_commands_fail_explicitly() {
    let host = HostFixture::new();
    let output = host.command(&[]).env("PATH", &host.0).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("MISSING_TIMEOUT")
    );
    host.replace("busctl", "#!/bin/sh\nexit 127\n");
    let output = host.run(&[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("MISSING_COMMAND")
    );
}

#[test]
fn a_blocked_command_and_its_child_are_subject_to_a_deadline() {
    let host = HostFixture::new();
    let script = fs::read_to_string(host.0.join("busctl")).unwrap();
    host.replace(
        "busctl",
        &script.replace("printf 'b true\\n'", "/bin/sleep 30; printf 'b true\\n'"),
    );
    let start = Instant::now();
    let output = host.run(&[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(start.elapsed() < Duration::from_secs(15));
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("FAIL BLUETOOTH_POWERED TIMEOUT")
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn a_descendant_ignoring_term_cannot_hold_the_audit_open() {
    let host = HostFixture::new();
    let script = fs::read_to_string(host.0.join("busctl")).unwrap();
    host.replace(
        "busctl",
        &script.replace(
            "printf 'b true\\n'",
            "/bin/sh -c 'trap \"\" TERM; /bin/sleep 12' & wait; printf 'b true\\n'",
        ),
    );
    let start = Instant::now();
    let output = host.run(&[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(start.elapsed() < Duration::from_secs(10));
    assert!(output.stderr.is_empty());
}

#[test]
fn an_owner_descendant_cannot_hold_the_audit_open_after_parent_exit() {
    let host = HostFixture::new();
    let script = fs::read_to_string(host.0.join("busctl")).unwrap();
    let owner = "org.bluez') printf";
    assert!(script.contains(owner));
    host.replace(
        "busctl",
        &script.replace(owner, "org.bluez') /bin/sleep 12 & printf"),
    );
    let start = Instant::now();
    let output = host.run(&[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(start.elapsed() < Duration::from_secs(10));
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("FAIL BLUEZ_RUNNING TIMEOUT")
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn inherited_shell_code_cannot_replace_the_audit_commands() {
    let host = HostFixture::new();
    let startup = host.0.join("startup");
    fs::write(&startup, "printf 'CANARY-STARTUP\\n'; exit 0\n").unwrap();
    for (key, value) in [
        ("BASH_ENV", startup.as_os_str()),
        (
            "BASH_FUNC_busctl%%",
            std::ffi::OsStr::new("() { printf 'CANARY-FUNCTION\\n'; }"),
        ),
    ] {
        let output = host.command(&[]).env(key, value).output().unwrap();
        assert!(output.status.success());
        assert!(!String::from_utf8(output.stdout).unwrap().contains("CANARY"));
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn excessive_stdout_is_bounded_and_never_printed() {
    let host = HostFixture::new();
    host.replace("busctl", "#!/bin/sh\n/usr/bin/head -c 16384 /dev/zero\n");
    let output = host.run(&[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.len() < 1024);
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("OUTPUT_LIMIT")
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn invalid_arguments_are_rejected_without_echo_or_command_execution() {
    let host = HostFixture::new();
    for args in [
        vec!["hci"],
        vec!["../hci0"],
        vec!["hci0;CANARY-NETWORK-PASSWORD"],
        vec!["hci０"],
        vec!["hci01234567890123456789"],
        vec!["hci0", "extra"],
    ] {
        let output = host.run(&args);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            "Usage: audit-host [hciN]\nRead-only Ubuntu preflight; defaults to hci0. Requires busctl, nmcli, GNU timeout, /bin/bash, and /bin/cat.\n"
        );
    }
    let help = host.run(&["--help"]);
    assert!(help.status.success());
    assert!(help.stderr.is_empty());
}

#[test]
fn an_explicit_adapter_is_used_for_all_bluetooth_checks() {
    let host = HostFixture::new();
    let script = fs::read_to_string(host.0.join("busctl")).unwrap();
    host.replace(
        "busctl",
        &script.replace("/org/bluez/hci0", "/org/bluez/hci12"),
    );
    let output = host.run(&["hci12"]);
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("adapter hci12")
    );
}

#[test]
fn non_utf8_arguments_are_rejected_without_panicking_or_leaking() {
    let host = HostFixture::new();
    let argument = std::ffi::OsString::from_vec(b"hci0\xffCANARY-NETWORK-PASSWORD".to_vec());
    let output = host.command(&[]).arg(argument).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains("CANARY-NETWORK-PASSWORD")
    );
}

#[test]
fn a_stopped_bluetooth_service_is_not_activated_by_the_audit() {
    let host = HostFixture::new();
    let script = fs::read_to_string(host.0.join("busctl")).unwrap();
    host.replace("busctl", &format!("#!/bin/sh\ncase \"$*\" in\n*' GetNameOwner s org.bluez') exit 1 ;;\n*' org.bluez '*) : > \"$AUDIT_MUTATION_SENTINEL\" ;;\nesac\n{script}"));
    let sentinel = host.0.join("bluetooth-was-started");
    let output = host
        .command(&[])
        .env("AUDIT_MUTATION_SENTINEL", &sentinel)
        .output()
        .unwrap();
    assert!(
        !sentinel.exists(),
        "A query to an activatable name would start Bluetooth"
    );
    assert_eq!(output.status.code(), Some(1));
}
