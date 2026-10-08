# Troubleshooting

Common start-up and data problems. Day-to-day operation is in the [operations guide](OPERATIONS.md).

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

## Troubleshooting

### `npm run dev` exits silently (no output, no error)

This is a known issue where npm's script runner can swallow errors, particularly on Windows PowerShell. Try these in order:

**1. Run Node directly (bypasses npm):**
```bash
node --trace-warnings server.mjs
```
This is functionally identical to `npm run dev` but gives you full error output.

**2. Run the diagnostic script:**
```bash
node diag.mjs
```
This tests every import one by one, checks your Node.js version, and verifies port 3117 is available. It will tell you exactly what's failing.

**3. Check if port 3117 is already in use:**

A previous Crucix instance may still be running in the background.

```powershell
# Windows PowerShell
Get-NetTCPConnection -LocalPort 3117
Get-Process -Id <OwningProcess_from_above>
```

```bash
# macOS / Linux
lsof -i :3117
```

Identify the process before taking action. Reuse an existing Crucix instance or choose `PORT=3118`; avoid stopping unrelated applications. See [the operations guide](OPERATIONS.md).

**4. Check Node.js version:**
```bash
node --version
```
Crucix requires Node.js 22 or later. If you have an older version, download the latest LTS from [nodejs.org](https://nodejs.org/).

### Dashboard shows empty panels after first start

This is normal — the first sweep takes 30–60 seconds to query all 68 sources. The dashboard will populate automatically once the sweep completes. Check the terminal for sweep progress logs.

### Some sources show errors

Missing keys disable the corresponding source; provider failures have a separate error state. Other sources continue. Check Source Integrity or sanitized server logs for the affected source and reason. Optional keys include `FRED_API_KEY`, `FIRMS_MAP_KEY` and `EIA_API_KEY`.

OpenSky may return `HTTP 429`. Crucix surfaces the error, preserves successful current regions, and can reuse an original observation from `runs/` for at most one hour when all regions fail. Expired, missing or invalid timestamps are rejected; stale data stays visibly labelled.

### Telegram bot not responding to commands

Make sure both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `.env`. The bot only responds to messages from the configured chat ID (security measure). You should see `[Crucix] Telegram alerts enabled` and `[Crucix] Bot command polling started` in the server logs on startup. If not, double-check your token with `curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe`.

### Discord bot not responding to slash commands

Check these in order:
1. Make sure `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` are set in `.env`
2. Verify `discord.js` is installed: `npm ls discord.js`. If missing, run `npm install discord.js`
3. If slash commands don't appear, set `DISCORD_GUILD_ID` — without it, global commands can take up to 1 hour to propagate. Guild-specific commands register instantly
4. Confirm the bot was invited with `bot` + `applications.commands` scopes and has `Send Messages` + `Embed Links` permissions in the target channel
5. Check server logs for `[Discord] Bot logged in as ...` on startup. If you see `[Discord] discord.js not installed`, install it and restart
6. **Webhook-only fallback:** If you just want alerts without slash commands, set `DISCORD_WEBHOOK_URL` instead of the bot token. No `discord.js` needed.
