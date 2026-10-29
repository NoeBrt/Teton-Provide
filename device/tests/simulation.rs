use iot_provisioning::protocol::{DEVICE_ID, REQUEST, RESPONSE};
use iot_provisioning::simulation::{Device, Error, Fault};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(2);

#[test]
fn discover_connect_exchange_and_close() {
    let device = Device::new();
    assert_eq!(device.discover(), Some(DEVICE_ID));
    let mut session = device.connect(Fault::None).unwrap();
    assert_eq!(session.request(REQUEST, TIMEOUT), Ok(RESPONSE));
    assert_eq!(session.close(), Ok(()));
    assert_eq!(session.request(REQUEST, TIMEOUT), Err(Error::Disconnected));
}

#[test]
fn malformed_input_is_rejected_and_a_valid_request_can_follow() {
    let device = Device::new();
    let mut session = device.connect(Fault::None).unwrap();
    for payload in [b"".as_slice(), b"hello\n", b"\xff", b"password=example"] {
        assert_eq!(
            session.request(payload, TIMEOUT),
            Err(Error::InvalidRequest)
        );
    }
    assert_eq!(
        session.request(&vec![b'a'; 65_536], TIMEOUT),
        Err(Error::InvalidRequest)
    );
    assert_eq!(session.request(REQUEST, TIMEOUT), Ok(RESPONSE));
}

#[test]
fn dropped_reply_times_out_and_invalidates_the_session() {
    let device = Device::new();
    let mut session = device.connect(Fault::DropReply).unwrap();
    assert_eq!(
        session.request(REQUEST, Duration::from_millis(5)),
        Err(Error::Timeout)
    );
    assert_eq!(session.request(REQUEST, TIMEOUT), Err(Error::Disconnected));
    assert_eq!(
        device
            .connect(Fault::None)
            .unwrap()
            .request(REQUEST, TIMEOUT),
        Ok(RESPONSE)
    );
}

#[test]
fn disconnect_after_request_is_distinct_from_timeout() {
    let device = Device::new();
    let mut session = device.connect(Fault::DisconnectAfterRequest).unwrap();
    assert_eq!(session.request(REQUEST, TIMEOUT), Err(Error::Disconnected));
    assert_eq!(
        device
            .connect(Fault::None)
            .unwrap()
            .request(REQUEST, TIMEOUT),
        Ok(RESPONSE)
    );
}

#[test]
fn restart_invalidates_existing_sessions_and_restores_discovery() {
    let device = Device::new();
    let mut old_session = device.connect(Fault::None).unwrap();
    assert_eq!(old_session.request(REQUEST, TIMEOUT), Ok(RESPONSE));
    device.stop();
    assert_eq!(device.discover(), None);
    assert!(matches!(
        device.connect(Fault::None),
        Err(Error::Unavailable)
    ));
    assert_eq!(
        old_session.request(REQUEST, TIMEOUT),
        Err(Error::Disconnected)
    );

    let replacement = Device::new();
    assert_eq!(replacement.discover(), Some(DEVICE_ID));
    assert_eq!(
        replacement
            .connect(Fault::None)
            .unwrap()
            .request(REQUEST, TIMEOUT),
        Ok(RESPONSE)
    );
}

#[test]
fn dropping_the_device_invalidates_a_live_session() {
    let mut session = {
        let device = Device::new();
        device.connect(Fault::None).unwrap()
    };
    assert_eq!(session.request(REQUEST, TIMEOUT), Err(Error::Disconnected));
}

#[test]
fn repeated_sessions_exchange_and_join_cleanly() {
    let device = Device::new();
    for _ in 0..20 {
        let mut session = device.connect(Fault::None).unwrap();
        for _ in 0..20 {
            assert_eq!(session.request(REQUEST, TIMEOUT), Ok(RESPONSE));
        }
        assert_eq!(session.close(), Ok(()));
    }
}

#[test]
fn stop_racing_with_a_request_leaves_the_old_session_unusable() {
    let device = Device::new();
    let mut session = device.connect(Fault::DropReply).unwrap();
    let ready = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let request = scope.spawn(|| {
            ready.wait();
            session.request(b"hello", Duration::from_millis(5))
        });
        ready.wait();
        device.stop();
        assert!(matches!(
            request.join().unwrap(),
            Err(Error::Disconnected | Error::Timeout)
        ));
    });
    assert_eq!(session.request(b"hello", TIMEOUT), Err(Error::Disconnected));
    assert_eq!(device.discover(), None);
    assert!(matches!(
        device.connect(Fault::None),
        Err(Error::Unavailable)
    ));
    assert_eq!(session.close(), Ok(()));
}
