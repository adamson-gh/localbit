-- (Nov 28) the share of the model in graphics memory beside each speed - run once on the live database
ALTER TABLE submissions ADD COLUMN gpu_pct INTEGER;
