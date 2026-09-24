- Status: Accepted
- Date: 2026-09-24
- Decides spec **Open** item: "WebSocket lib". The log/trace backend (Grafana vs Datadog) stays open. It needs a deploy, and nothing here depends on it.
- Build plan: P4 (foundation F3 = spec step 3). Bible: L44 (device page), L45 (remote actions, the in-app part), L48 (alert console), L26 (health model), L37/L38 (alert engine)

# 0012: Ops layer: heartbeat, log ring, remote-action queue, alert rules, one WebSocket over LISTEN/NOTIFY

## Context

Support is one person for the first 200 stores. The spec's acceptance line for this step: *from
admin, restart the app, push a price change, reprint a receipt, and read the last 200 log lines of
a register, without touching the device.* The register must also keep selling when none of this
works (ADR 0002).

## Decisions

### 1. Heartbeat every 30 s, answered with the action queue
The register posts a strict `HeartbeatInput`:
- version, uptime, and network/power/storage;
- sync queue, rejected events, last sync time and last error;
- running catalog version, signed-in person and open ticket;
- a health slot per peripheral (printer, drawer, scanner, terminal, customer display).

The API keeps the latest in `register_status` and 7 days of history in `register_heartbeats`
(pruned daily). **The reply carries any queued remote actions**, so a register with no WebSocket
still gets them within 30 s. Health: *online* ≤ 90 s, *quiet* ≤ 5 min, then *offline*, which opens
the Bible's "register offline > 5 min" alert.

### 2. Remote actions are a queue, not RPC
`remote_actions`: `queued → delivered → succeeded | failed | unsupported | expired (1 day)`.
- Requests are audited.
- A register runs each action id once, however it arrives.
- It reports back **before** acting when the action ends the process (restart).
- Actions that need the Android device module or MDM (re-pair terminal, roll back build, reboot)
  are listed but disabled in admin. A browser register answers them `unsupported`, never a
  pretend success.

### 3. One WebSocket endpoint, fed by Postgres LISTEN/NOTIFY
- Library: **`@fastify/websocket` (ws)**. It is Fastify's own plugin, needs no extra protocol layer,
  and is testable in process with `injectWS`. Socket.IO was rejected: its fallbacks and rooms
  aren't needed, and it adds a second protocol to every client.
- **Auth is the first message** (`{type:'auth', token}`), never a URL parameter, because URLs are
  logged. A merchant user's role and permissions come from the membership (ADR 0011). Sale
  figures go only to people with `reports.view`.
- **Changes arrive by NOTIFY, sent on commit**:
  - a trigger on `merchants.catalog_version` (the catalog nudge);
  - a trigger on `remote_actions` inserts (action push);
  - ingest (completed sales, for the live ticker);
  - heartbeats (register status);
  - the rule engine (new alerts).

  Any API instance can serve any socket, and a rolled-back transaction never announces anything.
- The socket is **only a fast path**. Every message has a polling twin (heartbeat reply, catalog
  version check), so a store network that kills WebSockets degrades to 30 s, not to broken.

### 4. Log ring on the device, uploaded on request
The last 10,000 lines live in the register's SQLite (`logs`, trimmed every 200 writes). Lines are
short structured messages about sync transitions, errors, remote actions, sign-ins (names only)
and completed sales (id, total). **Never PINs, never card data.** "Fetch logs" is a remote action.
The device page shows the last 200 lines of the latest upload.

### 5. Alert rules: reconcile every minute
A BullMQ job runs `evaluateAlerts` every minute. Each rule returns the things in trouble *now*.
An alert opens once per dedupe key (a partial unique index), bumps `last_seen_at` while the
condition holds, and **resolves itself** when it clears. v1 rules:
- register offline;
- stuck sync queue;
- rejected events;
- hardware error or offline;
- PIN lockout;
- voids above 10% of today's tickets (at least 20 tickets).

Merchant-facing rules show in the merchant app's Alerts tab. Delivery goes through a `Notifier`
interface. The log adapter is the only one until the push/SMS/WhatsApp accounts exist (build plan ⛔).

## Consequences

- Rules still to add as their events land: drawer opened outside a sale (P6), void/refund over $X
  (P7), EOD not closed (P16).
- A second API instance needs no sticky sessions.
- On Android, the heartbeat's power, storage and real hardware slots come from the Kotlin module (P-HW).
