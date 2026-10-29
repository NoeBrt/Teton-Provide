use sensor_provisioning::simulation::batch::run_batch;

#[test]
fn each_queued_device_finishes_once_with_bounded_concurrency() {
    let batch = run_batch(17, 4).unwrap();
    let mut devices: Vec<_> = batch.jobs.iter().map(|job| job.device_index).collect();
    devices.sort_unstable();
    assert_eq!(devices, (0..17).collect::<Vec<_>>());
    assert!((1..=4).contains(&batch.peak_concurrency));
    for job in batch.jobs {
        assert!(job.service_time <= job.completion_time);
        assert!(job.completion_time <= batch.elapsed);
    }
}

#[test]
fn invalid_batch_sizes_and_unbounded_concurrency_are_rejected() {
    for (devices, concurrency) in [(0, 1), (1, 0), (1, 33), (10_001, 1)] {
        assert!(run_batch(devices, concurrency).is_err());
    }
}

#[test]
fn a_200_device_batch_completes_without_duplicate_or_missing_jobs() {
    let batch = run_batch(200, 4).unwrap();
    let mut devices: Vec<_> = batch.jobs.iter().map(|job| job.device_index).collect();
    devices.sort_unstable();
    assert_eq!(devices, (0..200).collect::<Vec<_>>());
    assert!((1..=4).contains(&batch.peak_concurrency));
}

#[test]
fn concurrency_is_limited_by_the_number_of_queued_devices() {
    let batch = run_batch(1, 8).unwrap();
    assert_eq!(batch.jobs.len(), 1);
    assert_eq!(batch.jobs[0].device_index, 0);
    assert_eq!(batch.peak_concurrency, 1);
}
