// Secret storage: the system keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux), one entry
// per name under the app's identifier. The page reads and writes through secureStore.web.ts; nothing is kept here.

const SERVICE: &str = "dev.iotchallenge.provide";

/// Only the names the app stores (`technician-token`, `site-password-<UUID>`…): the page cannot reach other entries.
fn entry(key: &str) -> Result<keyring::Entry, String> {
    let plain = !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !plain {
        return Err(format!("{key:?} is not the name of a Provide secret"));
    }
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(async)]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_is_kept_replaced_and_forgotten() {
        // The mock keychain: each entry lives as long as its Entry, so one key is read through one Entry here.
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let token = entry("technician-token").unwrap();
        assert!(matches!(token.get_password(), Err(keyring::Error::NoEntry)));
        token.set_password("one").unwrap();
        token.set_password("two").unwrap();
        assert_eq!(token.get_password().unwrap(), "two");
        token.delete_credential().unwrap();
        assert!(matches!(token.get_password(), Err(keyring::Error::NoEntry)));
    }

    #[test]
    #[ignore = "uses the real system keychain: cargo test -- --ignored"]
    fn the_system_keychain_keeps_a_secret() {
        let key = format!("provide-test-{}", std::process::id());
        secret_set(key.clone(), "value".to_string()).unwrap();
        assert_eq!(secret_get(key.clone()).unwrap().as_deref(), Some("value"));
        secret_delete(key.clone()).unwrap();
        assert_eq!(secret_get(key).unwrap(), None);
    }

    #[test]
    fn the_page_reaches_only_provide_secrets() {
        assert!(entry("site-password-3b0a90ce-9564-40d1-b96b-14cf8858aba3").is_ok());
        for name in ["", "../login", "a b", "com.apple.account", &"x".repeat(129)] {
            assert!(entry(name).is_err(), "{name:?}");
        }
    }
}
