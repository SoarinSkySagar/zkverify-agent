# Proof Gatekeeper agent

An HTTPS agent for the zkVerify Agent Games **Proof Gatekeeper** event. For each signed
transfer task it:

1. checks the `x-agent-games-signature` HMAC over the raw body,
2. decides APPROVE or REJECT with deterministic code (no model involved),
3. proves the decision with the event's Groth16 circuit and verifies the proof locally,
4. returns `{ decision, reason_code, proof_tx, proof, public_signals }`, signed.

Any error, timeout or uncertainty ends in **REJECT** (fail closed).

## Layout

```
src/
  server.ts     HTTP server: raw body, routing, response signing, /healthz
  handler.ts    auth → parse → idempotency → timing → decide → prove → respond
  decision.ts   pure decision rule (mirrors the circuit) + reason-code mapping
  encoding.ts   task → circuit inputs; public-signal layout; 32-bit range guard
  envelope.ts   strict envelope parsing (preflight + gatekeeper task)
  prover.ts     snarkjs prove + local verify; pinned artifact hashes
  kurier.ts     zkVerify submission via Kurier (optional, background)
  store.ts      durable seen-set, response cache, evidence log (JSONL, fsync'd)
  hmac.ts       HMAC-SHA256 hex sign/verify (constant-time)
  config.ts     env loading/validation
scripts/
  replay.ts     local harness: replays signed sample envelopes at a running agent
  register-vk.ts  one-time Kurier testnet VK registration
fixtures/       one sample per trap type + boundary cases
test/           unit, circuit-equivalence and end-to-end tests
circuits/       gatekeeper.wasm, gatekeeper_final.zkey (from /build, sha256-pinned)
```

## Run locally

```bash
cp .env.example .env          # fill in AGENT_GAMES_HMAC_SECRET yourself; never share it
npm install
npm test                      # 19 tests, including against the real circuit
npm run dev                   # terminal 1
npm run replay                # terminal 2: all checks should PASS
```

## Deploy

**Free always-on VM (Oracle Always Free / GCP e2-micro) with Caddy and DuckDNS: see
[`deploy/README.md`](deploy/README.md).** It covers Docker Compose (agent, Caddy and the
DuckDNS updater) or systemd.

Whatever the host, the agent needs a **public HTTPS URL on the default port that is always
on.** Avoid free tiers that sleep, because a missed task costs −2. It also needs a
**persistent disk** for `DATA_DIR` (`/app/data` in the image), so the proof-reuse seen-set
survives restarts.

Then:
1. Register the **full** URL, e.g. `https://your-host.example.com/agent` (not the bare domain).
2. Dashboard → **Rotate Secret** → set `AGENT_GAMES_HMAC_SECRET` on the host → restart.
3. Run **preflight** from the dashboard. If it fails with a signature error, try
   `AGENT_GAMES_HMAC_KEY_ENCODING=hex`.
4. Run practice tasks and compare the dashboard's request/response view with
   `DATA_DIR/evidence.jsonl` (see "Confirm in practice" below).

## Optional: zkVerify via Kurier

Proofs are always generated and verified locally, and the platform re-verifies them
itself. Setting `KURIER_MODE=background` also submits each proof to zkVerify **after**
responding, so it never risks the 60 s deadline. The Finalized tx is written to
`evidence.jsonl` for disputes. Use testnet first: `npm run register-vk`, then set
`KURIER_VK_HASH`.

## Confirm in practice mode (the site doesn't specify these)

- **Reason codes:** two vocabularies exist (`REASON_CODES=trap|canonical`). The default is `trap`.
- **HMAC key encoding:** the secret string is used as-is (`utf8`) by default.
- **task_id → field encoding** for the circuit's `taskId` input (`src/encoding.ts`).
- **Whether the scorer expects `proof_tx` to echo the task's reference** (the current behaviour, matching the site's examples).
