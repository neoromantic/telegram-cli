# Authentication

> **Status: ✅ Implemented**
>
> Authentication is implemented in `src/commands/auth.ts` using `@mtcute/bun`.

## Requirements

Set the API credentials in your environment (Bun auto-loads `.env`):

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`

## Commands

### Phone Login

```bash
tg auth login --phone +79261408252
```

Flow:
1. Create or reuse an account record in `data.db`.
2. Start mtcute auth flow (phone → code → optional 2FA password).
3. Persist session to `session_<id>.db`.
4. Update account metadata (user ID, display name, active account).

### QR Login

```bash
tg auth login-qr
```

Flow:
1. Generate a login QR code in the terminal.
2. Scan with Telegram mobile app: **Settings → Devices → Link Desktop Device**.
3. Persist session and update account metadata.

### Logout

```bash
tg auth logout
```

Logs out the active account (or a specific one via `--account`) and clears the local session.

### Status

```bash
tg auth status
```

Checks whether the active account session is valid and returns:
- account info
- authentication status
- a message if re-login is required

## Storage

Authentication data lives in the data directory (default `~/.telegram-cli`, override with `TELEGRAM_CLI_DATA_DIR`):

- `data.db` — accounts table
- `session_<id>.db` — mtcute session storage per account
- `cache.db` — cache/sync database (not required for login)

## Notes

- If SMS codes are blocked for unofficial clients, use **QR login**.
- `auth login` will merge duplicate accounts if the same Telegram user is detected under another account ID.
