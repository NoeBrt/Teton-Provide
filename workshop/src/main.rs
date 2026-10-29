//! iot-workshop: The manufacturer's authorities, run at the workshop. Offline except the first deployment downloads.
//! Two Ed25519 keys, kept apart from the devices:
//!
//! ```text
//! iot-workshop init | public | certify DEVICE_PUBLIC_KEY_HEX --customer C | issue NAME --customer C [--customer C2...]
//!     short forms: the authority lives in $IOT_AUTHORITY, else ~/iot-authority; codes are valid one day. A
//!     customer is a name or an ID ("Noé Home" is NOE-HOME). Without --customer, the last customer is offered again,
//!     on a terminal only and after a yes
//! iot-workshop init DIR
//!     creates the device authority and the technician authority (private keys 0600) and prints their public keys
//! iot-workshop public DIR
//!     prints both public keys: the device authority's goes into the app, the technician authority's onto sensors
//! iot-workshop certify DIR DEVICE_PUBLIC_KEY_HEX CUSTOMER
//!     prints the certificate for a sensor's key (from `stage init`), for one customer
//! iot-workshop issue DIR NAME CUSTOMER[,CUSTOMER...] [DAYS]
//!     prints a technician code as text and a QR code, valid DAYS days (default and at most 5) for those
//!     customers, and its code ID; the ID is logged in DIR/issued.tsv with the name, never the code
//! iot-workshop deploy SSH_HOST [WIFI_INTERFACE] --customer C
//!     installs the service on a blank Ubuntu sensor over SSH (USB or network) and makes it ready for setup: copies
//!     the released binaries for its architecture (downloaded once, SHA-256 checked), runs systemd/install.sh, has
//!     the sensor create its key, certifies that key here for the customer and installs the certificate. The authority's
//!     private keys stay on this machine; the sudo password is read here, without echo, and sent over SSH only
//! iot-workshop uninstall SSH_HOST [--yes]
//!     undoes deploy: forgets the Wi-Fi the sensor was given, removes the service, its files and the sensor account,
//!     and keeps the sensor's key in /root/iot-backup
//! ```
//!
//! The code is `<token hex>.<holder private key hex>`: the token names a holder key generated for this code, and
//! the phone proves its private half, so a sensor that records the token cannot reuse it. The code is a credential:
//! send it to the technician only, over a channel you trust; the technician imports it inside the app (scan or
//! paste), never through a link another app could claim.

mod binaries;

use ed25519_dalek::SigningKey;
use iot_provisioning::authority::{
    DeviceCertificate, MAX_CUSTOMER, MAX_CUSTOMERS, TechnicianToken, code_text, device_id,
};
use iot_provisioning::provision::{KeyPair, NOISE_PARAMS, hex, unhex};
use qrcode::QrCode;
use qrcode::render::unicode;
use snow::Builder;
use std::fmt::Display;
use std::fs::{DirBuilder, OpenOptions};
use std::io::{IsTerminal, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const DEVICE_KEY: &str = "device-authority.key";
const TECHNICIAN_KEY: &str = "technician-authority.key";
/// One line per code issued: ID, name, customers, expiry. A record of who holds a code; no secret.
const ISSUED_LOG: &str = "issued.tsv";
/// Codes are valid 5 days at most: with no revocation yet, expiry bounds a leaked code.
const MAX_DAYS: u64 = 5;
const USAGE: &str = "usage: iot-workshop init | public | certify DEVICE_PUBLIC_KEY_HEX --customer C | issue NAME --customer C... \
                     (in $IOT_AUTHORITY, else ~/iot-authority; 1 day)\n       \
                     iot-workshop init DIR | public DIR | certify DIR DEVICE_PUBLIC_KEY_HEX CUSTOMER | issue DIR NAME CUSTOMERS [DAYS]\n       \
                     iot-workshop deploy SSH_HOST [WIFI_INTERFACE] --customer C   (default: the first Wi-Fi device) | uninstall SSH_HOST [--yes]\n\
                     Run `iot-workshop help` for what each command does.";
/// `iot-workshop help`, by what the user wants to do; `{dir}` is the authority folder in use.
const HELP: &str = "iot-workshop: The manufacturer's workshop tool. It holds the two authority keys, on this machine only.

Authority folder: {dir}
  ($IOT_AUTHORITY, else ~/iot-authority. One folder for every customer; the short forms below use it.)

Customers
  --customer C                  a name or an ID: \"Noé Home\" is NOE-HOME, the ID that certificates and codes carry
                                without it, the last customer is offered again, on a terminal and after a yes only

Start
  init                          create the two authority keys (once; never regenerated) and print their public keys
  public                        print the public keys again: the first goes into the app (configurator/src/authority.ts)

Add a sensor
  deploy SSH_HOST [WIFI_IF] --customer C
                                install, key, certify for C and start a blank Ubuntu sensor over SSH (USB: 192.168.55.1)
                                downloads Linux binaries once; no compiler needed on the sensor
  certify SENSOR_PUBLIC_KEY --customer C
                                manual path: certify the key `iot-stage init` printed
  uninstall SSH_HOST [--yes]    forget the Wi-Fi it was given and remove the sensor service: a blank sensor again
                                (its key is kept in /root/iot-backup); asks first, a script passes --yes

Give a technician access
  issue NAME --customer C [--customer C2...]
                                print a 1-day technician code for these customers (QR and text) and its code ID;
                                NAME: a full name or a distinctive nickname; letters (accents included),
                                digits, spaces, - ' or .

Long forms (any folder, customer, validity)
  init DIR | public DIR | certify DIR KEY CUSTOMER | issue DIR NAME CUSTOMER[,CUSTOMER...] [DAYS<=5]

Example
  iot-workshop init                                        once, for every customer
  iot-workshop deploy jetson-027 --customer \"Noé Home\"
  iot-workshop issue \"Alex\" --customer \"Noé Home\" --customer \"Hôpital Saint-Louis\"";
/// Where `deploy` copies the binaries and the installer on the sensor, removed once installed.
const REMOTE_DIR: &str = "iot-deploy";
const STATE_DIR: &str = "/var/lib/iot-device";
/// The sensor crate of the checkout this binary was built from: `deploy` takes the sensor binaries and systemd/ from
/// there, so it runs from any folder. Reinstall after moving the checkout.
const DEVICE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../device");
/// The last customer chosen, `ID<TAB>name`: offered again, after a yes, when a command names none.
const LAST_CUSTOMER: &str = "last-customer";
// ANSI styles.
const BOLD: &str = "1";
const DIM: &str = "2";
const RED: &str = "1;31";
const GREEN: &str = "1;32";
const YELLOW: &str = "33";
const CYAN: &str = "36";

/// `text` in an ANSI style, or plain: plain keeps pipes and scripts (tools/mint-lab.sh) reading the same lines.
fn paint(on: bool, style: &str, text: impl Display) -> String {
    if on {
        format!("\x1b[{style}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

/// Styled for stdout, only on a terminal and without NO_COLOR (no-color.org).
fn out(style: &str, text: impl Display) -> String {
    paint(
        std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none(),
        style,
        text,
    )
}

/// Styled for stderr, same rule.
fn err(style: &str, text: impl Display) -> String {
    paint(
        std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none(),
        style,
        text,
    )
}

/// Unix seconds as `YYYY-MM-DD HH:MM UTC` (days to civil date: Howard Hinnant's algorithm).
fn utc(secs: u64) -> String {
    let z = (secs / 86_400) as i64 + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let time = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02} UTC",
        time / 3600,
        time % 3600 / 60
    )
}

/// A customer: the ID certificates and codes carry (sensors compare it exactly) and the name the operator typed.
#[derive(Debug, PartialEq)]
struct Customer {
    id: String,
    name: String,
}

impl Display for Customer {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        if self.name == self.id {
            write!(f, "{}", self.id)
        } else {
            write!(f, "{} ({})", self.name, self.id)
        }
    }
}

impl Customer {
    /// An exact ID, as the long forms take it.
    fn exact(id: &str) -> Self {
        Customer {
            id: id.to_string(),
            name: id.to_string(),
        }
    }
}

/// Latin letters with an accent, and the plain letters they fold to in a customer ID.
const LATIN: [(&str, &str); 11] = [
    ("àáâãäåÀÁÂÃÄÅ", "A"),
    ("çÇ", "C"),
    ("èéêëÈÉÊË", "E"),
    ("ìíîïÌÍÎÏ", "I"),
    ("ñÑ", "N"),
    ("òóôõöøÒÓÔÕÖØ", "O"),
    ("ùúûüÙÚÛÜ", "U"),
    ("ýÿÝŸ", "Y"),
    ("æÆ", "AE"),
    ("œŒ", "OE"),
    ("ß", "SS"),
];

/// A customer from a name or an ID: accents dropped, uppercase, spaces and punctuation as `-`. One name always gives
/// one ID ("Hôpital Saint-Louis" is HOPITAL-SAINT-LOUIS), and an ID gives itself.
fn customer(text: &str) -> Result<Customer, String> {
    let name = text.trim();
    let mut id = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            id.push(c.to_ascii_uppercase());
        } else if let Some((_, base)) = LATIN.iter().find(|(set, _)| set.contains(c)) {
            id.push_str(base);
        } else if " -.'’".contains(c) {
            if !id.is_empty() && !id.ends_with('-') {
                id.push('-');
            }
        } else {
            return Err(format!(
                "{name:?}: a customer is Latin letters (common accents included), digits, spaces, - or _"
            ));
        }
    }
    let id = id.trim_end_matches('-').to_string();
    if id.is_empty() || id.len() > MAX_CUSTOMER {
        return Err(format!(
            "{name:?} gives the ID {id:?}: 1-{MAX_CUSTOMER} characters; shorten it"
        ));
    }
    Ok(Customer {
        id,
        name: name.to_string(),
    })
}

