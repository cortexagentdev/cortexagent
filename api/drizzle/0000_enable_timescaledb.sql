-- TimescaleDB, enabled before anything else so the hypertables that later tasks
-- add have somewhere to live: price_history (BE-6), signals (BE-10),
-- lens_metrics (BE-19), alert_fires (BE-24), nav_history and flows (BE-26).
-- See src/db/schema.ts for the create_hypertable pattern those migrations follow.
-- The extension ships with the timescale/timescaledb image, which also sets
-- shared_preload_libraries. On a stock postgres image this fails, and that
-- failure is the intended signal that the wrong image is running.
CREATE EXTENSION IF NOT EXISTS timescaledb;
