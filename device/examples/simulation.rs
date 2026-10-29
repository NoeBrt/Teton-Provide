use sensor_provisioning::protocol::{REQUEST, RESPONSE};
use sensor_provisioning::simulation::{Device, Error, Fault};
use std::time::Duration;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("SIMULATION — in-memory software transport; no BLE or Wi-Fi");
    let device = Device::new();
    let id = device.discover().ok_or(Error::Unavailable)?;
    println!("DISCOVERED {id} (synthetic discovery)");
    let mut session = device.connect(Fault::None)?;
    println!("CONNECTED (local worker)");
    let response = session.request(REQUEST, Duration::from_secs(2))?;
    if response != RESPONSE {
        return Err("Unexpected demo response".into());
    }
    println!("REQUEST hello -> RESPONSE world");
    session.close()?;
    println!("CLOSED (worker joined)");
    Ok(())
}
