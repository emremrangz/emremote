-- What emremote learned about a device over SSH (operating system, kernel,
-- hardware), refreshed whenever system information is read.
ALTER TABLE devices ADD COLUMN facts jsonb NOT NULL DEFAULT '{}';
