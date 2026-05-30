default: dev

dev:
    pnpm wrangler dev

typecheck:
    pnpm tsc --noEmit

seed:
    curl -s http://localhost:8787/dev/seed | jq

deploy:
    pnpm wrangler deploy
