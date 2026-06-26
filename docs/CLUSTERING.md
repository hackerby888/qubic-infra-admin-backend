# Running the backend as a multi-instance cluster

This backend can run as **N identical instances** behind a Cloudflare Load
Balancer, backed by a self-hosted **MongoDB replica set**.

- **Writes / automation are single-leader.** Exactly one instance holds a Mongo
  TTL lease (`leader_election`) and runs node polling + all SSH automation
  (F8 snapshot, F12 promote/demote, ttyd watchdog, deploy/command watchdogs).
  Automation never double-fires.
- **Reads are active-active.** Every instance serves HTTP + Socket.IO. Non-leaders
  read the realtime node status the leader publishes to Mongo (`realtime_status`),
  so Cloudflare can balance reads and fail over instantly.
- **User-initiated SSH** (deploy/command/setup/shutdown) can hit any instance and
  is serialized per host by a distributed Mongo lock (`ssh_locks`).
- `NO_DB=true` collapses to a single always-leader instance — unchanged behavior.

No new **required** env var: only `MONGO_URI` changes to the replica-set string.

---

## 1. MongoDB replica set (3 members)

On three hosts `h1,h2,h3` (private network), MongoDB ≥ 6 (tested with 8.0):

1. **Keyfile (internal member auth)** — same file on all three:
   ```bash
   openssl rand -base64 756 | sudo tee /etc/mongo/keyfile >/dev/null
   sudo chmod 400 /etc/mongo/keyfile
   sudo chown mongodb:mongodb /etc/mongo/keyfile
   ```
2. **`/etc/mongod.conf`** on each member:
   ```yaml
   net:        { port: 27017, bindIp: 127.0.0.1,<private-ip> }
   replication: { replSetName: rs0 }
   security:   { keyFile: /etc/mongo/keyfile }   # implies authorization: enabled
   ```
3. **Firewall**: allow 27017 only between the three private IPs and the app
   instances; block public.
4. **Initiate** (run once, on h1):
   ```js
   rs.initiate({ _id: "rs0", members: [
     { _id: 0, host: "h1:27017" },
     { _id: 1, host: "h2:27017" },
     { _id: 2, host: "h3:27017" },
   ]})
   ```
   Use hostnames/IPs reachable by **both** the members and the app instances.
5. **Users** (via the localhost exception, before auth fully locks down):
   ```js
   admin = db.getSiblingDB("admin")
   admin.createUser({ user:"root", pwd:"<strong>", roles:["root"] })
   admin.createUser({ user:"liteapp", pwd:"<strong>",
     roles:[
       { role:"readWrite", db:"qubic_nodes" },
       { role:"clusterMonitor", db:"admin" },   // lets /system-health read replSetGetStatus
     ]})
   // readWrite on the app DB also grants change-stream access, which the
   // Socket.IO Mongo adapter needs. clusterMonitor is read-only cluster status;
   // omit it and the System Health page's replica panel just shows "not authorized".
   ```
6. **Connection string** — each app instance's `MONGO_URI`:
   ```
   mongodb://liteapp:<pwd>@h1:27017,h2:27017,h3:27017/qubic_nodes?replicaSet=rs0&authSource=admin&retryWrites=true&w=majority
   ```
7. Verify `rs.status()` shows 1 PRIMARY + 2 SECONDARY. The Socket.IO adapter and
   the snapshot mechanism **require** a replica set (change streams) — they will
   not work on a standalone mongod.

> Production hardening: prefer x.509 member/client certs over the keyfile.

---

## 2. Cloudflare Load Balancer

- **Origin pool** = the app instances (host:443 each, or origins behind CF).
- **Health monitor**: `GET /health`, expect `200`, interval 15–30 s, timeout 5 s,
  ~2 retries. Drives read failover (a dead/Mongo-down instance returns `503` and
  is pulled). `/health` is **never leader-gated** — all healthy instances stay in
  the pool.
- **Session affinity**: enable **cookie-based** affinity. Socket.IO's long-poll
  handshake/upgrade must land on one origin; the Mongo adapter handles
  cross-instance broadcast regardless. (Alternative: force the client to
  `transports: ['websocket']` and skip affinity.)
- **TLS**: run the app on 443 (its built-in HTTPS), or terminate at Cloudflare and
  proxy CF→origin over HTTPS.

---

## 3. Process manager

- **Recommended**: one app process per VM under **systemd** (or one container per
  VM), **≥ 2 VMs** behind the LB. Each process gets a distinct `instanceId` and
  participates in leader election via Mongo.
  ```ini
  [Service]
  EnvironmentFile=/etc/lite-node/env
  ExecStart=/usr/bin/node /opt/lite-node/dist/index.js
  Restart=always
  KillSignal=SIGTERM     # handleShutdown() releases leadership (fast failover)
  ```
- **PM2 cluster** is now viable (the adapter removes the in-process-broadcast
  assumption), but all workers on one VM share fate — HA still needs ≥ 2 VMs.

---

## 4. Environment variables

