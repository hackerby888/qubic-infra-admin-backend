# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (ts-node, no build needed)
npm run dev

# Build TypeScript to dist/
npm run build

# Run compiled output
npm start
```

No linting or test commands are configured.

## Environment Variables

Required at startup (checked in `src/index.ts`):
- `GITHUB_LITE_NODE_USER`, `GITHUB_LITE_NODE_REPO` — GitHub repo for Lite Node releases
- `GITHUB_BOB_NODE_USER`, `GITHUB_BOB_NODE_REPO` — GitHub repo for Bob Node releases
- `GITHUB_TOKEN`
- `JWT_SECRET`
- `PORT` — use `443` to enable HTTPS (requires `HTTPS_KEY_PATH`, `HTTPS_CERT_PATH`)
- `MONGO_URI`, `MONGO_DB_NAME`
- `GMAIL_USER`, `GMAIL_APP_PASSWORD`

## Architecture

This is a Node.js/TypeScript backend (ESM modules, `"type": "module"`) that manages a fleet of **Qubic blockchain nodes** (Lite Nodes and Bob Nodes) running on remote servers via SSH.

### Startup sequence (`src/index.ts`)
1. Load `data/lastCheckinMap.json` (persisted on SIGINT)
2. Connect MongoDB
3. `MapService.start()` — IP geolocation cache
4. `GithubService.start()` — pull release tags
5. `NodeService.start()` — begin polling nodes
6. `HttpServer.start()` + `SocketServer.start()` — Express + Socket.IO

### Services (`src/services/`)

- **NodeService** — core polling loop. Maintains two in-memory status maps (`_status` for system/registered nodes, `_statusCheckin` for checkin-discovered nodes). Polls Lite Nodes at `:41841/tick-info` and Bob Nodes at `:40420/status` every 1 second. Also runs `watchMainNode()` (alerts via email if main node falls >8 ticks behind) and `watchAndSaveSnapshot()` (SSH F8 keypress every 5 min per operator cron job setting).
- **SSHService** — executes commands on remote servers via ssh2. Uses per-host execution locks. Screen sessions: `qubic` (Lite Node), `bob` (Bob Node). Handles deployment (download binary, write config, run in screen).
- **GithubService** — fetches release tags from GitHub for LiteNode and BobNode repos.
- **MapService** — async IP geolocation queue using `@iplookup/country`. Caches results in MongoDB `server_ip_info`. Also polls `api.qubic.li/public/peers` every 10 min for the BM (backbone) node list.
- **`services/logic/checkin.ts`** — queries MongoDB `checkins` collection with 15-min NodeCache. Checkins are self-reported by nodes (not SSH-polled).

### HTTP routes (`src/http/routes/`)

All routes flat-mounted at `/`. Route files: `auth`, `users`, `servers`, `deployment`, `commands`, `logs`, `nodes`, `monitoring`, `automation`, `map`, `crashreport`, `health`.

Auth uses JWT (`src/http/middleware/auth.middleware.ts`). Roles: `admin` and `operator`.

### Socket.IO (`src/http/socket-server.ts`)

Events:
- `subscribeToRealtimeStats` / `unsubscribeFromRealtimeStats` — broadcasts `realtimeStatsUpdate` every 1s from `NodeService` in-memory state. Filters by operator; unauthenticated clients only see public (non-private) nodes.
- `subscribeToServiceLogs` / `unsubscribeFromServiceLogs` — streams SSH screen output live.
- `subscribeToBobRealtimeLogs` — proxies a WebSocket connection to Bob Node's `:40420/ws/logs`.

### Database (`src/database/db.ts`)

MongoDB via `MongoDbTypes` namespace. Key collections: `servers`, `lite_nodes`, `bob_nodes`, `checkins`, `cron_jobs`, `command_logs`, `shortcut_commands`, `server_ip_info`, `crash_reports`, `users`.

The `Server` document is the primary record (SSH credentials, services array, deploy status). `LiteNode`/`BobNode` collections are lighter records used for polling.

### Key patterns
- All major components use TypeScript `namespace` (not classes) with a `start()` function.
- Private state is module-level variables inside the namespace.
- `_status` = system-registered nodes (from DB); `_statusCheckin` = self-reported checkin nodes (broader, less trusted).
- Node selection (`getRandomLiteNode`/`getRandomBobNode`) supports `"random"` and `"closest"` modes using geolib distance.