/// The customers for one command: those given with --customer, else the last one if `confirm` says yes (`None`: no
/// terminal to ask, so a script never waits on a question).
fn choose(
    dir: &Path,
    given: &[String],
    many: bool,
    action: &str,
    confirm: impl FnOnce(&Customer) -> Option<bool>,
) -> Result<Vec<Customer>, String> {
    if given.is_empty() {
        let Some(last) = last_customer(dir) else {
            return Err(
                "choose the customer: --customer \"Noé Home\" (a name or an ID)".to_string(),
            );
        };
        return match confirm(&last) {
            Some(true) => Ok(vec![last]),
            Some(false) => Err(format!(
                "{action}: cancelled; choose the customer with --customer"
            )),
            None => Err(format!(
                "{action}: no --customer, and no terminal to confirm the last one, {last}. A script names it: \
                 --customer {}",
                last.id
            )),
        };
    }
    let mut chosen: Vec<Customer> = Vec::new();
    for text in given {
        let next = customer(text)?;
        if chosen.iter().any(|earlier| earlier.id == next.id) {
            return Err(format!("{next} is given twice"));
        }
        chosen.push(next);
    }
    if !many && chosen.len() > 1 {
        return Err("a sensor belongs to one customer: give one --customer".to_string());
    }
    if chosen.len() > MAX_CUSTOMERS {
        return Err(format!("a code covers {MAX_CUSTOMERS} customers at most"));
    }
    Ok(chosen)
}

/// The single customer `choose` returns when `many` is false.
fn one(mut chosen: Vec<Customer>) -> Customer {
    chosen.remove(0)
}

/// On a terminal, shows the last customer and asks for a yes; elsewhere, asks nothing.
fn ask(action: String) -> impl FnOnce(&Customer) -> Option<bool> {
    move |last| {
        if !std::io::stdin().is_terminal() {
            return None;
        }
        eprint!(
            "{} {}, the last one used. {action} for it? [y/N] ",
            err(YELLOW, "Customer:"),
            err(BOLD, last)
        );
        let mut answer = String::new();
        std::io::stdin().read_line(&mut answer).ok()?;
        Some(matches!(
            answer.trim().to_lowercase().as_str(),
            "y" | "yes" | "o" | "oui"
        ))
    }
}

fn last_customer(dir: &Path) -> Option<Customer> {
    let text = std::fs::read_to_string(dir.join(LAST_CUSTOMER)).ok()?;
    let (id, name) = text.trim_end().split_once('\t')?;
    customer(name).ok().filter(|known| known.id == id) // a hand-edited file offers nothing
}

