//! Bounded software workloads, not fleet discovery or BLE orchestration.

use super::{Device, Error, Fault};
use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchError {
    InvalidConfig,
    Transport(Error),
    UnexpectedResponse,
    WorkerFailed,
}

impl fmt::Display for BatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig => {
                formatter.write_str("Use 1-10000 devices and 1-32 concurrent clients.")
            }
            Self::Transport(error) => error.fmt(formatter),
            Self::UnexpectedResponse => formatter.write_str("Unexpected hello response."),
            Self::WorkerFailed => formatter.write_str("Batch worker failed."),
        }
    }
}

impl std::error::Error for BatchError {}

pub struct JobTiming {
    pub device_index: usize,
    pub service_time: Duration,
    pub completion_time: Duration,
}

pub struct Batch {
    pub jobs: Vec<JobTiming>,
    pub elapsed: Duration,
    pub peak_concurrency: usize,
}

/// Process independent fake device instances through a bounded pool of clients.
pub fn run_batch(device_count: usize, concurrency: usize) -> Result<Batch, BatchError> {
    if !(1..=10_000).contains(&device_count) || !(1..=32).contains(&concurrency) {
        return Err(BatchError::InvalidConfig);
    }
    let next = AtomicUsize::new(0);
    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let began = Instant::now();
    thread::scope(|scope| {
        let mut workers = Vec::with_capacity(concurrency.min(device_count));
        let mut failure = None;
        for _ in 0..concurrency.min(device_count) {
            let next = &next;
            let active = &active;
            let peak = &peak;
            let worker = thread::Builder::new()
                .name("simulated-batch-client".into())
                .spawn_scoped(scope, move || {
                    let mut jobs = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::SeqCst);
                        if index >= device_count {
                            break;
                        }
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(current, Ordering::SeqCst);
                        let started = Instant::now();
                        let result = (|| {
                            let device = Device::new();
                            let mut session =
                                device.connect(Fault::None).map_err(BatchError::Transport)?;
                            let response = session
                                .request(b"hello", Duration::from_secs(2))
                                .map_err(BatchError::Transport)?;
                            if response != b"world" {
                                return Err(BatchError::UnexpectedResponse);
                            }
                            session.close().map_err(BatchError::Transport)
                        })();
                        let service_time = started.elapsed();
                        let completion_time = began.elapsed();
                        active.fetch_sub(1, Ordering::SeqCst);
                        result?;
                        jobs.push(JobTiming {
                            device_index: index,
                            service_time,
                            completion_time,
                        });
                    }
                    Ok::<_, BatchError>(jobs)
                });
            match worker {
                Ok(worker) => workers.push(worker),
                Err(_) => {
                    failure = Some(BatchError::WorkerFailed);
                    break;
                }
            }
        }
        let mut jobs = Vec::with_capacity(device_count);
        for worker in workers {
            match worker.join() {
                Ok(Ok(completed)) => jobs.extend(completed),
                Ok(Err(error)) => failure = Some(error),
                Err(_) => failure = Some(BatchError::WorkerFailed),
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(Batch {
                jobs,
                elapsed: began.elapsed(),
                peak_concurrency: peak.load(Ordering::SeqCst),
            }),
        }
    })
}
