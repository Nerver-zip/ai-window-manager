ALTER TABLE window_samples ADD COLUMN phase_source TEXT;
ALTER TABLE window_samples ADD COLUMN phase_confidence TEXT;
ALTER TABLE window_samples ADD COLUMN phase_observed_at_ms INTEGER;

ALTER TABLE window_samples ADD COLUMN started_observed_at_ms INTEGER;
ALTER TABLE window_samples ADD COLUMN duration_observed_at_ms INTEGER;
ALTER TABLE window_samples ADD COLUMN reset_observed_at_ms INTEGER;
ALTER TABLE window_samples ADD COLUMN usage_source TEXT;
ALTER TABLE window_samples ADD COLUMN usage_confidence TEXT;
ALTER TABLE window_samples ADD COLUMN usage_observed_at_ms INTEGER;
ALTER TABLE window_samples ADD COLUMN remaining_source TEXT;
ALTER TABLE window_samples ADD COLUMN remaining_confidence TEXT;
ALTER TABLE window_samples ADD COLUMN remaining_observed_at_ms INTEGER;