fn remember(dir: &Path, customer: &Customer) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(dir.join(LAST_CUSTOMER))
        .and_then(|mut file| writeln!(file, "{}\t{}", customer.id, customer.name))
        .map_err(|e| format!("{}: {e}", dir.join(LAST_CUSTOMER).display()))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let dir = std::env::var_os("IOT_AUTHORITY")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join("iot-authority")))
        .unwrap_or_else(|| PathBuf::from("iot-authority"));
    match run(&args, &dir) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{} {message}", err(RED, "error:"));
            ExitCode::FAILURE
        }
    }
}

/// One command; the short forms use `default` as the authority directory.
fn run(args: &[&str], default: &Path) -> Result<(), String> {
    let (mut given, mut rest, mut yes) = (Vec::new(), Vec::new(), false);
    let mut words = args.iter();
    while let Some(&word) = words.next() {
        if word == "--customer" {
            given.push(
                words
                    .next()
                    .ok_or("--customer needs a name or an ID")?
                    .to_string(),
            );
        } else if let Some(value) = word.strip_prefix("--customer=") {
            given.push(value.to_string());
        } else if word == "--yes" {
            yes = true;
        } else if word.starts_with("--") && word != "--help" {
            return Err(format!("unknown option {word}\n{USAGE}"));
        } else {
            rest.push(word);
        }
    }
    let takes_customer = matches!(
        rest.as_slice(),
        ["certify", _] | ["issue", _] | ["deploy", ..]
    );
    if !given.is_empty() && !takes_customer {
        return Err("--customer goes with deploy, certify KEY and issue NAME".to_string());
    }
    if yes && !matches!(rest.as_slice(), ["uninstall", _]) {
        return Err("--yes goes with uninstall".to_string());
    }
    match rest.as_slice() {
        ["help" | "--help" | "-h"] => {
            println!("{}", HELP.replace("{dir}", &default.display().to_string()));
            Ok(())
        }
        ["init"] => init(default),
        ["public"] => public(default),
        ["certify", key] => {
            let action = "Certify this sensor".to_string();
            let chosen = one(choose(
                default,
                &given,
                false,
                &action,
                ask(action.clone()),
            )?);
            certify(default, key, &chosen)?;
            remember(default, &chosen)
        }
        ["issue", name] => {
            let name = technician_name(name)?; // checked before it is shown in a question
            let action = format!("Issue a code for {name}");
            let chosen = choose(default, &given, true, &action, ask(action.clone()))?;
            issue(default, name, &chosen, 1)?;
            match chosen.as_slice() {
                [only] => remember(default, only),
                _ => Ok(()),
            }
        }
        ["uninstall", host] => uninstall(host, yes, ask_uninstall),
        ["deploy", host] => deploy(default, host, None, &given),
        ["deploy", host, interface] => deploy(default, host, Some(interface), &given),
        ["init", dir] => init(Path::new(dir)),
        ["public", dir] => public(Path::new(dir)),
        ["certify", dir, key, customer] => certify(Path::new(dir), key, &Customer::exact(customer)),
        ["issue", dir, name, customers] => issue(Path::new(dir), name, &exact(customers), MAX_DAYS),
        ["issue", dir, name, customers, days] => days
            .parse()
            .map_err(|_| "DAYS must be a number".to_string())
            .and_then(|days| issue(Path::new(dir), name, &exact(customers), days)),
        _ => Err(USAGE.to_string()),
    }
}

/// The long forms' `CUSTOMER[,CUSTOMER...]`: exact IDs, as scripts pass them.
fn exact(customers: &str) -> Vec<Customer> {
    customers.split(',').map(Customer::exact).collect()
}

fn init(dir: &Path) -> Result<(), String> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    for name in [DEVICE_KEY, TECHNICIAN_KEY] {
        // 32 random bytes from the OS RNG, through snow's key generator; they are the Ed25519 seed.
        let seed = Builder::new(NOISE_PARAMS.parse().expect("valid pattern"))
            .generate_keypair()
            .map_err(|_| "no randomness")?
            .private;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(dir.join(name))
            .map_err(|e| {
                format!(
                    "{}: {e} (an authority is never regenerated)",
                    dir.join(name).display()
                )
            })?;
        file.write_all(&seed)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
    }
    eprintln!("{} authority created in {}", err(GREEN, "✓"), dir.display());
    public(dir)?;
    eprintln!(
        "\n{} put both keys into configurator/src/authority.ts (DEVICE_AUTHORITY, TECHNICIAN_AUTHORITY) and rebuild \
         the app; then {}",
        err(BOLD, "Next:"),
        err(CYAN, "iot-workshop deploy SSH_HOST")
    );
    Ok(())
}

