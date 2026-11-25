# 06 — Credentials

Most public well databases need no login. When an adapter sets `requiresAuth: true`, the tool looks for credentials **locally** and never prompts for or stores secrets anywhere else.

## Key naming

Credentials are looked up by key: `WELLS_<STATE>_<NAME>`, where `<NAME>` comes from the adapter's `credentialKeys`.

Example for an adapter with `credentialKeys: ["USERNAME", "PASSWORD"]` in Texas:

```
WELLS_TX_USERNAME=...
WELLS_TX_PASSWORD=...
```

## Lookup order (first match wins, per key)

1. **Process environment variables** (`WELLS_TX_USERNAME` already set in the shell).
2. **`.env` file in the working directory**, loaded with `dotenv` (does not override existing env vars).
3. **User credentials file**: `~/.config/well-scraper/credentials.env` (Windows: `%APPDATA%\well-scraper\credentials.env`). Same `KEY=value` format. Lets the operator keep secrets out of the project folder.

If any required key is missing after all three, stop before launching the browser with exit 4 and a message naming the missing keys and the three places checked — never the values.

> Optional later: OS keychain lookup (macOS Keychain / Windows Credential Manager) as step 4. Not in v1, to avoid a native dependency.

## Session reuse

To avoid logging in every run (and to support MFA):

- After a successful login, save Playwright `storageState` to `~/.config/well-scraper/sessions/<state>.json`.
- On the next run, load it and call `adapter.isLoggedIn()`. If still valid, skip login; if not, delete it and log in again.
- `wells login --state XX` opens a headed browser for manual login and saves the session; use when the site has MFA or a CAPTCHA on its login page (the operator solves it, not the tool).
- Session files are created with permissions `0600` where the OS supports it.

## Handling rules

- Credential values MUST be redacted from logs, traces, screenshots of login forms, error messages, and reports. The logger is configured with redaction paths for any key containing `password`, `token`, `secret`, `key`, `credential`, and all `WELLS_*` values.
- The report lists only **which key names** were used and **which source** they came from (e.g. `WELLS_TX_USERNAME (user credentials file)`).
- `--trace` MUST be disabled during the login step (traces capture typed input), then started after login.
- `.env`, `sessions/`, and `output/` are in the project `.gitignore` from the first commit.
- A `.env.example` lists every key any adapter uses, with empty values.
