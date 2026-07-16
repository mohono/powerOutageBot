# AGENTS.md

## What this is

NestJS TypeScript Telegram bot (Telegraf) for Iranian power outage notifications (Kermanshah region). Fetches outage schedules from an external API proxy.

## Commands

- `npm run lint` — ESLint flat config with typescript-eslint + Prettier (auto-fixes)
- `npm run build` — `nest build` → `dist/`
- `npm run test` — Jest unit tests (`src/**/*.spec.ts`)
- `npm run test:e2e` — E2e tests (`test/`) — requires valid `TELEGRAM_BOT_TOKEN` in `.env` because e2e bootstraps the full `AppModule`
- `npm run start:dev` — watch mode via `nest start --watch`

## Key gotchas

- **`.env` is required**: `TELEGRAM_BOT_TOKEN` must be set or the bot crashes on startup.
- **`bills.json` is runtime data**: `StorageService` reads/writes it at `process.cwd()/bills.json`. Do not hardcode values or commit user data changes.
- **External API dependency**: outage data is fetched from `API_BASE_URL` (default `http://185.226.118.253/home/popfeeder`) — configurable via `.env`. The upstream API (`85.185.251.108:8007`) is inside Iran; `API_BASE_URL` should point to a proxy that forwards to it.
- **Feedback feature** (`✉️ ارسال نظر`): `BOT_OWNER_ID` must be set in `.env` (numeric Telegram user ID) or the button is hidden.
- **Bill ID validation**: Must be exactly 13 digits. Persian/Arabic digits (`۱۲۳...`) are auto-converted to Latin before validation.
- **E2e tests import `AppModule`**: they will attempt to launch the Telegram bot. Ensure `.env` is valid or mock the bot for tests.
- **TypeScript is intentionally loose**: `strictNullChecks: false`, `noImplicitAny: false` in `tsconfig.json`.
- **Module resolution**: uses `module: "nodenext"` / `moduleResolution: "nodenext"` — respect `.js` extensions in imports.

## Style

- Prettier: `singleQuote: true`, `trailingComma: "all"`
- ESLint: flat config in `eslint.config.mjs`, ignores its own file
- Many `@typescript-eslint/no-*` rules are disabled at the top of `telegram.service.ts` with eslint-disable comments — do not re-enable without understanding why they were suppressed
