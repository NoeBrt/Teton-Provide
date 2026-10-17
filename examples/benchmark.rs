//! Simulation measurements only; no BLE, Wi-Fi, or 200-device throughput claims.

use std::time::{Duration, Instant};
use teton_provisioning::protocol::{DEVICE_ID, REQUEST, RESPONSE};
use teton_provisioning::simulation::batch::run_batch;
use teton_provisioning::simulation::{Connection, Device, Error, Fault};

const TIMEOUT: Duration = Duration::from_secs(2);
const SAMPLES: usize = 7;
const WARMUP: usize = 200;
const USAGE: &str = "Usage: cargo run --release --offline --example benchmark -- [--scale | --soak SECONDS]\nSECONDS must be an integer from 1 to 3600.";

#[derive(Debug, PartialEq, Eq)]
enum Mode {
    Benchmark,
    Scale,
    Soak(Duration),
    Help,
}

fn parse_args(args: &[String]) -> Result<Mode, &'static str> {
    match args {
        [] => Ok(Mode::Benchmark),
        [flag] if flag == "--help" => Ok(Mode::Help),
        [flag] if flag == "--scale" => Ok(Mode::Scale),
        [flag, seconds] if flag == "--soak" => seconds
            .parse::<u64>()
            .ok()
            .filter(|seconds| (1..=3_600).contains(seconds))
            .map(|seconds| Mode::Soak(Duration::from_secs(seconds)))
            .ok_or(USAGE),
        _ => Err(USAGE),
    }
}

fn percentile(sorted: &[Duration], percent: usize) -> Duration {
    assert!(!sorted.is_empty() && (1..=100).contains(&percent));
    sorted[(sorted.len() * percent).div_ceil(100) - 1]
}

fn exchange(session: &mut Connection) -> Result<(), Error> {
    assert_eq!(session.request(REQUEST, TIMEOUT)?, RESPONSE);
    Ok(())
}

