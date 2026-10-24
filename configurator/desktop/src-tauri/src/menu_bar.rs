use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn open_main(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Provide is unavailable")?;
    window
        .unminimize()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus())
        .map_err(|error| error.to_string())?;
    hide_menu_bar(app)
}

#[tauri::command]
pub fn hide_menu_bar(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("menubar") {
        panel.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn panel_height(sensor_count: u32) -> f64 {
    (210.0 + 64.0 * f64::from(sensor_count.min(5))).max(290.0)
}

#[tauri::command]
pub fn resize_menu_bar(app: AppHandle, sensor_count: u32) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("menubar") {
        let available = panel
            .current_monitor()
            .map_err(|error| error.to_string())?
            .map(|monitor| {
                f64::from(monitor.work_area().size.height) / monitor.scale_factor() - 16.0
            })
            .unwrap_or(530.0)
            .max(1.0);
        panel
            .set_size(tauri::LogicalSize::new(
                380.0,
                panel_height(sensor_count).min(available),
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        WebviewUrl, WebviewWindowBuilder,
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    WebviewWindowBuilder::new(
        app,
        "menubar",
        WebviewUrl::App("index.html?menubar=1".into()),
    )
    .title("Provide · Sensors")
    .inner_size(380.0, panel_height(0))
    .visible(false)
    .focused(false)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .effects(tauri::utils::config::WindowEffectsConfig {
        effects: vec![
            tauri::utils::WindowEffect::LiquidGlassRegular,
            tauri::utils::WindowEffect::Popover,
        ],
        radius: Some(26.0),
        state: Some(tauri::utils::WindowEffectState::Active),
        ..Default::default()
    })
    .resizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .build()?;
    let open = MenuItem::with_id(app, "open", "Open Provide.", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Provide.", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    if let Some(tauri::menu::MenuItemKind::Submenu(window_menu)) = app
        .menu()
        .and_then(|menu| menu.get(tauri::menu::WINDOW_SUBMENU_ID))
    {
        window_menu.append(&MenuItem::with_id(
            app,
            "sensors",
            "Nearby Sensors",
            true,
            Some("CmdOrCtrl+Shift+P"),
        )?)?;
    }
    TrayIconBuilder::with_id("provide")
        .icon(tauri::include_image!("icons/menu-bar.png"))
        .icon_as_template(true)
        .tooltip("Provide. · Nearby sensors")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Err(error) = open_main(app.clone()) {
                    eprintln!("Could not open Provide: {error}");
                }
            }
            "quit" => app.exit(0),
            "sensors" => {
                if let Some(tray) = app.tray_by_id("provide") {
                    match tray
                        .rect()
                        .and_then(|rect| rect.map(|rect| show_panel(app, rect)).transpose())
                    {
                        Ok(_) => {}
                        Err(error) => eprintln!("Could not show the menu panel: {error}"),
                    }
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
                && let Err(error) = show_panel(tray.app_handle(), rect)
            {
                eprintln!("Could not show the menu panel: {error}");
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn show_panel(app: &AppHandle, rect: tauri::Rect) -> tauri::Result<()> {
    let Some(panel) = app.get_webview_window("menubar") else {
        return Ok(());
    };
    let position = rect.position.to_physical::<f64>(panel.scale_factor()?);
    let monitor = app
        .monitor_from_point(position.x, position.y)?
        .or(app.primary_monitor()?);
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let position = rect.position.to_physical::<f64>(scale);
        let size = rect.size.to_physical::<f64>(scale);
        let area = monitor.work_area();
        let width = 380.0 * scale;
        let desired = panel.inner_size()?.to_logical::<f64>(panel.scale_factor()?);
        let height = (desired.height * scale).min(f64::from(area.size.height) - 16.0 * scale);
        let (x, y) = panel_position(
            tauri::PhysicalPosition::new(position.x + size.width / 2.0, position.y + size.height),
            tauri::PhysicalSize::new(width, height),
            area.position,
            area.size,
            8.0 * scale,
        );
        panel.set_size(tauri::PhysicalSize::new(width, height))?;
        panel.set_position(tauri::PhysicalPosition::new(x, y))?;
    }
    panel.show()?;
    panel.set_focus()
}

#[cfg(any(target_os = "macos", test))]
fn panel_position(
    anchor: tauri::PhysicalPosition<f64>,
    panel: tauri::PhysicalSize<f64>,
    origin: tauri::PhysicalPosition<i32>,
    screen: tauri::PhysicalSize<u32>,
    margin: f64,
) -> (f64, f64) {
    let (x, y) = (f64::from(origin.x), f64::from(origin.y));
    (
        (anchor.x - panel.width / 2.0).clamp(
            x + margin,
            (x + f64::from(screen.width) - panel.width - margin).max(x + margin),
        ),
        (anchor.y + margin).clamp(
            y + margin,
            (y + f64::from(screen.height) - panel.height - margin).max(y + margin),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::{panel_height, panel_position};
    use tauri::{PhysicalPosition as Position, PhysicalSize as Size};

    #[test]
    fn panel_stays_on_its_monitor_even_at_the_edge_or_on_a_retina_display() {
        assert_eq!(
            panel_position(
                Position::new(1430.0, 24.0),
                Size::new(380.0, 560.0),
                Position::new(0, 24),
                Size::new(1440, 876),
                8.0
            ),
            (1052.0, 32.0)
        );
        assert_eq!(
            panel_position(
                Position::new(-2790.0, -100.0),
                Size::new(760.0, 1120.0),
                Position::new(-2880, -60),
                Size::new(2880, 1760),
                16.0
            ),
            (-2864.0, -44.0)
        );
    }

    #[test]
    fn panel_fits_a_small_list_and_caps_a_whole_wing() {
        assert!(panel_height(0) >= 290.0);
        assert!(panel_height(2) < panel_height(5));
        assert_eq!(panel_height(5), panel_height(200));
        assert_eq!(panel_height(200), panel_height(u32::MAX));
    }
}
