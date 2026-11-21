# Local infrastructure

`docker compose up -d` (or `make up`) starts Postgres 16 with pgvector and Redis 7, bound to 127.0.0.1 only.

- `postgres/init/01-init.sql` runs once on a fresh volume: creates the `erase_api` login role and the `erase_ai` database with the `vector` extension. Credentials are local-development throwaways.
- Roles: `erase` (owner, runs migrations), `erase_app` (NOLOGIN group role created by migration 0001, holds the app privileges), `erase_api` (login role, member of `erase_app`).
- In staging and production the host creates the login role and grants it `erase_app`; no password lives in the repo.
- To start from scratch: `make db-reset` (destroys the local volume).
