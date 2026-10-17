//! Developer preflight only; does not register BLE services or configure Wi-Fi.

use std::io::Read;
use std::process::{Command, ExitCode, Stdio};

const MAX_OUTPUT: u64 = 8192;
const USAGE: &str = "Usage: audit-host [hciN]\nRead-only Ubuntu preflight; defaults to hci0. Requires busctl, nmcli, and GNU timeout.";

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.as_slice() == ["--help"] {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let adapter = match args.as_slice() {
        [] => "hci0",
        [value]
            if value.len() <= 16
                && value.strip_prefix("hci").is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
                }) =>
        {
            value
        }
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    let path = format!("/org/bluez/{adapter}");
    println!("HOST PREFLIGHT (read-only, adapter {adapter})");
    let mut passed = check(
        "BLUETOOTH_POWERED",
        "busctl",
        &[
            "--system",
            "--no-pager",
            "get-property",
            "org.bluez",
            &path,
            "org.bluez.Adapter1",
            "Powered",
        ],
        |text| text.trim() == "b true",
    );
    for (label, interface, method) in [
        (
            "GATT_REGISTRATION_API",
            "org.bluez.GattManager1",
            ".RegisterApplication",
        ),
        (
            "ADVERTISING_REGISTRATION_API",
            "org.bluez.LEAdvertisingManager1",
            ".RegisterAdvertisement",
        ),
    ] {
        passed &= check(
            label,
            "busctl",
            &[
                "--system",
                "--no-pager",
                "introspect",
                "org.bluez",
                &path,
                interface,
            ],
            |text| {
                let method_present = text.lines().any(|line| {
                    let mut fields = line.split_whitespace();
                    fields.next() == Some(method) && fields.next() == Some("method")
                });
                method_present
                    && (interface != "org.bluez.LEAdvertisingManager1"
                        || spare_advertising_capacity(text))
            },
        );
    }
    passed &= check(
        "NETWORKMANAGER_MANAGED_WIFI",
        "nmcli",
        &[
            "--terse",
            "--mode",
            "multiline",
            "--colors",
            "no",
            "--fields",
            "GENERAL.TYPE,GENERAL.NM-MANAGED",
            "device",
            "show",
        ],
        managed_wifi,
    );
    if passed {
        println!(
            "Prerequisites observed; registration permissions and radio exchange remain unverified."
        );
    } else {
        println!(
            "Host preflight blocked; run from the Ubuntu host terminal and check the failed prerequisites."
        );
    }
    println!("Phone client, secure provisioning, and real Wi-Fi joining remain unverified.");
    if passed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn check(label: &str, program: &str, args: &[&str], accept: impl FnOnce(&str) -> bool) -> bool {
    match read_command(program, args) {
        Ok(text) if accept(&text) => {
            println!("PASS {label}");
            true
        }
        result => {
            let reason = result.err().unwrap_or("NOT_CONFIRMED");
            println!("FAIL {label} {reason}");
            false
        }
    }
}

fn read_command(program: &str, args: &[&str]) -> Result<String, &'static str> {
    // GNU timeout bounds the command's process group; never use --foreground.
    let mut child = Command::new("timeout")
        .args(["--kill-after=1s", "4s", program])
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => "MISSING_TIMEOUT",
            _ => "COMMAND_UNAVAILABLE",
        })?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .unwrap()
        .take(MAX_OUTPUT + 1)
        .read_to_end(&mut bytes);
    let status = child.wait().map_err(|_| "COMMAND_FAILED")?;
    if bytes.len() as u64 > MAX_OUTPUT {
        return Err("OUTPUT_LIMIT");
    }
    read.map_err(|_| "OUTPUT_UNREADABLE")?;
    if !status.success() {
        return Err(match status.code() {
            Some(124 | 137) => "TIMEOUT",
            Some(126 | 127) => "MISSING_COMMAND",
            _ => "COMMAND_FAILED",
        });
    }
    String::from_utf8(bytes).map_err(|_| "INVALID_OUTPUT")
}

fn managed_wifi(text: &str) -> bool {
    let lines: Vec<_> = text.lines().filter(|line| !line.is_empty()).collect();
    if lines.is_empty() || lines.len() % 2 != 0 {
        return false;
    }
    let mut found = false;
    for pair in lines.chunks_exact(2) {
        let Some(kind) = pair[0].strip_prefix("GENERAL.TYPE:") else {
            return false;
        };
        let Some(managed) = pair[1].strip_prefix("GENERAL.NM-MANAGED:") else {
            return false;
        };
        if !matches!(managed, "yes" | "no") {
            return false;
        }
        found |= kind == "wifi" && managed == "yes";
    }
    found
}

fn spare_advertising_capacity(text: &str) -> bool {
    // BlueZ SupportedInstances already counts remaining slots, not total capacity.
    text.lines().any(|line| {
        let mut fields = line.split_whitespace();
        fields.next() == Some(".SupportedInstances")
            && fields.next() == Some("property")
            && fields.next() == Some("y")
            && fields
                .next()
                .and_then(|value| value.parse::<u8>().ok())
                .is_some_and(|free| free > 0)
    })
}
