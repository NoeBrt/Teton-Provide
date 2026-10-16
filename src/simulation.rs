//! Software transport only: no Bluetooth, Wi-Fi, or credential exchange.

use crate::protocol::{self, DEVICE_ID};
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const MAX_PAYLOAD: usize = 20;
type Reply = Result<&'static [u8], Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Unavailable,
    Disconnected,
    Timeout,
    Busy,
    InvalidRequest,
    WorkerFailed,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "Device unavailable; discover again.",
            Self::Disconnected => "Device disconnected; reconnect and retry.",
            Self::Timeout => "Device did not respond; reconnect and retry.",
            Self::Busy => "Device busy; reconnect and retry.",
            Self::InvalidRequest => "Unsupported request; this endpoint accepts only hello.",
            Self::WorkerFailed => "Simulation worker failed.",
        })
    }
}

impl std::error::Error for Error {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    None,
    DropReply,
    DisconnectAfterRequest,
}

pub struct Device {
    online: Arc<AtomicBool>,
}

impl Device {
    pub fn new() -> Self {
        Self {
            online: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn discover(&self) -> Option<&'static str> {
        self.online.load(Ordering::SeqCst).then_some(DEVICE_ID)
    }

    pub fn connect(&self, fault: Fault) -> Result<Connection, Error> {
        if self.discover().is_none() {
            return Err(Error::Unavailable);
        }
        let (requests, incoming) = mpsc::sync_channel::<Vec<u8>>(1);
        let (outgoing, replies) = mpsc::sync_channel(1);
        let online = Arc::clone(&self.online);
        let worker = thread::Builder::new()
            .name("simulated-device".into())
            .spawn(move || {
                while let Ok(payload) = incoming.recv() {
                    if !online.load(Ordering::SeqCst) {
                        break;
                    }
                    match fault {
                        Fault::DisconnectAfterRequest => break,
                        Fault::DropReply => {
                            // Hold the reply channel open until the client closes its session.
                            let _ = incoming.recv();
                            break;
                        }
                        Fault::None => {
                            let reply =
                                protocol::respond(&payload).map_err(|_| Error::InvalidRequest);
                            if outgoing.try_send(reply).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|_| Error::WorkerFailed)?;
        Ok(Connection {
            online: Arc::clone(&self.online),
            requests: Some(requests),
            replies: Some(replies),
            worker: Some(worker),
        })
    }

    /// Invalidates discovery and requests; in-flight waits retain their deadline.
    pub fn stop(&self) {
        self.online.store(false, Ordering::SeqCst);
    }
}

impl Default for Device {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct Connection {
    online: Arc<AtomicBool>,
    requests: Option<SyncSender<Vec<u8>>>,
    replies: Option<Receiver<Reply>>,
    worker: Option<JoinHandle<()>>,
}

impl Connection {
    /// One request at a time; timeout/disconnect permanently closes this session.
    pub fn request(&mut self, payload: &[u8], timeout: Duration) -> Reply {
        if !self.online.load(Ordering::SeqCst) || self.requests.is_none() {
            self.close()?;
            return Err(Error::Disconnected);
        }
        if payload.len() > MAX_PAYLOAD {
            return Err(Error::InvalidRequest);
        }
        let result = match self.requests.as_ref().unwrap().try_send(payload.to_vec()) {
            Err(TrySendError::Full(_)) => Err(Error::Busy),
            Err(TrySendError::Disconnected(_)) => Err(Error::Disconnected),
            Ok(()) => match self.replies.as_ref().unwrap().recv_timeout(timeout) {
                Ok(reply) if self.online.load(Ordering::SeqCst) => reply,
                Ok(_) | Err(RecvTimeoutError::Disconnected) => Err(Error::Disconnected),
                Err(RecvTimeoutError::Timeout) => Err(Error::Timeout),
            },
        };
        if result.is_err() && result != Err(Error::InvalidRequest) {
            self.close()?;
        }
        result
    }

    /// Closing both channels wakes the worker before joining it.
    pub fn close(&mut self) -> Result<(), Error> {
        // Reject late replies before waking the worker through request-channel closure.
        self.replies.take();
        self.requests.take();
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| Error::WorkerFailed)?;
        }
        Ok(())
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{REQUEST, RESPONSE};

    #[test]
    fn late_response_is_rejected_after_the_actual_session_times_out() {
        let (requests, incoming) = mpsc::sync_channel::<Vec<u8>>(1);
        let (outgoing, replies) = mpsc::sync_channel(1);
        let rejected = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&rejected);
        let worker = thread::spawn(move || {
            assert_eq!(incoming.recv().unwrap(), REQUEST);
            assert!(incoming.recv().is_err());
            observed.store(outgoing.try_send(Ok(RESPONSE)).is_err(), Ordering::SeqCst);
        });
        let mut session = Connection {
            online: Arc::new(AtomicBool::new(true)),
            requests: Some(requests),
            replies: Some(replies),
            worker: Some(worker),
        };
        assert_eq!(
            session.request(REQUEST, Duration::from_millis(5)),
            Err(Error::Timeout)
        );
        assert!(rejected.load(Ordering::SeqCst));
        assert_eq!(
            session.request(REQUEST, Duration::from_secs(2)),
            Err(Error::Disconnected)
        );
        let device = Device::new();
        assert_eq!(
            device
                .connect(Fault::None)
                .unwrap()
                .request(REQUEST, Duration::from_secs(2)),
            Ok(RESPONSE)
        );
    }

    #[test]
    fn errors_do_not_echo_arbitrary_payloads() {
        let device = Device::new();
        let mut session = device.connect(Fault::None).unwrap();
        let error = session
            .request(b"password=example", Duration::from_secs(2))
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Unsupported request; this endpoint accepts only hello."
        );
        assert_eq!(format!("{error:?}"), "InvalidRequest");
    }

    #[test]
    fn client_disappearing_joins_an_idle_worker() {
        let (requests, incoming) = mpsc::sync_channel::<Vec<u8>>(1);
        let (_outgoing, replies) = mpsc::sync_channel(1);
        let exited = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&exited);
        let worker = thread::spawn(move || {
            assert!(incoming.recv().is_err());
            observed.store(true, Ordering::SeqCst);
        });
        let session = Connection {
            online: Arc::new(AtomicBool::new(true)),
            requests: Some(requests),
            replies: Some(replies),
            worker: Some(worker),
        };
        drop(session);
        assert!(exited.load(Ordering::SeqCst));
    }
}
