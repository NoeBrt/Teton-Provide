//! Release binaries for SSH deployment; local Linux builds remain an offline override.

use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(super) const RELEASE: &str = "v1.1.0";
const REPOSITORY: &str = "https://github.com/NoeBrt/teton-provisioning";

pub(super) fn prepare(arch: &str, crate_dir: &Path) -> Result<PathBuf, String> {
    prepare_with(arch, crate_dir, download)
}

fn download(asset: &str) -> Result<Vec<u8>, String> {
    let url = format!("{REPOSITORY}/releases/download/{RELEASE}/{asset}");
    let output = Command::new("curl")
        .args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "15",
            "--max-time",
            "180",
            "--retry",
            "2",
            &url,
        ])
        .output()
        .map_err(|e| format!("curl (needed to download sensor binaries): {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "cannot download {url}: {}. Check internet access and the {RELEASE} release; no sensor was installed",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn prepare_with(
    arch: &str,
    crate_dir: &Path,
    mut fetch: impl FnMut(&str) -> Result<Vec<u8>, String>,
) -> Result<PathBuf, String> {
    let arch = arch.trim();
    if arch.is_empty() || !arch.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("unexpected sensor architecture {arch:?}"));
    }
    let local = crate_dir.join(format!("target/linux-{arch}"));
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
    let cache = crate_dir.join(format!("target/sensor-{RELEASE}-linux-{arch}"));
    fs::create_dir_all(&cache).map_err(|e| format!("{}: {e}", cache.display()))?;
    for name in ["device", "stage"] {
        let destination = cache.join(name);
        if destination.is_file() {
            continue;
        }
        let asset = format!("teton-{name}-{RELEASE}-linux-{arch}");
        eprintln!("Downloading {asset}");
        let bytes = fetch(&asset)?;
        let checksum = fetch(&format!("{asset}.sha256"))?;
        let expected = format!("{:x}  {asset}\n", Sha256::digest(&bytes));
        if bytes.is_empty() || checksum != expected.as_bytes() {
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
            std::env::temp_dir().join(format!("teton-binaries-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).unwrap();
        path
    }

    fn release_asset(asset: &str) -> Result<Vec<u8>, String> {
        let bytes = b"a Linux binary";
        Ok(match asset.strip_suffix(".sha256") {
            Some(name) => format!("{:x}  {name}\n", Sha256::digest(bytes)).into_bytes(),
            None => bytes.to_vec(),
        })
    }

    #[test]
    fn deploy_downloads_verified_executables_for_both_architectures_then_works_offline() {
        let root = fixture("download");
        for arch in ["aarch64", "x86_64"] {
            let path = prepare_with(arch, &root, release_asset).unwrap();
            for name in ["device", "stage"] {
                assert_eq!(fs::read(path.join(name)).unwrap(), b"a Linux binary");
                assert_eq!(
                    fs::metadata(path.join(name)).unwrap().permissions().mode() & 0o777,
                    0o755
                );
            }
            assert_eq!(
                prepare_with(arch, &root, |_| panic!("cached binaries need no internet")),
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
                prepare_with(&format!("{arch}\n"), &root, |_| panic!("local override")),
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
                prepare_with("aarch64", &root, |asset| {
                    if asset.ends_with(".sha256") {
                        release_asset(asset)
                    } else {
                        Ok(bad.clone())
                    }
                })
                .unwrap_err()
                .contains("SHA-256")
            );
        }
        assert!(prepare_with("aarch64", &root, |_| Err("network down".into())).is_err());
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
            prepare_with("aarch64", &root, |asset| {
                if asset.starts_with("teton-stage-") {
                    Err("network down".into())
                } else {
                    release_asset(asset)
                }
            })
            .is_err()
        );
        let path = prepare_with("aarch64", &root, |asset| {
            assert!(
                asset.starts_with("teton-stage-"),
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
    fn deploy_refuses_unsupported_or_path_like_architectures_before_downloading() {
        for arch in ["../x", "armv7l", "", "aarch64; reboot"] {
            assert!(
                prepare_with(arch, Path::new("unused"), |_| panic!("must not download")).is_err()
            );
        }
    }
}