fn load(dir: &Path, name: &str) -> Result<SigningKey, String> {
    let path: PathBuf = dir.join(name);
    let mode = std::fs::metadata(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        return Err(format!(
            "{} is open to group or others; chmod 600 it",
            path.display()
        ));
    }
    let seed: [u8; 32] = std::fs::read(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .try_into()
        .map_err(|_| format!("{} is not a 32-byte key", path.display()))?;
    Ok(SigningKey::from_bytes(&seed))
}

fn public(dir: &Path) -> Result<(), String> {
    println!(
        "{} {}",
        out(DIM, "device authority (configurator/src/authority.ts):"),
        out(
            BOLD,
            hex(&load(dir, DEVICE_KEY)?.verifying_key().to_bytes())
        )
    );
    println!(
        "{} {}",
        out(DIM, "technician authority (stage install, on each sensor):"),
        out(
            BOLD,
            hex(&load(dir, TECHNICIAN_KEY)?.verifying_key().to_bytes())
        )
    );
    Ok(())
}

fn certify(dir: &Path, key: &str, customer: &Customer) -> Result<(), String> {
    let (id, certificate) = certificate(dir, key, &customer.id)?;
    let authority = hex(&load(dir, TECHNICIAN_KEY)?.verifying_key().to_bytes());
    println!("{} for customer {customer}:", out(BOLD, &id));
    println!("{certificate}"); // the last line: scripts take it with `tail -1`
    eprintln!(
        "\n{} on the sensor, then {} appears in Provide.:\n  {}",
        err(BOLD, "Next:"),
        id,
        err(
            CYAN,
            format!(
                "sudo -u iot iot-stage install {STATE_DIR} {certificate} {authority} && sudo systemctl restart \
                 iot-device"
            )
        )
    );
    Ok(())
}

/// The sensor's ID and its certificate in hex.
fn certificate(dir: &Path, key: &str, customer: &str) -> Result<(String, String), String> {
    let key: [u8; 32] = unhex(key)
        .and_then(|k| k.try_into().ok())
        .ok_or("the device public key must be 32 hex bytes")?;
    let certificate = DeviceCertificate::sign(&load(dir, DEVICE_KEY)?, key, customer)
        .map_err(|_| "CUSTOMER: 1-32 letters, digits, - or _")?;
    Ok((device_id(&key), hex(&certificate.encode())))
}

fn deploy(dir: &Path, host: &str, interface: Option<&str>, given: &[String]) -> Result<(), String> {
    target(host, interface)?;
    // Chosen, and confirmed if remembered, before anything touches the sensor.
    let action = format!("Certify the sensor on {host}");
    let customer = one(choose(dir, given, false, &action, ask(action.clone()))?);
    load(dir, DEVICE_KEY)?; // both keys checked before touching the sensor
    let technician_key = load(dir, TECHNICIAN_KEY)?;
    println!(
        "{} {}  {}",
        out(BOLD, "Deploying to"),
        out(CYAN, host),
        out(
            DIM,
            format!(
                "authority {} · customer {customer} · Wi-Fi {}",
                dir.display(),
                interface.unwrap_or("first device")
            )
        )
    );
    over_ssh(host, |ssh_options| {
        let binaries = step((1, 5), "Reaching the sensor", || {
            // A sensor already installed is refused here, before step 3 would reinstall and restart it.
            let answer = remote(
                host,
                ssh_options,
                &["uname -m; test -e /usr/local/bin/iot-device && echo installed || true"],
                None,
            )?;
            if answer.contains("installed") {
                return Err(format!(
                    "iot-device is already installed on {host}: deploy sets up a blank sensor only, and moving a \
                     sensor to another customer is not defined yet (README, Limits)"
                ));
            }
            let arch = answer.lines().next().unwrap_or_default().to_string();
            let binaries = binaries::prepare(&arch, Path::new(DEVICE_DIR))?;
            detail(&format!(
                "{}, Linux binaries from {}",
                arch.trim(),
                binaries.display()
            ));
            Ok(binaries)
        })?;
        eprint!("{} ", err(YELLOW, format!("sudo password on {host}:")));
        let password = secret()?;
        step((2, 5), "Copying the service", || {
            remote(
                host,
                ssh_options,
                &[&format!(
                    "rm -rf {REMOTE_DIR} && mkdir -p {REMOTE_DIR}/target/release"
                )],
                None,
            )?;
            let files = ["device", "stage"].map(|name| binaries.join(name));
            copy(
                host,
                ssh_options,
                &files,
                &format!("{REMOTE_DIR}/target/release/"),
            )?;
            copy(
                host,
                ssh_options,
                &[Path::new(DEVICE_DIR).join("systemd")],
                &format!("{REMOTE_DIR}/"),
            )
        })?;
        let key = step(
            (3, 5),
            "Installing the service and creating the sensor's key",
            || {
                let output = remote(
                    host,
                    ssh_options,
                    &[&install_command(interface)],
                    Some(&password),
                )?;
                public_key_in(&output)
            },
        )?;
        let (id, certificate) = step(
            (4, 5),
            &format!("Certifying it for {customer} on this machine"),
            || {
                let signed = certificate(dir, &key, &customer.id)?;
                detail(&format!(
                    "{}: its private key stays on the sensor, the authority's stays here",
                    signed.0
                ));
                Ok(signed)
            },
        )?;
        step(
            (5, 5),
            "Installing the certificate and starting the service",
            || {
                let authority = hex(&technician_key.verifying_key().to_bytes());
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_secs();
                let journal = remote(
                    host,
                    ssh_options,
                    &[&start_command(&certificate, &authority, now)],
                    Some(&password),
                )?;
                detail(&format!(
                    "clock never earlier than {} on the sensor",
                    utc(now)
                ));
                detail(journal.trim());
                Ok(())
            },
        )?;
        remember(dir, &customer)?;
        println!(
            "\n{} {} is ready on {host}, for customer {customer}.",
            out(GREEN, "✓"),
            out(BOLD, &id)
        );
        println!(
            "  {} in Provide., with the phone near the sensor: tap {id}, then Set up.",
            out(BOLD, "Next:")
        );
        Ok(())
    })
}

/// One SSH login for every command `work` runs on `host`, closed at the end. The socket sits in ~/.ssh, which only this
/// user can write: one in /tmp could be planted by another account to read the sudo password.
fn over_ssh<T>(host: &str, work: impl FnOnce(&[&str]) -> Result<T, String>) -> Result<T, String> {
    let options = [
        "-o",
        "ControlMaster=auto",
        "-o",
        "ControlPath=~/.ssh/iot-deploy-%C",
        "-o",
        "ControlPersist=60",
    ];
    let result = work(&options);
    let _ = Command::new("ssh")
        .args(options)
        .args(["-O", "exit", host])
        .stderr(Stdio::null())
        .status();
    result
}

/// The two NetworkManager profiles the sensor service creates (`PROFILE_UUIDS` in device/bin/wifi.rs).
const WIFI_PROFILES: [&str; 2] = [
    "4a7db77c-6fda-47aa-95ca-d186c5096b32",
    "b5b2bc3f-8221-4a28-8c40-5e078953fcf2",
];

/// `uninstall`: back to a blank sensor, after a yes (`confirm`, `None` with no terminal) or `--yes`.
fn uninstall(
    host: &str,
    yes: bool,
    confirm: impl FnOnce(&str) -> Option<bool>,
) -> Result<(), String> {
    target(host, None)?;
    if !yes {
        match confirm(host) {
            Some(true) => {}
            Some(false) => return Err("uninstall cancelled".to_string()),
            None => {
                return Err(format!(
                    "uninstall asks first; with no terminal to ask, a script passes --yes: iot-workshop uninstall \
                     {host} --yes"
                ));
            }
        }
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    println!("{} {}", out(BOLD, "Uninstalling from"), out(CYAN, host));
    over_ssh(host, |ssh_options| {
        step((1, 2), "Reaching the sensor", || {
            remote(host, ssh_options, &["true"], None).map(|_| ())
        })?;
        eprint!("{} ", err(YELLOW, format!("sudo password on {host}:")));
        let password = secret()?;
        let said = step(
            (2, 2),
            "Forgetting its Wi-Fi and removing the sensor service",
            || {
                remote(
                    host,
                    ssh_options,
                    &[&uninstall_command(now)],
                    Some(&password),
                )
            },
        )?;
        for line in said.lines() {
            detail(line);
        }
        println!(
            "\n{} {host} is blank again: deploy it with {}",
            out(GREEN, "✓"),
            out(CYAN, format!("iot-workshop deploy {host} --customer C"))
        );
        Ok(())
    })
}

/// On a terminal, asks before uninstalling; elsewhere, asks nothing.
fn ask_uninstall(host: &str) -> Option<bool> {
    if !std::io::stdin().is_terminal() {
        return None;
    }
    eprint!(
        "{} remove the sensor service from {host} and forget the Wi-Fi it was given? Its key is kept in \
         /root/iot-backup. [y/N] ",
        err(YELLOW, "Uninstall:")
    );
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer).ok()?;
    Some(matches!(
        answer.trim().to_lowercase().as_str(),
        "y" | "yes" | "o" | "oui"
    ))
}

/// Undoes systemd/install.sh, `stage init` and `stage install`. The sensor's state, key included, moves to a root-only
/// backup rather than being erased. The Wi-Fi profiles go last, detached: over Wi-Fi the SSH link drops there.
fn uninstall_command(now: u64) -> String {
    let forget = WIFI_PROFILES
        .map(|uuid| format!("nmcli connection delete uuid {uuid}"))
        .join("; ");
    format!(
        "sudo -k -S -p '' sh -c 'exec </dev/null; systemctl disable --now iot-device 2>/dev/null; \
         rm -f /etc/systemd/system/iot-device.service /usr/local/bin/iot-device /usr/local/bin/iot-stage \
         /etc/default/iot-device /etc/polkit-1/localauthority/50-local.d/iot-device.pkla \
         /etc/polkit-1/rules.d/50-iot-device.rules /etc/systemd/system/bluetooth.service.d/iot-device.conf; \
         rmdir /etc/systemd/system/bluetooth.service.d 2>/dev/null; \
         if [ -d {STATE_DIR} ]; then install -d -m 700 /root/iot-backup && \
         mv {STATE_DIR} /root/iot-backup/iot-device-{now} && echo key kept in /root/iot-backup/iot-device-{now}; fi; \
         id iot >/dev/null 2>&1 && userdel iot; systemctl daemon-reload; systemctl restart bluetooth; \
         echo service, files and iot account removed; \
         setsid sh -c \"sleep 2; {forget}\" >/dev/null 2>&1 &' && rm -rf {REMOTE_DIR}"
    )
}

/// Deploy's step 3 on the sensor: install the service, then have the sensor create its key. The Wi-Fi interface is
/// pinned only when given: otherwise the service takes the first Wi-Fi device (a Jetson's wlan0, noe-lab's wlo1).
fn install_command(interface: Option<&str>) -> String {
    let interface = interface.map(|name| format!(" {name}")).unwrap_or_default();
    format!(
        "sudo -k -S -p '' sh -c 'exec </dev/null; {REMOTE_DIR}/systemd/install.sh{interface} >/dev/null && \
         sudo -u iot iot-stage init {STATE_DIR}'"
    )
}

/// Deploy's last step on the sensor: install the certificate, record this machine's time as the sensor's clock
/// floor, start the service. `-k` makes sudo read the password even with cached credentials, and the root shell then
/// closes stdin, so no child ever reads it. A sensor without a battery-backed clock may boot far in the past (a Jetson ran 171
/// days late); with the floor, it never accepts a technician code that expired before it was deployed.
fn start_command(certificate: &str, authority: &str, now: u64) -> String {
    let floor = format!("{STATE_DIR}/clock-floor");
    format!(
        "sudo -k -S -p '' sh -c 'exec </dev/null; sudo -u iot iot-stage install {STATE_DIR} {certificate} {authority} >/dev/null && \
         sudo -u iot sh -c \"umask 077; echo {now} > {floor}\" && \
         systemctl restart iot-device && sleep 2 && journalctl -u iot-device -n 1 -o cat' && rm -rf {REMOTE_DIR}"
    )
}

/// Prints `[n/of] label`, runs the step and names it in its error.
fn step<T>(
    (n, of): (u8, u8),
    label: &str,
    work: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    println!("{} {label}", out(DIM, format!("[{n}/{of}]")));
    work().map_err(|e| format!("step {n}/{of}, {}: {e}", label.to_lowercase()))
}

/// A result under its step.
fn detail(text: &str) {
    println!("      {}", out(DIM, printable(text)));
}

/// What a sensor sent, safe for the operator's terminal: an escape sequence could rewrite earlier lines (hide which
/// ID was certified) or reach the clipboard.
fn printable(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() && c != '\n' && c != '\t' {
                '?'
            } else {
                c
            }
        })
        .collect()
}

