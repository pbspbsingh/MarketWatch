use chrono::{NaiveDate, NaiveTime, Timelike};
use std::collections::{BTreeMap, HashMap, HashSet};
use thiserror::Error;

const BUCKET_SECONDS: f64 = 5.0 * 60.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct IntradayVolumeSample {
    pub market_date: NaiveDate,
    pub market_time: NaiveTime,
    pub volume: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct VolumeProfile {
    cumulative_by_time: BTreeMap<NaiveTime, f64>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub(crate) enum VolumeProfileError {
    #[error("volume profile requires at least one source date")]
    NoSourceDates,
    #[error("volume profile source dates must be unique")]
    DuplicateSourceDate,
    #[error("volume profile contains a non-five-minute-aligned sample")]
    MisalignedSample,
    #[error("volume profile contains a duplicate date/time sample")]
    DuplicateSample,
    #[error("volume profile has no samples on its source dates")]
    NoSamples,
}

pub(crate) fn build_volume_profile(
    samples: &[IntradayVolumeSample],
    source_dates: &[NaiveDate],
) -> Result<VolumeProfile, VolumeProfileError> {
    if source_dates.is_empty() {
        return Err(VolumeProfileError::NoSourceDates);
    }
    let source_set = source_dates.iter().copied().collect::<HashSet<_>>();
    if source_set.len() != source_dates.len() {
        return Err(VolumeProfileError::DuplicateSourceDate);
    }

    let mut volume_by_date = HashMap::<NaiveDate, BTreeMap<NaiveTime, u128>>::new();
    let mut bucket_times = HashSet::new();
    for sample in samples {
        if !source_set.contains(&sample.market_date) {
            continue;
        }
        if sample.market_time.minute() % 5 != 0
            || sample.market_time.second() != 0
            || sample.market_time.nanosecond() != 0
        {
            return Err(VolumeProfileError::MisalignedSample);
        }
        bucket_times.insert(sample.market_time);
        let bucket = volume_by_date
            .entry(sample.market_date)
            .or_default()
            .entry(sample.market_time);
        if matches!(bucket, std::collections::btree_map::Entry::Occupied(_)) {
            return Err(VolumeProfileError::DuplicateSample);
        }
        bucket.or_insert(u128::from(sample.volume));
    }
    if bucket_times.is_empty() {
        return Err(VolumeProfileError::NoSamples);
    }

    let mut bucket_times = bucket_times.into_iter().collect::<Vec<_>>();
    bucket_times.sort_unstable();
    let mut cumulative_totals = vec![0_u128; bucket_times.len()];
    for date in source_dates {
        let buckets = volume_by_date.get(date);
        let mut cumulative = 0_u128;
        for (index, time) in bucket_times.iter().enumerate() {
            cumulative += buckets
                .and_then(|values| values.get(time))
                .copied()
                .unwrap_or(0);
            cumulative_totals[index] += cumulative;
        }
    }

    let divisor = source_dates.len() as f64;
    let cumulative_by_time = bucket_times
        .into_iter()
        .zip(cumulative_totals)
        .map(|(time, total)| (time, total as f64 / divisor))
        .collect();
    Ok(VolumeProfile { cumulative_by_time })
}

impl VolumeProfile {
    pub(crate) fn run_rate(&self, actual: u64, time: NaiveTime) -> Option<f64> {
        let expected = self.expected_at(time)?;
        (expected > 0.0).then_some(actual as f64 / expected)
    }

    fn expected_at(&self, time: NaiveTime) -> Option<f64> {
        let bucket_minute = time.minute() - time.minute() % 5;
        let bucket = NaiveTime::from_hms_opt(time.hour(), bucket_minute, 0)?;
        let previous = self
            .cumulative_by_time
            .range(..bucket)
            .next_back()
            .map_or(0.0, |(_, value)| *value);
        let Some(current) = self.cumulative_by_time.get(&bucket).copied() else {
            return self
                .cumulative_by_time
                .range(..=bucket)
                .next_back()
                .map(|(_, value)| *value);
        };
        let elapsed = f64::from(time.minute() % 5 * 60 + time.second())
            + f64::from(time.nanosecond()) / 1_000_000_000.0;
        Some(previous + (current - previous) * (elapsed / BUCKET_SECONDS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(hour: u32, minute: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(hour, minute, 0).unwrap()
    }

    #[test]
    fn averages_cumulative_volume_and_treats_missing_buckets_as_zero() {
        let first = NaiveDate::from_ymd_opt(2026, 7, 16).unwrap();
        let second = NaiveDate::from_ymd_opt(2026, 7, 17).unwrap();
        let samples = [
            IntradayVolumeSample {
                market_date: first,
                market_time: time(6, 30),
                volume: 100,
            },
            IntradayVolumeSample {
                market_date: first,
                market_time: time(6, 35),
                volume: 200,
            },
            IntradayVolumeSample {
                market_date: second,
                market_time: time(6, 30),
                volume: 300,
            },
        ];
        let profile = build_volume_profile(&samples, &[first, second]).unwrap();

        assert_eq!(profile.expected_at(time(6, 35)), Some(200.0));
        assert_eq!(profile.expected_at(time(6, 40)), Some(300.0));
    }

    #[test]
    fn prorates_the_active_bucket() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 17).unwrap();
        let profile = build_volume_profile(
            &[
                IntradayVolumeSample {
                    market_date: date,
                    market_time: time(6, 30),
                    volume: 100,
                },
                IntradayVolumeSample {
                    market_date: date,
                    market_time: time(6, 35),
                    volume: 200,
                },
            ],
            &[date],
        )
        .unwrap();

        assert_eq!(profile.expected_at(time(6, 35)), Some(100.0));
        assert_eq!(profile.expected_at(time(6, 37)), Some(180.0));
        assert_eq!(profile.run_rate(360, time(6, 37)), Some(2.0));
    }

    #[test]
    fn rejects_duplicate_date_time_samples() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 17).unwrap();
        let sample = IntradayVolumeSample {
            market_date: date,
            market_time: time(6, 30),
            volume: 100,
        };

        assert_eq!(
            build_volume_profile(&[sample, sample], &[date]),
            Err(VolumeProfileError::DuplicateSample),
        );
    }
}
