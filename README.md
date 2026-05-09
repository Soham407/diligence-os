# Diligence OS

Monorepo bootstrap for the Diligence OS platform.

## Workspace layout

- `web` — Next.js web app (Tailwind CSS configured)
- `mobile` — Expo / React Native mobile app scaffold
- `supabase` — Supabase project (functions + migrations)

## Requirements

- Node.js 22+
- Corepack enabled (for pnpm)
- Docker Desktop (for `supabase start` local stack)
- Supabase access token (for project link)

## Environment variables

Create a `.env` at repo root with:

```bash
SUPABASE_PROJECT_REF=your-project-ref
SUPABASE_ACCESS_TOKEN=your-personal-access-token
```

## Local development

1. Install dependencies:

```bash
corepack pnpm install
```

2. Typecheck workspace:

```bash
corepack pnpm typecheck
```

3. Start Next.js web app:

```bash
corepack pnpm --filter web dev
```

4. Start Expo mobile app:

```bash
corepack pnpm --filter mobile start
```

5. Link Supabase project (env-driven):

```bash
corepack pnpm --filter supabase link
```

6. Start Supabase local stack:

```bash
corepack pnpm --filter supabase start
```

## Notes

- `supabase init` has already scaffolded `supabase/config.toml`.
- `supabase link` reads `SUPABASE_PROJECT_REF` + `SUPABASE_ACCESS_TOKEN` from your environment.
