up:         ; docker compose up -d --wait
down:       ; docker compose down
db-reset:   ; docker compose down -v && docker compose up -d --wait
db-migrate: ; pnpm --filter @erase/api db:migrate
dev:        ; pnpm dev
lint:       ; pnpm lint
typecheck:  ; pnpm typecheck
test:       ; pnpm test && cd services/ai && python -m pytest