/// The host and interface go into an ssh command line and a remote shell: refuse anything read as more.
fn target(host: &str, interface: Option<&str>) -> Result<(), String> {
    let plain = |text: &str, extra: &str| {
        !text.is_empty()
            && text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c) || extra.contains(c))
    };
    if !plain(host, "@:") || host.starts_with('-') {
        return Err(format!(
            "{host:?}: an SSH host such as jetson-027 or user@192.168.55.1"
        ));
    }
    if let Some(interface) = interface.filter(|name| !plain(name, "")) {
        return Err(format!(
            "{interface:?}: a Wi-Fi interface such as wlan0, from `nmcli device status`"
        ));
    }
    Ok(())
}

/// The key printed by `stage init`.
fn public_key_in(output: &str) -> Result<String, String> {
    output
        .lines()
        .find(|line| line.starts_with("public key"))
        .and_then(|line| line.rsplit(' ').next())
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "no public key in the sensor's answer: {}",
                printable(output)
            )
        })
}

/// Runs a command on the host; `input` (the sudo password) goes on its stdin, never in an argument.
fn remote(
    host: &str,
    options: &[&str],
    command: &[&str],
    input: Option<&str>,
) -> Result<String, String> {
    let mut child = Command::new("ssh")
        .args(options)
        .arg(host)
        .args(command)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ssh: {e}"))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        writeln!(stdin, "{input}").map_err(|e| format!("ssh: {e}"))?;
    }
    let output = child.wait_with_output().map_err(|e| format!("ssh: {e}"))?;
    if !output.status.success() {
        // Its own messages (ssh, sudo, install.sh), shown only when they explain a failure.
        let said = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{host} answered: {}", printable(said.trim())));
    }
    String::from_utf8(output.stdout).map_err(|_| format!("{host}: the answer is not text"))
}