fn benchmark(
    label: &str,
    operations: usize,
    mut operation: impl FnMut() -> Result<(), Error>,
) -> Result<(), Error> {
    for _ in 0..WARMUP {
        operation()?;
    }
    let mut rates = Vec::with_capacity(SAMPLES);
    let mut all_latencies = Vec::with_capacity(SAMPLES * operations);
    for sample in 1..=SAMPLES {
        let mut latencies = Vec::with_capacity(operations);
        let began = Instant::now();
        for _ in 0..operations {
            let before = Instant::now();
            operation()?;
            latencies.push(before.elapsed());
        }
        let elapsed = began.elapsed();
        let rate = operations as f64 / elapsed.as_secs_f64();
        latencies.sort_unstable();
        println!(
            "{label} sample={sample}/{SAMPLES} operations={operations} p50_us={:.3} p95_us={:.3} ops_per_s={rate:.1}",
            percentile(&latencies, 50).as_secs_f64() * 1e6,
            percentile(&latencies, 95).as_secs_f64() * 1e6,
        );
        rates.push(rate);
        all_latencies.extend(latencies);
    }
    rates.sort_by(f64::total_cmp);
    all_latencies.sort_unstable();
    println!(
        "{label} summary checked_operations={} pooled_p50_us={:.3} pooled_p95_us={:.3} median_ops_per_s={:.1} min_ops_per_s={:.1} max_ops_per_s={:.1}",
        all_latencies.len(),
        percentile(&all_latencies, 50).as_secs_f64() * 1e6,
        percentile(&all_latencies, 95).as_secs_f64() * 1e6,
        rates[SAMPLES / 2],
        rates[0],
        rates[SAMPLES - 1],
    );
    Ok(())
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Counts {
    cycles: usize,
    valid_replies: usize,
    invalid_requests: usize,
    disconnects: usize,
    timeouts: usize,
    unavailable: usize,
    restarts: usize,
    closed_sessions: usize,
}

impl Counts {
    fn expected_errors(&self) -> usize {
        self.invalid_requests + self.disconnects + self.timeouts + self.unavailable
    }
}

fn close(mut session: Connection, counts: &mut Counts) -> Result<(), Error> {
    session.close()?;
    counts.closed_sessions += 1;
    Ok(())
}

fn retry(device: &Device, counts: &mut Counts) -> Result<(), Error> {
    let mut session = device.connect(Fault::None)?;
    exchange(&mut session)?;
    counts.valid_replies += 1;
    close(session, counts)
}

fn soak_cycle(counts: &mut Counts) -> Result<(), Error> {
    let device = Device::new();
    assert_eq!(device.discover(), Some(DEVICE_ID));
    let mut session = device.connect(Fault::None)?;
    exchange(&mut session)?;
    assert_eq!(
        session.request(b"invalid", TIMEOUT),
        Err(Error::InvalidRequest)
    );
    counts.invalid_requests += 1;
    exchange(&mut session)?;
    counts.valid_replies += 2;
    close(session, counts)?;

    for (fault, expected, timeout) in [
        (Fault::DisconnectAfterRequest, Error::Disconnected, TIMEOUT),
        (Fault::DropReply, Error::Timeout, Duration::from_millis(2)),
    ] {
        let mut session = device.connect(fault)?;
        assert_eq!(session.request(REQUEST, timeout), Err(expected));
        assert_eq!(session.request(REQUEST, TIMEOUT), Err(Error::Disconnected));
        counts.disconnects += 1;
        close(session, counts)?;
        retry(&device, counts)?;
    }
    counts.disconnects += 1;
    counts.timeouts += 1;

    let mut session = device.connect(Fault::None)?;
    device.stop();
    assert_eq!(device.discover(), None);
    assert!(matches!(
        device.connect(Fault::None),
        Err(Error::Unavailable)
    ));
    counts.unavailable += 1;
    assert_eq!(session.request(REQUEST, TIMEOUT), Err(Error::Disconnected));
    counts.disconnects += 1;
    close(session, counts)?;
    retry(&Device::new(), counts)?;
    counts.restarts += 1;
    counts.cycles += 1;
    Ok(())
}

fn soak(duration: Duration) -> Result<(), Error> {
    println!(
        "soak requested_seconds={}; finishes the current bounded cycle at the deadline",
        duration.as_secs()
    );
    let began = Instant::now();
    let mut counts = Counts::default();
    while began.elapsed() < duration {
        soak_cycle(&mut counts)?;
    }
    println!(
        "soak elapsed_seconds={:.3} expected_errors={} unexpected_errors=0 {counts:?}",
        began.elapsed().as_secs_f64(),
        counts.expected_errors(),
    );
    Ok(())
}

fn scaled_benchmark() -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "Independent fake device jobs; all queued at batch start. Concurrency limits active clients, not radio connections."
    );
    println!(
        "Each job creates a device/session, checks hello/world, closes and joins. One full warmup batch per case; {SAMPLES} measured batches."
    );
    println!(
        "Batch time includes client-pool creation/join. Service time excludes queue wait; completion time includes it. IDs are task indices, not authenticated device identities."
    );
    println!(
        "devices,concurrency,samples,checked_jobs,peak_clients,median_batch_ms,p50_service_us,p95_service_us,p95_completion_ms,median_jobs_per_s,min_jobs_per_s,max_jobs_per_s"
    );
    for devices in [1, 20, 50, 200, 1_000] {
        for concurrency in [1, 4, 8] {
            run_batch(devices, concurrency)?;
            let mut batch_times = Vec::with_capacity(SAMPLES);
            let mut service_times = Vec::with_capacity(SAMPLES * devices);
            let mut completion_times = Vec::with_capacity(SAMPLES * devices);
            let mut peak = 0;
            for _ in 0..SAMPLES {
                let batch = run_batch(devices, concurrency)?;
                assert_eq!(batch.jobs.len(), devices);
                assert!((1..=concurrency.min(devices)).contains(&batch.peak_concurrency));
                peak = peak.max(batch.peak_concurrency);
                batch_times.push(batch.elapsed);
                let mut indices = Vec::with_capacity(devices);
                for job in batch.jobs {
                    indices.push(job.device_index);
                    service_times.push(job.service_time);
                    completion_times.push(job.completion_time);
                }
                indices.sort_unstable();
                assert!(indices.iter().copied().eq(0..devices));
            }
            batch_times.sort_unstable();
            service_times.sort_unstable();
            completion_times.sort_unstable();
            println!(
                "{devices},{concurrency},{SAMPLES},{},{peak},{:.3},{:.3},{:.3},{:.3},{:.1},{:.1},{:.1}",
                service_times.len(),
                percentile(&batch_times, 50).as_secs_f64() * 1e3,
                percentile(&service_times, 50).as_secs_f64() * 1e6,
                percentile(&service_times, 95).as_secs_f64() * 1e6,
                percentile(&completion_times, 95).as_secs_f64() * 1e3,
                devices as f64 / percentile(&batch_times, 50).as_secs_f64(),
                devices as f64 / batch_times[SAMPLES - 1].as_secs_f64(),
                devices as f64 / batch_times[0].as_secs_f64(),
            );
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mode = parse_args(&std::env::args().skip(1).collect::<Vec<_>>())?;
    if mode == Mode::Help {
        println!("{USAGE}");
        return Ok(());
    }
    println!("SIMULATION ONLY: std channels and worker threads; no radio or network measurements.");
    match mode {
        Mode::Benchmark => {
            println!(
                "Release build recommended. {WARMUP} checked warmup operations per mode; {SAMPLES} sequential samples."
            );
            println!(
                "Latency is observed per operation, including response checks. Throughput includes Instant/recording overhead; sample buffer allocation, sorting, and printing are outside samples."
            );
            println!(
                "Operations run serially. New-session measurements include connect/request/close and worker join; device creation is excluded."
            );
            let device = Device::new();
            assert_eq!(device.discover(), Some(DEVICE_ID));
            let mut session = device.connect(Fault::None)?;
            benchmark("reused-session", 5_000, || exchange(&mut session))?;
            session.close()?;
            benchmark("new-session", 1_000, || {
                let mut session = device.connect(Fault::None)?;
                exchange(&mut session)?;
                session.close()
            })?;
        }
        Mode::Soak(duration) => soak(duration)?,
        Mode::Scale => scaled_benchmark()?,
        Mode::Help => unreachable!(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn accepts_default_help_and_bounded_soak() {
        assert_eq!(parse_args(&[]), Ok(Mode::Benchmark));
        assert_eq!(parse_args(&args(&["--help"])), Ok(Mode::Help));
        for seconds in [1, 3_600] {
            assert_eq!(
                parse_args(&args(&["--soak", &seconds.to_string()])),
                Ok(Mode::Soak(Duration::from_secs(seconds)))
            );
        }
    }

    #[test]
    fn rejects_unbounded_invalid_and_extra_arguments() {
        for values in [
            vec!["--soak"],
            vec!["--soak", "0"],
            vec!["--soak", "3601"],
            vec!["--soak", "-1"],
            vec!["--soak", "1.5"],
            vec!["--soak", "18446744073709551616"],
            vec!["--soak", "1", "extra"],
            vec!["--help", "extra"],
            vec!["--unknown"],
        ] {
            assert!(parse_args(&args(&values)).is_err(), "{values:?}");
        }
    }

    #[test]
    fn uses_nearest_rank_percentiles_of_sorted_observations() {
        let observations: Vec<_> = (1..=20).map(Duration::from_micros).collect();
        assert_eq!(percentile(&observations, 50), Duration::from_micros(10));
        assert_eq!(percentile(&observations, 95), Duration::from_micros(19));
        assert_eq!(percentile(&observations, 100), Duration::from_micros(20));
        assert_eq!(percentile(&observations[..1], 95), observations[0]);
    }

    #[test]
    fn soak_checks_recovery_and_joins_every_session_worker() {
        let mut counts = Counts::default();
        soak_cycle(&mut counts).unwrap();
        assert_eq!(
            counts,
            Counts {
                cycles: 1,
                valid_replies: 5,
                invalid_requests: 1,
                disconnects: 4,
                timeouts: 1,
                unavailable: 1,
                restarts: 1,
                closed_sessions: 7,
            }
        );
        assert_eq!(counts.expected_errors(), 7);
    }
}
