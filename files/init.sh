#!/bin/bash
# Runs once, on first start of an empty Postgres volume.
# Needs these env vars on the postgres service:
#   AUTH_DB_PASS, URLS_DB_PASS, REDIRECT_DB_PASS, ANALYTICS_DB_PASS
set -e

psql -v ON_ERROR_STOP=1 --username postgres <<EOSQL
CREATE ROLE auth_user      LOGIN PASSWORD '${AUTH_DB_PASS}';
CREATE ROLE urls_user      LOGIN PASSWORD '${URLS_DB_PASS}';
CREATE ROLE redirect_ro    LOGIN PASSWORD '${REDIRECT_DB_PASS}';
CREATE ROLE analytics_user LOGIN PASSWORD '${ANALYTICS_DB_PASS}';

CREATE DATABASE auth_db      OWNER auth_user;
CREATE DATABASE urls_db      OWNER urls_user;
CREATE DATABASE analytics_db OWNER analytics_user;

-- nobody gets in by default
REVOKE ALL ON DATABASE auth_db, urls_db, analytics_db FROM PUBLIC;
GRANT CONNECT ON DATABASE urls_db TO redirect_ro;
EOSQL

# ---- auth_db ----
psql -v ON_ERROR_STOP=1 --username postgres --dbname auth_db <<EOSQL
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users OWNER TO auth_user;
EOSQL

# ---- urls_db ----
psql -v ON_ERROR_STOP=1 --username postgres --dbname urls_db <<EOSQL
CREATE TABLE urls (
  id         BIGSERIAL PRIMARY KEY,
  code       VARCHAR(10) UNIQUE NOT NULL,
  long_url   TEXT NOT NULL,
  user_id    UUID NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX urls_user_created ON urls (user_id, created_at DESC);
ALTER TABLE urls OWNER TO urls_user;

-- redirect service: read-only, only this table
GRANT USAGE  ON SCHEMA public TO redirect_ro;
GRANT SELECT ON urls TO redirect_ro;
EOSQL

# ---- analytics_db ----
psql -v ON_ERROR_STOP=1 --username postgres --dbname analytics_db <<EOSQL
CREATE TABLE clicks (
  id         BIGSERIAL PRIMARY KEY,
  code       VARCHAR(10) NOT NULL,
  clicked_at TIMESTAMPTZ NOT NULL,
  referrer   TEXT,
  user_agent TEXT,
  ip_hash    TEXT
);
CREATE INDEX clicks_code_time ON clicks (code, clicked_at DESC);
ALTER TABLE clicks OWNER TO analytics_user;
EOSQL