fn copy(host: &str, options: &[&str], files: &[PathBuf], to: &str) -> Result<(), String> {
    let output = Command::new("scp")
        .args(options)
        .args(["-q", "-p", "-r"])
        .args(files)
        .arg(format!("{host}:{to}"))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("scp: {e}"))?;
    output.status.success().then_some(()).ok_or_else(|| {
        format!(
            "copying to {host} failed: {}",
            printable(String::from_utf8_lossy(&output.stderr).trim())
        )
    })
}

/// One line from the terminal without echo (or from stdin when it is not a terminal).
fn secret() -> Result<String, String> {
    let quiet = Command::new("stty")
        .arg("-echo")
        .stdin(Stdio::inherit())
        .stderr(Stdio::null())
        .status();
    let mut line = String::new();
    let read = std::io::stdin().read_line(&mut line);
    if quiet.is_ok_and(|status| status.success()) {
        let _ = Command::new("stty")
            .arg("echo")
            .stdin(Stdio::inherit())
            .status();
    }
    eprintln!();
    read.map_err(|e| e.to_string())?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

/// A technician's name: Latin letters (accents included), digits, spaces, - ' and . only. Nothing that could split
/// a line of issued.tsv, hide in a terminal or a log, look like another name (a Cyrillic А, a blank Hangul filler),
/// or be mistaken for markup.
fn technician_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    let letter = |c: char| c.is_ascii_alphabetic() || LATIN.iter().any(|(set, _)| set.contains(c));
    let plain = |c: char| letter(c) || c.is_ascii_digit() || " -'.".contains(c);
    // Not `-` first: `issue --help` must not issue a code to a technician named "--help".
    if name.is_empty()
        || name.starts_with('-')
        || !name.chars().all(plain)
        || !name.chars().any(letter)
    {
        return Err(format!(
            "{name:?}: a technician name is letters, digits, spaces, - ' or ."
        ));
    }
    Ok(name)
}