| Var | Change |
|-----|--------|
| `MONGO_URI` | → the replica-set string (section 1.6) — **only required change** |
| `LEADER_LEASE_MS` | optional, default `15000` |
| `LEADER_RENEW_MS` | optional, default `5000` |
| `SNAPSHOT_SYSTEM_INTERVAL_MS` | optional, default `1000` |
| `SNAPSHOT_CHECKIN_INTERVAL_MS` | optional, default `5000` |
| `SERVER_DATA_REFRESH_MS` | optional, default `15000` |
| `NO_DB` | `true` → single-instance escape hatch (no RS, no adapter) |

---

## 5. Rollout order (each step is single-instance-safe — ship independently)

1. Stand up the RS; switch `MONGO_URI`. Run the **existing single** instance
   against it. (Infra only — connection options + connect-retry; no behavior change.)
2. Deploy the clustering build. One instance is always leader → identical behavior.
3. Scale out: bring up instance #2, add it to the CF pool (affinity on). Verify:
   - exactly one instance logs `is now LEADER`;
   - `GET /health` on each returns `200` with one `leader:true`;
   - `/random-peers` and realtime stats match across instances;
   - a promote/demote reaches a client connected to a **non-leader** (proves the
     adapter). Then add #3.

## 6. Rollback

- Remove extra origins from the CF pool → the remaining instance is leader. No
  data migration.
- Redeploy the prior build; RS + a single instance still works.
- All coordination docs (`leader_election`, `ssh_locks`, `checkin_rate_limit`,
  `realtime_status`, `socket_io_adapter_events`) are self-expiring (TTL) — stale
  docs from a rolled-back version self-clean.
- Ultimate fallback: `NO_DB=true`, single instance.

## 7. Failover characteristics

- **Read failover**: CF health interval × retries (~30–90 s) — other instances
  keep serving immediately.
- **Automation failover**: leader lease + renew (~15–20 s). During the gap polling
  pauses and the realtime snapshot freezes; `isNodeActive`'s 2-min window keeps
  `/random-peers` usable; UI ticks resume once a new leader takes over.
- A new leader starts with empty in-memory alert/promotion cooldowns, so right
  after a failover one duplicate "main lagging" email is possible; promotion
  re-evaluation is self-correcting (cooldown + F12 verify + the distributed SSH
  lock).

## New MongoDB collections

| Collection | Purpose | TTL |
|-----------|---------|-----|
| `leader_election` | single-doc leader lease | `expiresAt` |
| `ssh_locks` | distributed per-host SSH lock | `expiresAt` |
| `checkin_rate_limit` | cross-instance checkin window | `expiresAt` |
| `realtime_status` | leader-published node status snapshot | — |
| `socket_io_adapter_events` | Socket.IO adapter event log | `createdAt` (1 h) |
| `cluster_members` | per-instance heartbeat (System Health) | `lastSeen` (30 s) |

---

## Containerized deploy (Docker Swarm)

The fleet runs as a Swarm **service** (`backend`), N replicas (one per VM).
Updates are **rolling, zero-downtime**, and triggered two ways — both run the
**same** `deploy.yml` workflow, so there's one rollout mechanism:

1. **Web UI** — System Health → **Deploy latest build** (admin). The backend calls
   the GitHub API (`workflow_dispatch`).
2. **GitHub (fallback — when the backend is unreachable)** — Actions → **deploy** →
   *Run workflow*, or `gh workflow run deploy.yml -f image_tag=latest`.

### Files (backend repo)
- `Dockerfile` — multi-stage (tsc build → slim runtime).
- `stack.yml` — the Swarm service (3 replicas, 1/node, `start-first` rolling, `/health` healthcheck).
- `.github/workflows/build-and-push.yml` — push to main → build image → GHCR.
- `.github/workflows/deploy.yml` — `workflow_dispatch` → SSH the manager → `docker service update`.

### One-time bring-up
```bash
# firewall BETWEEN the VM private IPs ONLY: 2377/tcp, 7946/tcp+udp, 4789/udp
docker swarm init --advertise-addr <VM1_PRIVATE_IP>            # VM1 (manager)
docker swarm join --token SWMTKN-... <VM1_PRIVATE_IP>:2377     # VM2, VM3
echo $GHCR_PAT | docker login ghcr.io -u <user> --password-stdin
set -a; . ./prod.env; set +a                                  # load secrets for ${...}
docker stack deploy -c stack.yml --with-registry-auth backend # service name → backend_backend
```

### Required GitHub repo secrets (used by deploy.yml)
- `SWARM_MANAGER_HOST`, `SWARM_MANAGER_USER`, `SWARM_MANAGER_SSH_KEY` (+ optional `SWARM_MANAGER_SSH_PORT`).

### Required backend env (for the web-UI Deploy button)
- `DEPLOY_REPO` = `hackerby888/qubic-infra-admin-backend`
- `DEPLOY_GITHUB_TOKEN` = a PAT with **actions:write** on that repo
- optional: `DEPLOY_WORKFLOW` (default `deploy.yml`), `DEPLOY_REF` (default `main`)
- Unset → the Deploy button reports "not configured"; the GitHub manual trigger still works.

### Rollback
`docker service rollback backend_backend`, or rely on the workflow's
`--update-failure-action rollback` (auto-reverts a failed roll), or redeploy a
known-good `image_tag` from the UI / GitHub.
