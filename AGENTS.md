# AGENTS.md

## What this is

NestJS TypeScript Telegram bot (Telegraf) for Iranian power outage notifications (Kermanshah region). Fetches outage schedules from an external API and from a local PDF parser stub.

## Commands

- `npm run lint` — ESLint flat config with typescript-eslint + Prettier (auto-fixes)
- `npm run build` — `nest build` → `dist/`
- `npm run test` — Jest unit tests (`src/**/*.spec.ts`)
- `npm run test:e2e` — E2e tests (`test/`) — requires valid `TELEGRAM_BOT_TOKEN` in `.env` because e2e bootstraps the full `AppModule`
- `npm run start:dev` — watch mode via `nest start --watch`

## Key gotchas

- **`.env` is required**: `TELEGRAM_BOT_TOKEN` must be set or the bot crashes on startup.
- **`bills.json` is runtime data**: `StorageService` reads/writes it at `process.cwd()/bills.json`. Do not hardcode values or commit user data changes.
- **`parsePdfStructure()` is a stub** (`src/telegram/telegram.service.ts`): the `pdfText` variable is an empty string, so `outageAreas` is always empty. The PDF schedule feature is non-functional.
- **External API dependency**: outage data is fetched from `http://85.185.251.108:8007/home/popfeeder` — may be unreachable from your network.
- **E2e tests import `AppModule`**: they will attempt to launch the Telegram bot. Ensure `.env` is valid or mock the bot for tests.
- **TypeScript is intentionally loose**: `strictNullChecks: false`, `noImplicitAny: false` in `tsconfig.json`.
- **Module resolution**: uses `module: "nodenext"` / `moduleResolution: "nodenext"` — respect `.js` extensions in imports.

## Style

- Prettier: `singleQuote: true`, `trailingComma: "all"`
- ESLint: flat config in `eslint.config.mjs`, ignores its own file
- Many `@typescript-eslint/no-*` rules are disabled at the top of `telegram.service.ts` with eslint-disable comments — do not re-enable without understanding why they were suppressed
