// Provide on desktop: the same app (configurator/, react-native-web) in a native window. Only the platform bridges live
// here; the screens and the protocol stay in TypeScript.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ble;
mod menu_bar;
mod secrets;

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
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            menu_bar::open_main,
            menu_bar::hide_menu_bar,
            menu_bar::resize_menu_bar,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            menu_bar::setup(app)?;
            // `--demo` opens the demo, as `?demo=1` does on the web build (App.tsx, launchedInDemo).
            if std::env::args().any(|arg| arg == "--demo") {
                let window = app.get_webview_window("main").expect("the main window");
                let mut url = window.url()?;
                url.set_query(Some("demo=1"));
                window.navigate(url)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("Could not hide Provide: {error}");
                    }
                }
                tauri::WindowEvent::Focused(false) if window.label() == "menubar" => {
                    if let Err(error) = window.hide() {
                        eprintln!("Could not hide the menu panel: {error}");
                    }
                }
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("Provide could not start")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event
                && let Err(error) = menu_bar::open_main(app.clone())
            {
                eprintln!("Could not reopen Provide: {error}");
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
