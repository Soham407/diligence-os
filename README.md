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
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=your-google-client-id
SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=your-google-client-secret
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

7. Configure Google sign-in:

- Set `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` in `.env`
- Add `http://localhost:54321/auth/v1/callback` to the Google OAuth client redirect URIs
- Add `http://localhost:3000/auth/callback` to Supabase redirect URLs

8. Test auth flow on web:

```bash
corepack pnpm --filter web dev
```

Open `http://localhost:3000` and use email magic link or Google OAuth sign-in.

## Notes

- `supabase init` has already scaffolded `supabase/config.toml`.
- `supabase link` reads `SUPABASE_PROJECT_REF` + `SUPABASE_ACCESS_TOKEN` from your environment.
