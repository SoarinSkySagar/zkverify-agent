# zkVerify Agent Games agent: Proof Gatekeeper + Steal the VFY

One HTTPS endpoint serves both events. Requests are routed by envelope: Gatekeeper tasks and
preflight carry `type`, Steal the VFY turns carry `eventId: "steal-the-vfy"`. Free ngrok
gives you only one endpoint, so both events share it. Register the same
`https://<domain>/agent` URL for both.

## Proof Gatekeeper

For each signed transfer task the agent:

1. checks the `x-agent-games-signature` HMAC over the raw body,
2. decides APPROVE or REJECT with deterministic code (no model involved),
3. proves the decision with the event's Groth16 circuit and verifies the proof locally,
4. returns `{ decision, reason_code, proof_tx, proof, public_signals }`, signed.

Any error, timeout or uncertainty ends in **REJECT** (fail closed).

## Steal the VFY

For each signed turn the agent:

1. checks the signature (and returns the cached response for a retried turn),
2. refuses expired turns and nonces already used on another turn (HTTP 400),
3. checks that the platform's frozen `strategyCommitment.hash` equals the commitment of
   *your* `STRATEGY_PARAMS` + `STRATEGY_SALT`,
4. runs `policy()` (`src/stv/strategy.ts`), which mirrors the vfy-policy circuit exactly,
5. proves the action with the circuit, verifies it locally, computes `publicInputsHash`
   (keccak, /build field order), and returns the signed turn response.

Any failure inside the turn window answers **HOLD with no proof** (fail closed).

**Your strategy is yours.** The code holds no strategy values. Read the TODO block in
`src/stv/strategy.ts`, which explains what the four parameters do in the circuit. Put your
values in `.env` only:

```bash
# in .env: STRATEGY_PARAMS={"extractAmount":…,"fortifyIfSelfBelow":…,"holdIfOpponentAtOrBelow":…,"holdByDefault":…}
npm run stv:new-salt        # writes a random STRATEGY_SALT into .env (not printed)
npm run stv:commitment      # prints the hash to register (never the params or salt)
```

Register the hash at Dashboard → My Agents → Edit agent → Steal the VFY **before Swiss
Round 1**. It is frozen once a match is paired, and you can change it only between rounds.
Then rebuild and restart the agent, and check with `npm run replay:stv`. That command prints
only branch names, PASS/FAIL and timings, never your values.

## Layout

```
src/
  server.ts     HTTP server: raw body, response signing, /healthz
  handler.ts    auth → route (STV turns → stv/) → Gatekeeper: idempotency → timing → decide → prove → respond
  stv/
    strategy.ts       TODO block for YOUR params (env only) + pure policy() mirroring the circuit
    handler.ts        turn flow: idempotency, expiry/nonce, commitment check, prove, respond
    circuit.ts        vfy-policy inputs, public-signal layout, 16-bit range guard, pinned hashes
    commitment.ts     Poseidon(params[0..7], salt), salt parsing/generation
    publicInputsHash.ts  keccak256 per /build §06
    envelope.ts       strict turn-envelope parsing
  decision.ts   pure decision rule (mirrors the circuit) + reason-code mapping
  encoding.ts   task → circuit inputs; public-signal layout; 32-bit range guard
  envelope.ts   strict envelope parsing (preflight + gatekeeper task)
  prover.ts     snarkjs prove + local verify; pinned artifact hashes
  kurier.ts     zkVerify submission via Kurier (optional, background)
  store.ts      durable seen-set, response cache, evidence log (JSONL, fsync'd)
  hmac.ts       HMAC-SHA256 hex sign/verify (constant-time)
  config.ts     env loading/validation
scripts/
  replay.ts       Gatekeeper harness: replays signed sample tasks at a running agent
  replay-stv.ts   Steal the VFY harness: one turn per reachable branch + retry/nonce/expiry/commitment checks
  stv-commitment.ts / stv-new-salt.ts   commitment printing / salt generation (never print secrets)
  register-vk.ts  one-time Kurier testnet VK registration (--circuit stv for vfy-policy)
fixtures/       one sample per trap type + boundary cases
test/           unit, circuit-equivalence and end-to-end tests
circuits/       gatekeeper.wasm, gatekeeper_final.zkey (from /build, sha256-pinned)
```

## Run locally

```bash
cp .env.example .env          # fill in AGENT_GAMES_HMAC_SECRET yourself; never share it
npm install
npm test                      # 34 tests, including policy-vs-circuit checks on both circuits
npm run dev                   # terminal 1
npm run replay                # terminal 2: Gatekeeper, all checks should PASS
npm run replay:stv            # terminal 2: Steal the VFY (needs STRATEGY_PARAMS/SALT in .env)
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
- **Steal the VFY proof placement:** top-level `proof`/`public_signals` (the starter prompt)
  or inside `policyProof` (`STV_PROOF_PLACEMENT=policyProof`).
- **Steal the VFY commitment format:** the dashboard field is assumed to take the 0x-hex
  value from `npm run stv:commitment`.
- **Fail-closed HOLD without a proof** may count as a policy violation (−2) rather than a
  timeout (−1). It only happens when something is already wrong (wrong commitment, expired
  budget, malformed turn).