fn issue(dir: &Path, name: &str, chosen: &[Customer], days: u64) -> Result<(), String> {
    let name = technician_name(name)?;
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(format!("DAYS: 1 to {MAX_DAYS}"));
    }
    let customers: Vec<String> = chosen.iter().map(|customer| customer.id.clone()).collect();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let holder = KeyPair::generate().map_err(|_| "no randomness")?;
    let token = TechnicianToken::issue(
        &load(dir, TECHNICIAN_KEY)?,
        name,
        &customers,
        now + days * 86_400,
        holder.public_key,
    )
    .map_err(|_| "NAME: 1-64 bytes; CUSTOMERS: 1-8, each 1-32 letters, digits, - or _")?;
    // Logged before it is shown: a code nobody recorded is never printed.
    let id = hex(&token.id());
    let mut log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(dir.join(ISSUED_LOG))
        .map_err(|e| format!("{}: {e}", dir.join(ISSUED_LOG).display()))?;
    writeln!(
        log,
        "{id}\t{name}\t{}\t{}",
        customers.join(","),
        token.expires
    )
    .map_err(|e| e.to_string())?;
    // The holder's private key is printed only inside the code.
    let code = code_text(&token.encode(), &holder.private_key);
    let qr = QrCode::new(code.as_bytes()).map_err(|_| "token too long for a QR code")?;
    println!(
        "{}",
        qr.render::<unicode::Dense1x2>().quiet_zone(true).build()
    );
    println!(
        "{} {}  {}",
        out(BOLD, "Technician code for"),
        out(BOLD, name),
        out(
            DIM,
            format!(
                "customers {} · expires {} ({days} day{})",
                chosen
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(", "),
                utc(token.expires),
                if days == 1 { "" } else { "s" }
            )
        )
    );
    println!("{code}");
    println!(
        "{} {}  {}",
        out(DIM, "Code ID"),
        out(BOLD, &id),
        out(DIM, "logged in issued.tsv")
    );
    eprintln!(
        "\n{} send it to {name} only, over a channel you trust. In Provide.: Technician code, then Add, then scan.",
        err(YELLOW, "Secret:")
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh authority directory for one test.
    fn initialized(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("iot-authority-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        init(&dir).unwrap();
        dir
    }

    #[test]
    fn the_short_forms_use_the_default_directory_and_name_their_customer() {
        let dir = std::env::temp_dir().join(format!("iot-authority-short-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let key = "11".repeat(32);
        assert_eq!(run(&["init"], &dir), Ok(()));
        assert_eq!(run(&["public"], &dir), Ok(()));
        let no_customer = run(&["certify", &key], &dir).unwrap_err();
        assert!(
            no_customer.contains("--customer"),
            "no customer imposed: {no_customer}"
        );
        assert_eq!(
            run(&["certify", &key, "--customer", "Noé Home"], &dir),
            Ok(())
        );
        assert_eq!(
            run(&["issue", "Evaluator", "--customer=DEMO"], &dir),
            Ok(())
        );
        assert!(
            run(&["issue", "Evaluator", "DEMO"], &dir).is_err(),
            "no 2-word form"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_readable_customer_name_gives_a_stable_identifier() {
        let home = customer("Noé Home").unwrap();
        assert_eq!(home.id, "NOE-HOME");
        assert_eq!(home.to_string(), "Noé Home (NOE-HOME)");
        assert_eq!(
            customer("Hôpital Saint-Louis").unwrap().id,
            "HOPITAL-SAINT-LOUIS"
        );
        assert_eq!(
            customer("NOE-HOME").unwrap(),
            Customer {
                id: "NOE-HOME".into(),
                name: "NOE-HOME".into()
            }
        );
        assert_eq!(
            customer("NOE-HOME").unwrap().to_string(),
            "NOE-HOME",
            "an ID is shown once"
        );
        assert_eq!(
            customer("  demo ").unwrap().id,
            "DEMO",
            "sensors compare IDs exactly: one case only"
        );
        assert_eq!(customer("Lab_2").unwrap().id, "LAB_2");
        for wrong in ["", "   ", "--", "Café ☕", "北京", &"x".repeat(33)] {
            assert!(customer(wrong).is_err(), "{wrong:?}");
        }
    }

    #[test]
    fn a_sensor_gets_one_customer_and_a_code_any_of_them() {
        let dir = initialized("customers");
        let two = ["Noé Home".to_string(), "Hôpital Saint-Louis".to_string()];
        let never = |_: &Customer| -> Option<bool> { panic!("an explicit choice asks nothing") };
        let both = choose(&dir, &two, true, "Issue", never).unwrap();
        assert_eq!(
            both.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["NOE-HOME", "HOPITAL-SAINT-LOUIS"]
        );
        let one = choose(&dir, &two, false, "Certify", never).unwrap_err();
        assert!(one.contains("one customer"), "{one}");
        let twice = ["Noé Home".to_string(), "NOE HOME".to_string()];
        assert!(
            choose(&dir, &twice, true, "Issue", never)
                .unwrap_err()
                .contains("twice")
        );
        let nine: Vec<String> = (0..9).map(|i| format!("C{i}")).collect();
        assert!(
            choose(&dir, &nine, true, "Issue", never).is_err(),
            "8 customers at most per code"
        );

        assert_eq!(
            run(
                &[
                    "issue",
                    "Alex",
                    "--customer",
                    "Noé Home",
                    "--customer",
                    "Hôpital Saint-Louis"
                ],
                &dir
            ),
            Ok(())
        );
        assert_eq!(
            run(&["issue", "Sam", "--customer", "Hôpital Saint-Louis"], &dir),
            Ok(())
        );
        let issued = std::fs::read_to_string(dir.join(ISSUED_LOG)).unwrap();
        let customers: Vec<&str> = issued
            .lines()
            .map(|line| line.split('\t').nth(2).unwrap())
            .collect();
        assert_eq!(
            customers,
            ["NOE-HOME,HOPITAL-SAINT-LOUIS", "HOPITAL-SAINT-LOUIS"],
            "the code holds IDs"
        );

        assert!(
            run(
                &["deploy", "jetson-027", "--customer", "A", "--customer", "B"],
                &dir
            )
            .is_err()
        );
        assert!(
            run(&["deploy", "jetson-027", "--customer"], &dir)
                .unwrap_err()
                .contains("--customer")
        );
        assert!(
            run(&["public", "--customer", "A"], &dir).is_err(),
            "only deploy, certify and issue take it"
        );
        assert!(
            run(&["issue", "Alex", "--customers", "A"], &dir).is_err(),
            "unknown option"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_last_customer_is_offered_again_only_with_a_confirmation() {
        let dir = initialized("last");
        let none: [String; 0] = [];
        let unused = |_: &Customer| -> Option<bool> { panic!("nothing to confirm yet") };
        assert!(
            choose(&dir, &none, false, "Certify", unused)
                .unwrap_err()
                .contains("--customer")
        );
        run(
            &["certify", &"11".repeat(32), "--customer", "Noé Home"],
            &dir,
        )
        .unwrap();
        let mut shown = String::new();
        let yes = choose(&dir, &none, false, "Certify", |c| {
            shown = c.to_string();
            Some(true)
        });
        assert_eq!(yes.unwrap()[0].id, "NOE-HOME");
        assert_eq!(
            shown, "Noé Home (NOE-HOME)",
            "the readable name is remembered too"
        );
        assert!(
            choose(&dir, &none, false, "Certify", |_| Some(false))
                .unwrap_err()
                .contains("cancelled")
        );
        let script = choose(&dir, &none, false, "Certify", |_| None).unwrap_err();
        assert!(
            script.contains("--customer NOE-HOME"),
            "no terminal, no question: {script}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_technician_name_has_no_special_characters() {
        let dir = initialized("names");
        for good in ["Noé", "Jean-Pierre O'Brien", "J. Smith 2"] {
            assert_eq!(
                run(&["issue", good, "--customer", "DEMO"], &dir),
                Ok(()),
                "{good}"
            );
        }
        for bad in [
            "",
            "  ",
            "Alex\tDEMO",
            "Line\nbreak",
            "Bob<script>",
            "Ana/Bea",
            "a@b",
            "Noé 😀",
            "x;rm",
            "Alex\u{3164}",
            "\u{0410}lex",
            "--help",
            "-h",
        ] {
            let refused = run(&["issue", bad, "--customer", "DEMO"], &dir).unwrap_err();
            assert!(refused.contains("technician name"), "{bad:?}: {refused}");
        }
        let dir_text = dir.display().to_string();
        assert!(
            run(&["issue", &dir_text, "Bob<script>", "DEMO"], &dir).is_err(),
            "the long form too"
        );
        let issued = std::fs::read_to_string(dir.join(ISSUED_LOG)).unwrap();
        assert_eq!(issued.lines().count(), 3, "nothing refused reached the log");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deploy_sets_the_sensor_clock_floor_to_the_workshop_time() {
        let command = start_command("CERT", "AUTHORITY", 1_792_879_921);
        let floor = command
            .find("echo 1792879921 > /var/lib/iot-device/clock-floor")
            .expect("the workshop time becomes the floor");
        let restart = command.find("systemctl restart iot-device").unwrap();
        assert!(floor < restart, "the service reads the floor at startup");
        assert!(
            command.contains(
                "sudo -u iot sh -c \"umask 077; echo 1792879921 > /var/lib/iot-device/clock-floor\""
            ),
            "written as the service's account: root never follows a link it planted"
        );
        assert!(
            command.starts_with("sudo -k -S -p '' sh -c 'exec </dev/null;"),
            "the password never reaches a child"
        );
        assert!(command.contains("iot-stage install /var/lib/iot-device CERT AUTHORITY"));
    }

    #[test]
    fn uninstall_removes_what_install_put_and_keeps_the_key_aside() {
        let command = uninstall_command(1_792_879_921);
        assert!(
            command.starts_with("sudo -k -S -p '' sh -c 'exec </dev/null;"),
            "the password never reaches a child"
        );
        for path in [
            "/etc/systemd/system/iot-device.service",
            "/usr/local/bin/iot-device",
            "/usr/local/bin/iot-stage",
            "/etc/default/iot-device",
            "/etc/polkit-1/localauthority/50-local.d/iot-device.pkla",
            "/etc/polkit-1/rules.d/50-iot-device.rules",
            "/etc/systemd/system/bluetooth.service.d/iot-device.conf",
        ] {
            assert!(command.contains(path), "systemd/install.sh puts {path}");
        }
        assert!(
            command.contains("mv /var/lib/iot-device /root/iot-backup/iot-device-1792879921"),
            "the sensor key is kept, root only"
        );
        assert!(command.contains("userdel iot"));
        for uuid in WIFI_PROFILES {
            let wifi = command
                .find(uuid)
                .expect("both Wi-Fi profiles are forgotten");
            assert!(
                wifi > command.find("userdel iot").unwrap(),
                "last: over Wi-Fi, the link drops there"
            );
        }
    }

    #[test]
    fn uninstall_asks_first_and_a_script_must_say_yes() {
        let dir = Path::new("/nonexistent");
        let script = uninstall("jetson-027", false, |_| None).unwrap_err();
        assert!(
            script.contains("--yes"),
            "no terminal, no question: {script}"
        );
        assert!(
            uninstall("jetson-027", false, |_| Some(false))
                .unwrap_err()
                .contains("cancelled")
        );
        assert!(
            uninstall("-oProxyCommand=sh", true, |_| None).is_err(),
            "the host is checked first"
        );
        assert!(run(&["uninstall", "jetson-027", "--customer", "DEMO"], dir).is_err());
    }

    #[test]
    fn deploy_pins_a_wifi_interface_only_when_asked() {
        assert!(
            install_command(None).contains("iot-deploy/systemd/install.sh >/dev/null"),
            "no interface: the service takes the first Wi-Fi device (noe-lab's is wlo1, not wlan0)"
        );
        assert!(
            install_command(Some("wlo1")).contains("iot-deploy/systemd/install.sh wlo1 >/dev/null")
        );
        assert!(install_command(None).starts_with("sudo -k -S -p '' sh -c 'exec </dev/null;"));
    }

    #[test]
    fn uninstall_forgets_the_profiles_the_service_creates() {
        let service = include_str!("../../device/bin/wifi.rs");
        for uuid in WIFI_PROFILES {
            assert!(
                service.contains(uuid),
                "{uuid} is one of PROFILE_UUIDS in device/bin/wifi.rs"
            );
        }
    }

    #[test]
    fn colour_only_where_a_person_reads_it() {
        assert_eq!(
            paint(false, GREEN, "ready"),
            "ready",
            "pipes and scripts read plain lines"
        );
        assert_eq!(paint(true, GREEN, "ready"), "\x1b[1;32mready\x1b[0m");
    }

    #[test]
    fn expiry_reads_as_a_utc_date() {
        assert_eq!(utc(0), "1970-01-01 00:00 UTC");
        assert_eq!(utc(951_782_400), "2000-02-29 00:00 UTC", "a leap day");
        assert_eq!(utc(1_792_879_921), "2026-10-24 22:12 UTC");
    }

    #[test]
    fn help_is_a_command_and_every_mistake_points_to_it() {
        let dir = Path::new("/nonexistent");
        for help in ["help", "--help", "-h"] {
            assert_eq!(run(&[help], dir), Ok(()), "{help}");
        }
        let mistake = run(&["isue", "Bob"], dir).unwrap_err();
        assert!(mistake.contains("iot-workshop help"), "{mistake}");
    }

    #[test]
    fn deploy_refuses_a_host_or_interface_the_shell_or_ssh_would_read_as_more() {
        assert_eq!(target("jetson-027", Some("wlan0")), Ok(()));
        assert_eq!(target("floware@192.168.55.1", Some("wlo1")), Ok(()));
        assert!(
            target("-oProxyCommand=sh", Some("wlan0")).is_err(),
            "an ssh option"
        );
        assert!(target("", Some("wlan0")).is_err());
        assert!(
            target("jetson-027", Some("wlan0; reboot")).is_err(),
            "a shell command"
        );
        assert!(target("jetson-027", Some("")).is_err());
    }

    #[test]
    fn deploy_reads_the_public_key_stage_init_prints() {
        let key = "ab".repeat(32);
        let output = format!(
            "IOT-0123456789 keyed in /var/lib/iot-device\npublic key (certify it with `iot-workshop certify`): {key}\n"
        );
        assert_eq!(public_key_in(&output), Ok(key));
        assert!(public_key_in("IOT-0123456789 keyed in /var/lib/iot-device\n").is_err());
    }

    #[test]
    fn issue_refuses_more_than_5_days() {
        let dir = initialized("days");
        let demo = [Customer::exact("DEMO")];
        assert!(issue(&dir, "Noé", &demo, 6).is_err());
        assert!(
            issue(&dir, "Noé", &demo, 0).is_err(),
            "a code that is born expired"
        );
        assert!(issue(&dir, "Noé", &demo, 5).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_sensor_answer_is_printed_without_control_characters() {
        assert_eq!(printable("IOT-1 advertising\n"), "IOT-1 advertising\n");
        assert_eq!(
            printable("\x1b]52;c;bad\x07ok\x1b[2K"),
            "?]52;c;bad?ok?[2K",
            "no escape sequence reaches the terminal"
        );
    }

    #[test]
    fn init_keeps_the_authority_folder_private() {
        let dir = initialized("private");
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o700,
            "issued.tsv and the key names stay out of other accounts' reach"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_second_init_never_overwrites_an_authority() {
        let dir = initialized("twice");
        let keys = |dir: &Path| {
            [DEVICE_KEY, TECHNICIAN_KEY].map(|name| std::fs::read(dir.join(name)).unwrap())
        };
        let before = keys(&dir);
        assert!(init(&dir).is_err());
        assert_eq!(keys(&dir), before);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_issue_log_holds_the_code_id_never_the_code() {
        let dir = initialized("log");
        run(&["issue", "Alex", "--customer", "DEMO"], &dir).unwrap();
        let path = dir.join(ISSUED_LOG);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let log = std::fs::read_to_string(&path).unwrap();
        let fields: Vec<&str> = log.trim_end().split('\t').collect();
        assert_eq!(fields.len(), 4, "ID, name, customers, expiry");
        assert_eq!(fields[0].len(), 2 * 8, "the code ID");
        assert!(
            !log.contains('.') && log.len() < 80,
            "no code, no 64-hex private key: {log}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_key_open_to_group_is_refused() {
        let dir = initialized("mode");
        assert!(load(&dir, TECHNICIAN_KEY).is_ok());
        let key = dir.join(TECHNICIAN_KEY);
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(&dir, TECHNICIAN_KEY).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
