# OKG Roblox Bridge

Backend starter for **OKG Roblox** and the **OKG Roblox Services** Discord bot.

## Included
- `GET /health` health check
- Secret-protected `POST /api/roblox/heartbeat` for Roblox server presence snapshots
- Secret-protected `GET /api/players/:userId` lookup
- Discord `/locate user:<username-or-user-id>` command

## Run locally
1. Copy `.env.example` to `.env`.
2. Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and a random `BRIDGE_API_SECRET` of at least 32 characters.
3. Optionally set `DISCORD_GUILD_ID` to register `/locate` in a test server immediately.
4. Run `npm install`, then `npm start`.

## Deploy
Create a separate Node.js 24 service on Blitz from this repository. Start command: `npm start`. Add the environment variables in the service settings.

## Important
The Roblox game has not been created yet, so the Roblox server-side heartbeat script still needs to be added when the experience exists. Presence is currently held in memory and is cleared on restart; persistent storage is required before relying on history or total playtime. Moderation actions, remote admin commands, and the dashboard are not implemented yet. Never expose `BRIDGE_API_SECRET` in a LocalScript or commit real credentials.
