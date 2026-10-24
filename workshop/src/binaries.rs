//! Release binaries for SSH deployment; local Linux builds remain an offline override.

use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub(super) const RELEASE: &str = "v1.1.0";
const REPOSITORY: &str = "NoeBrt/Teton-Provide";
/// SHA-256 of each RELEASE asset, pinned here: a replaced release asset (with its published .sha256) is refused.
const PINNED: [(&str, &str); 4] = [
    (
        "iot-device-v1.1.0-linux-aarch64",
        "62a1b7aa29786e6edb7e114a9953dd6688e32f33cbf2e8c21b82e4297dd588b4",
    ),
    (
        "iot-stage-v1.1.0-linux-aarch64",
        "0f4d6047a5bbea2948b2c2f1a4536af5c69f89a3f1d37a4b26d012b12ac5395a",
    ),
    (
        "iot-device-v1.1.0-linux-x86_64",
        "7645f2d8bca8ca3157dfe70eed9cf4f26b88a50da53b943e041d0663e2dfa2d7",
    ),
    (
        "iot-stage-v1.1.0-linux-x86_64",
        "c889d1f464311d6a87812b82ff134b58f391225ab31d39935bf19a0cace21a70",
    ),
];

pub(super) fn prepare(arch: &str, device_dir: &Path) -> Result<PathBuf, String> {
    prepare_with(arch, device_dir, &PINNED, download)
}

fn download(asset: &str) -> Result<Vec<u8>, String> {
    download_with(asset, Command::new("gh"))
}

