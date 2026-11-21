-- Runs once, when the local Postgres volume is first created. LOCAL DEVELOPMENT ONLY.
-- The API connects as erase_api (INSERT/SELECT on append-only tables; see migration 0001).
-- Migrations run as the owner role `erase` (POSTGRES_USER in docker-compose.yml).
CREATE ROLE erase_api LOGIN PASSWORD 'erase_api';

-- The AI service owns a separate database for its RAG corpus (TRD 4). It holds no user data.
CREATE DATABASE erase_ai;
\connect erase_ai
CREATE EXTENSION IF NOT EXISTS vector;
