// Provide on desktop: the same app (configurator/, react-native-web) in a native window. Only the platform bridges live
// here; the screens and the protocol stay in TypeScript.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ble;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(ble::Ble::default())
        .invoke_handler(tauri::generate_handler![
            ble::ble_state,
            ble::ble_scan,
            ble::ble_stop_scan,
            ble::ble_connect,
            ble::ble_services,
            ble::ble_write,
            ble::ble_read,
            ble::ble_disconnect,
        ])
        .setup(|app| {
            // `--demo` opens the demo, as `?demo=1` does on the web build (App.tsx, launchedInDemo).
            if std::env::args().any(|arg| arg == "--demo") {
                let window = app.get_webview_window("main").expect("the main window");
                let mut url = window.url()?;
                url.set_query(Some("demo=1"));
                window.navigate(url)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Provide could not start");
}