fn download_with(asset: &str, mut command: Command) -> Result<Vec<u8>, String> {
    let output = command
        .args([
            "release", "download", RELEASE, "--repo", REPOSITORY,
            "--pattern", asset, "--output", "-",
        ])
        .env("GH_HOST", "github.com")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("GitHub CLI (gh) is needed for private release downloads: {e}; install it and run `gh auth login`"))?;
    if !output.status.success() {
        return Err(format!(
            "cannot download {asset} from {REPOSITORY} ({RELEASE}): {}. Run `gh auth login` with access to this repository and check internet access; no sensor was installed",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn prepare_with(
    arch: &str,
    device_dir: &Path,
    pinned: &[(&str, &str)],
    mut fetch: impl FnMut(&str) -> Result<Vec<u8>, String>,
) -> Result<PathBuf, String> {
    let arch = arch.trim();
    if arch.is_empty() || !arch.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("unexpected sensor architecture {arch:?}"));
    }
    let local = device_dir.join(format!("target/linux-{arch}"));
    if ["device", "stage"]
        .iter()
        .all(|name| local.join(name).is_file())
    {
        return Ok(local);
    }
    if !matches!(arch, "aarch64" | "x86_64") {
        return Err(format!(
            "unsupported sensor architecture {arch:?}: provide a local build in {}",
            local.display()
        ));
    }
    let cache = device_dir.join(format!("target/sensor-{RELEASE}-linux-{arch}"));
    fs::create_dir_all(&cache).map_err(|e| format!("{}: {e}", cache.display()))?;
    for name in ["device", "stage"] {
        let destination = cache.join(name);
        if destination.is_file() {
            continue;
        }
        let asset = format!("iot-{name}-{RELEASE}-linux-{arch}");
        eprintln!("Downloading {asset}");
        let bytes = fetch(&asset)?;
        let pin = pinned
            .iter()
            .find(|(name, _)| *name == asset)
            .map(|(_, hash)| *hash);
        if bytes.is_empty() || pin != Some(format!("{:x}", Sha256::digest(&bytes)).as_str()) {
            return Err(format!(
                "SHA-256 check failed for {asset}; no sensor was installed"
            ));
        }
        let temporary = cache.join(format!(".{name}-{}", std::process::id()));
        let result = (|| {
            fs::write(&temporary, &bytes)?;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))?;
            fs::rename(&temporary, &destination)
        })();
        let _ = fs::remove_file(&temporary);
        result.map_err(|e| format!("{}: {e}", destination.display()))?;
    }
    Ok(cache)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("iot-binaries-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).unwrap();
        path
    }

    fn release_asset(_asset: &str) -> Result<Vec<u8>, String> {
        Ok(b"a Linux binary".to_vec())
    }

    /// The pins of a release whose assets are all `release_asset`'s bytes.
    fn pins() -> Vec<(String, String)> {
        let hash = format!("{:x}", Sha256::digest(b"a Linux binary"));
        PINNED
            .iter()
            .map(|(name, _)| (name.to_string(), hash.clone()))
            .collect()
    }

    fn prepare_test(
        arch: &str,
        root: &Path,
        fetch: impl FnMut(&str) -> Result<Vec<u8>, String>,
    ) -> Result<PathBuf, String> {
        let pins = pins();
        let pins: Vec<(&str, &str)> = pins.iter().map(|(a, h)| (a.as_str(), h.as_str())).collect();
        prepare_with(arch, root, &pins, fetch)
    }

    #[test]
    fn private_releases_use_the_authenticated_client_and_report_access_failures() {
        let root = fixture("private");
        let client = root.join("gh");
        fs::write(&client, "#!/bin/sh\n[ \"$GH_HOST\" = github.com ] && [ \"$GH_PROMPT_DISABLED\" = 1 ] || exit 78\n[ \"$*\" = 'release download v1.1.0 --repo NoeBrt/Teton-Provide --pattern sensor --output -' ] || exit 78\nprintf 'private binary'\n").unwrap();
        fs::set_permissions(&client, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            download_with("sensor", Command::new(&client)).unwrap(),
            b"private binary"
        );
        fs::write(
            &client,
            "#!/bin/sh\necho 'authentication required' >&2\nexit 4\n",
        )
        .unwrap();
        let error = download_with("sensor", Command::new(&client)).unwrap_err();
        assert!(error.contains("authentication required"));
        assert!(error.contains("gh auth login"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deploy_downloads_verified_executables_for_both_architectures_then_works_offline() {
        let root = fixture("download");
        for arch in ["aarch64", "x86_64"] {
            let path = prepare_test(arch, &root, release_asset).unwrap();
            for name in ["device", "stage"] {
                assert_eq!(fs::read(path.join(name)).unwrap(), b"a Linux binary");
                assert_eq!(
                    fs::metadata(path.join(name)).unwrap().permissions().mode() & 0o777,
                    0o755
                );
            }
            assert_eq!(
                prepare_test(arch, &root, |_| panic!("cached binaries need no internet")),
                Ok(path)
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deploy_preserves_local_builds_without_downloading() {
        let root = fixture("local");
        for arch in ["aarch64", "armv7l"] {
            let path = root.join(format!("target/linux-{arch}"));
            fs::create_dir_all(&path).unwrap();
            for name in ["device", "stage"] {
                fs::write(path.join(name), b"local").unwrap();
            }
            assert_eq!(
                prepare_test(&format!("{arch}\n"), &root, |_| panic!("local override")),
                Ok(path)
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deploy_never_caches_a_corrupt_empty_or_unavailable_binary() {
        let root = fixture("failure");
        for bad in [Vec::new(), b"tampered".to_vec()] {
            assert!(
                prepare_test("aarch64", &root, |_| Ok(bad.clone()))
                    .unwrap_err()
                    .contains("SHA-256")
            );
        }
        assert!(prepare_test("aarch64", &root, |_| Err("network down".into())).is_err());
        let cache = root.join(format!("target/sensor-{RELEASE}-linux-aarch64"));
        assert!(!cache.join("device").exists());
        assert!(!cache.join("stage").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deploy_resumes_after_a_partial_download_without_using_an_incomplete_local_build() {
        let root = fixture("resume");
        let local = root.join("target/linux-aarch64");
        fs::create_dir_all(&local).unwrap();
        fs::write(local.join("device"), b"incomplete local build").unwrap();
        assert!(
            prepare_test("aarch64", &root, |asset| {
                if asset.starts_with("iot-stage-") {
                    Err("network down".into())
                } else {
                    release_asset(asset)
                }
            })
            .is_err()
        );
        let path = prepare_test("aarch64", &root, |asset| {
            assert!(
                asset.starts_with("iot-stage-"),
                "reuse the verified device binary"
            );
            release_asset(asset)
        })
        .unwrap();
        assert_eq!(fs::read(path.join("device")).unwrap(), b"a Linux binary");
        assert_eq!(fs::read(path.join("stage")).unwrap(), b"a Linux binary");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn every_downloadable_asset_of_the_release_is_pinned() {
        for arch in ["aarch64", "x86_64"] {
            for name in ["device", "stage"] {
                let asset = format!("iot-{name}-{RELEASE}-linux-{arch}");
                assert!(
                    PINNED
                        .iter()
                        .any(|(pinned, hash)| *pinned == asset && hash.len() == 64),
                    "{asset}"
                );
            }
        }
    }

    #[test]
    fn deploy_refuses_unsupported_or_path_like_architectures_before_downloading() {
        for arch in ["../x", "armv7l", "", "aarch64; reboot"] {
            assert!(
                prepare_test(arch, Path::new("unused"), |_| panic!("must not download")).is_err()
            );
        }
    }
}
