-- (Nov 27) receipts for get_status - run once on the live database
ALTER TABLE submissions ADD COLUMN receipt TEXT;
ALTER TABLE reports ADD COLUMN receipt TEXT;
ALTER TABLE reports ADD COLUMN status TEXT;
CREATE INDEX IF NOT EXISTS submissions_receipt ON submissions (receipt);
CREATE INDEX IF NOT EXISTS reports_receipt ON reports (receipt);
