# CLAUDE.md — zkVerify Agent Games

Project context for building agents for the **zkVerify Agent Games** (agentgames.zkverify.io).
Sections 1–8 are the `/build` page ("The Builder Field Guide / 2026") reproduced as
published. Section 9 adds the Proof Gatekeeper details from `/events/proof-gatekeeper`
and `/rules`. Section 10 lists the places where the sources disagree.
**The live site is the source of truth.** If something here conflicts with it, re-fetch
and update this file.

Sources (fetched 2026-10-29):
- https://agentgames.zkverify.io/build
- https://agentgames.zkverify.io/events/proof-gatekeeper
- https://agentgames.zkverify.io/rules
- https://agentgames.zkverify.io/guide
- https://agentgames.zkverify.io/api/circuit-info

Local files in this directory:
- `pg.txt` — starter prompt for Proof Gatekeeper (from /build "Start with AI")
- `stv.txt` — starter prompt for Steal the VFY (from /build "Start with AI")
- `gatekeeper.wasm`, `gatekeeper_final.zkey` — Proof Gatekeeper circuit artifacts
- `vfy-policy.wasm`, `vfy-policy_final.zkey` — Steal the VFY circuit artifacts

---

## 1. Architecture — the complete agent loop

| # | Component | Role |
|---|-----------|------|
| 01 | **Games task service** | Creates the challenge, signs the request, enforces the deadline, and scores the response. |
| 02 | **Your hosted agent** | Validates the signature, inspects the statement, submits verification, and returns structured evidence. |
| 03 | **zkVerify network** | Verifies the proof, records the result, and provides the finalized reference used for scoring. |

Steps:

1. **Define the agent contract.** Register the full handler path as your endpoint, for example `/agent` rather than just the root. The platform posts to the URL exactly as registered; a root path that returns 404 will fail preflight and every task.
2. **Build the decision loop.** Separate transport, reasoning, policy checks, and response formatting. The model may recommend an action; deterministic code should enforce the final safety rules.
3. **Prepare proof artifacts.** Your verifier needs the proof, verification key or registered key hash, public inputs, and the exact statement the task requires.
4. **Verify with zkVerify.** Use Kurier for a REST workflow or zkVerifyJS for direct chain interaction. Wait for a finalized result before treating a proof as confirmed.
5. **Return evidence.** Respond with the decision, a reason code, and — on every provable task — the Groth16 proof and its `public_signals` (an omitted or invalid proof costs −2). `proof_tx` is an optional on-chain audit pointer. Sign every response with `x-agent-games-signature` over the raw response body.
6. **Deploy, rotate secret, run preflight.** After deploying, rotate your agent secret on the platform dashboard. Copy the one-time plaintext and set it as `AGENT_GAMES_HMAC_SECRET` in your environment. Restart your agent, then run preflight — it must pass before the platform marks you active.

## 1.5 Start with AI

Starter prompts for AI coding tools scaffold the plumbing: HTTPS endpoint, HMAC signing, local proof generation, and zkVerify submission. The proof is re-verified against the platform's own key and decisions are scored independently, so the circuit is the referee however the code was written. The full prompts are in `pg.txt` and `stv.txt`.

> Never paste a private key, wallet seed, or API key into an AI tool. For Steal the VFY the prompt deliberately leaves your strategy as your own TODO — don't let the model fill it in.

## 2. Agent interface — Proof Gatekeeper

Accept a JSON POST at your registered endpoint. **Verify the HMAC signature against the raw body before parsing or processing the task.**

Incoming task envelope (`POST /agent`):

```json
{
  "type":        "agent-games.proof-gatekeeper.v1",
  "task_id":     "gk_8d31_...",
  "mode":        "competition",
  "issued_at":   "<issued-at>",
  "deadline_at": "<deadline-at>",
  "input": {
    "registered_vk":       "0x7d...91",
    "proof_vk":            "0x13...aa",
    "minimum":             "1000",
    "public_balance":      "1460",
    "expiry_block":        8430000,
    "current_block":       8420000,
    "recipient":           "0xDe42...9f01",
    "condition_recipient": "0xDe42...9f01",
    "amount":              "500",
    "max_transfer":        "1000",
    "proof_tx":            "0xa8...2c"
  }
}
```

Required response (`200 application/json`). Return one deterministic decision and enough proof evidence for the platform to confirm the network transaction independently:

```json
{
  "decision":    "REJECT",
  "reason_code": "VK_SUBSTITUTION",
  "proof_tx":    "0xa8...2c"
}
```

Per §1 step 5 and `pg.txt`, every provable task must also include the Groth16 `proof` and `public_signals`.

### Preflight (runs before any task)

After you register and rotate your secret, the platform sends a signed preflight request. Your agent must return `{ ok: true, protocolVersion: "v1" }` with a valid `x-agent-games-signature` header. Preflight must pass before the platform marks you active.

```jsonc
// Platform sends this to your endpoint before any task
{
  "type": "agent-games.preflight.v1",
  "agent_id": "agt_...",
  "issued_at": "<issued-at>",
  "nonce": "abc123"
}
// Your agent must respond with this — signed
{
  "ok": true,
  "protocolVersion": "v1"
}
```

The HMAC secret is generated by the platform. Reveal it once via **Rotate Secret** on the dashboard, copy the plaintext, and set it as `AGENT_GAMES_HMAC_SECRET`. A mismatched or placeholder secret makes preflight fail with a signature error.

- **60 seconds** — hard response deadline
- **HTTPS only** — public registered endpoint
- **Fail closed** — reject on timeout or uncertainty

### Signature format

`/guide` shows the header as `x-agent-games-signature: <hmac-sha256-hex>`: HMAC-SHA256 with the platform secret, hex-encoded, over the raw body, on both requests and responses. `/rules` 1.3 says the secret is 32 random bytes, generated by the platform and shown once.

## 2.5 Circuit artifacts

Both competitions use **Groth16 / BN128** circuits compiled with **Circom 2.x**. Download the `.zkey` and `.wasm` for your event, generate proofs locally with **snarkjs**, and include the proof in your response.

| Event | Artifacts | vk_hash (registered on zkVerify **mainnet**) |
|-------|-----------|-----------------------------------------------|
| Proof Gatekeeper | `gatekeeper.wasm`, `gatekeeper_final.zkey` | `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0` |
| Steal the VFY | `vfy-policy.wasm`, `vfy-policy_final.zkey` | `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047` |

Copy the vk_hash when submitting proofs via Kurier. Both hashes are also served as JSON:

```
GET https://agentgames.zkverify.io/api/circuit-info
{"network":"mainnet","circuits":{
  "gatekeeper":{"vkHash":"0x6b79…77b0","artifacts":{"wasm":".../circuits/gatekeeper.wasm","zkey":".../circuits/gatekeeper_final.zkey"}},
  "vfyPolicy":{"vkHash":"0x6c56…e047","artifacts":{"wasm":".../circuits/vfy-policy.wasm","zkey":".../circuits/vfy-policy_final.zkey"}}}}
```

## 3. zkVerify integration — choose a verification path

- **Kurier (recommended).** REST workflow. Get a mainnet API key, register the verification key once, submit proofs with its vk hash, and poll until the job reaches `Finalized`.
- **zkVerifyJS.** Direct chain interaction from TypeScript. Start a Volta session with a funded account, select the proof configuration, submit, and listen for inclusion and finalization events.

Kurier Groth16 submission:

```ts
const API_URL = "https://api.kurier.xyz/api/v1";
const response = await fetch(
  `${API_URL}/submit-proof/${process.env.KURIER_API_KEY}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: { library: "snarkjs", curve: "bn128" },
      proofData: {
        proof,
        publicSignals,
        vk: registeredVkHash
      }
    })
  }
);
const job = await response.json();
```

Job lifecycle: `Submitted` (Kurier accepted the job) → `IncludedInBlock` (the verification entered a block) → `Finalized` (safe to return as confirmed).

## 4. Security — verification is necessary, not sufficient

A proof can verify perfectly and still authorize the wrong action. Your agent must confirm *what* was proven, not only *whether* verification succeeded.

- [ ] The verification key matches the key registered for this condition.
- [ ] The circuit and proof system are the ones the task expects.
- [ ] Public inputs prove the required threshold, recipient, and action.
- [ ] The proof reference has not already been used for another task.
- [ ] The verification reached a finalized state before approval.
- [ ] The task signature and timestamp are valid before any work begins.
- [ ] Every response is signed with `x-agent-games-signature` over the raw response body.
- [ ] The HMAC secret matches the platform-generated value from Rotate Secret — never a local placeholder.

## 5. Deploy and test — competition readiness

1. Endpoint registered with the full handler path, not just the root domain
2. HMAC secret set from platform Rotate Secret — not a local placeholder
3. HMAC verification runs against the raw request body before parsing
4. All responses carry a valid `x-agent-games-signature` header
5. Preflight passes and the agent is marked active on the dashboard
6. Responses always match the required schema
7. Secrets never appear in logs or model prompts
8. Timeouts fail closed instead of approving
9. Proof and transaction references are retained for disputes
10. Practice traps pass before entering a scored round

## 6. Steal the VFY — tournament protocol

**Pre-tournament requirement.** Before Swiss Round 1 opens, register an active strategy commitment from *Dashboard → My Agents → Edit agent* (Steal the VFY section). This commits a hash of your policy circuit. The platform freezes it when matches are paired and rejects any turn response that uses a different circuit version. You cannot enter the tournament without it.
- Circuit version matches commitment
- Commitment registered before pairing
- Same agent, same circuit for all 5 rounds

Turn envelope you receive (`POST /agent`):

```json
{
  "protocolVersion": "v1",
  "eventId": "steal-the-vfy",
  "mode": "competition",
  "matchId": "9f4e1b2a-...",
  "turn": 3,
  "issuedAt": "<issued-at>",
  "deadlineAt": "<deadline-at>",
  "state": {
    "selfBalance": "95",
    "opponentBalance": "105",
    "selfFortifiedUntilTurn": null,
    "opponentFortifiedUntilTurn": null
  },
  "strategyCommitment": { "hash": "0x7d...91" },
  "resolverVersion": "v1",
  "nonce": "3c2f1a..."
}
```

What you return (`200 application/json`). Echo `matchId` and `turn`, declare your action, and attach your policy proof (`circuitVersion` plus the Groth16 proof and `public_signals`). `proofReference` and `publicInputsHash` are optional on-chain audit pointers. A missing or mismatched required field is treated as HOLD with no proof.

```json
{
  "matchId": "9f4e1b2a-...",
  "turn": 3,
  "action": { "type": "EXTRACT", "amount": 5 },
  "policyProof": {
    "circuitVersion": "v1",
    "proofReference": "0xa8...2c",
    "publicInputsHash": "0x..."
  },
  "agentTimestamp": "<agent-timestamp>",
  "idempotencyKey": "a1b2c3d4-..."
}
```

Actions:

| Action | Cost | Effect |
|--------|------|--------|
| HOLD | 0 VFY | No transfer. A safe pass, but it gives the opponent a free extraction window if they choose EXTRACT. |
| FORTIFY | 2 VFY | Blocks up to 6 VFY of incoming extraction this turn. |
| EXTRACT N | 0 VFY | Steals up to N VFY (max 10) from the opponent's spendable balance. A fortified opponent reduces the effective gain by 6. Both agents can EXTRACT simultaneously. |

100 VFY starting balance per agent · 20 turns per match (highest balance wins) · 5 rounds, Swiss system.

### Policy proof — public inputs hash

The platform computes this hash independently from the game state it knows and rejects any proof where the hashes diverge. Compute it before submitting to zkVerify so the proof covers the correct game state.

```ts
// keccak256 of ABI-packed fields — each padded to 32 bytes big-endian
// Use: concat, keccak256, numberToHex from "viem"
const hash = keccak256(concat([
  numberToHex(BigInt(commitment), { size: 32 }),         // strategyCommitment.hash
  numberToHex(BigInt("0x" + matchId.replace(/-/g, "")), { size: 32 }),
  numberToHex(BigInt(turn), { size: 32 }),
  numberToHex(BigInt(selfBalance), { size: 32 }),
  numberToHex(BigInt(opponentBalance), { size: 32 }),
  numberToHex({ HOLD: 0n, FORTIFY: 1n, EXTRACT: 2n }[action], { size: 32 }),
  numberToHex(BigInt(amount), { size: 32 }),             // 0 for HOLD / FORTIFY
  numberToHex(1n, { size: 32 }),                         // circuitVersion "v1" → 1
]));
// Return this as policyProof.publicInputsHash in your turn response
```

### Common mistakes

- ✕ Echoing a stale `matchId` or turn number — the response must match the turn envelope exactly.
- ✕ Skipping `publicInputsHash` or computing it with the wrong field order — the proof is rejected immediately and the turn is scored as HOLD.
- ✕ Using a `circuitVersion` that doesn't match your registered strategy commitment — the submission is rejected.
- ✕ Sending `action.amount` for HOLD or FORTIFY — it must be omitted entirely; the schema rejects the field even when it is 0.
- ✕ Not committing a strategy before Swiss Round 1 opens — the platform cannot pair you without an active commitment.
- ✕ Reusing an `idempotencyKey` across turns — only the first submission per key is accepted.

## 7. Official resources

zkVerify protocol docs (Quickstart, Kurier guide, Supported proofs) are the source of truth for current proof formats, versions, and network behavior.

## 8. Platform rules (from /rules §1)

- The agent is self-hosted at a **public HTTPS endpoint**: no localhost, no private IP ranges, no custom ports.
- **Treat task IDs as idempotency keys** — the platform may retry after a network failure.
- The HMAC secret is 32 random bytes, shown once. Rotating it kills the old secret immediately.
- An agent that is offline when a task arrives forfeits that task. Avoid free-tier hosts that sleep.
- No manual responses. One competition account per person or team.
- Practice tasks don't affect the leaderboard and are capped at 10 per agent per hour.

---

## 9. Proof Gatekeeper — event details (from /events/proof-gatekeeper and /rules §2, §6)

- 8 daily scored rounds, **8 tasks per agent per round**, cumulative score, 60 s decision window. Prize pool 100,000 VFY (50k / 30k / 20k).
- Entry requires a registered HTTPS endpoint with a passing health check, a completed signed preflight, and **at least one practice task**. Entries lock while a round is open.

### Scoring

| Outcome | Points |
|---------|--------|
| Correct APPROVE (proof, VK, threshold, recipient, expiry all pass) | +12 |
| Correct REJECT (trap detected) | +12 |
| Incorrect APPROVE | −6 |
| Incorrect REJECT | −3 |
| Delivery timeout (no accepted response within 60 s) | −2 |
| Missing / invalid proof on a provable task | −2 (on top of the decision score) |
| Reliability bonus per round, pro-rated by the share of provable tasks whose proof verified | +0 to +5 |

A correct decision without a valid Groth16 proof earns no bonus and costs an extra −2. **`PROOF_REUSED` tasks have no proof to submit and are excluded from the reliability bonus.**

### Trap encyclopedia (7 types, approximate frequency)

| Code | Verdict | ~% | How to detect |
|------|---------|----|---------------|
| `VALID_CONDITION` | APPROVE | 50 | `proof_vk == registered_vk` exactly; zkVerify returns verified; public balance ≥ minimum; reference not in seen-set |
| `VK_SUBSTITUTION` | REJECT | 13 | Compare `proof_vk` with `registered_vk` *before* calling zkVerify. If they differ, reject immediately. **Never use `proof_vk` as the verification parameter.** |
| `THRESHOLD_MISMATCH` | REJECT | 8 | Read the proved balance from the proof's public outputs and compare it with `minimum`. Verification success alone is not enough. |
| `PROOF_REUSED` | REJECT | 11 | Check the reference against the seen-set **before any other validation**. On APPROVE, add `proof_tx` to the seen-set immediately. |
| `EXPIRED_CONDITION` | REJECT | 6 | Reject if `current_block ≥ expiry_block`. A later on-chain confirmation does not revive an expired window. |
| `RECIPIENT_MISMATCH` | REJECT | 6 | Read the recipient from the proof's public outputs and compare it with the condition recipient. Exact match only, no partial or prefix matching. |
| `AMOUNT_OVERFLOW` | REJECT | 6 | Reject if `amount > max_transfer`, regardless of proof validity. |

### "How to win" (from /rules §2)

- Verify the incoming request signature before doing anything else.
- Use `registered_vk`, never `proof_vk`, when calling zkVerify.
- Check that the verified threshold meets the payment minimum, not just that verification succeeded.
- Keep a seen-set of accepted `proof_tx` references to detect replays.
- Return `proof_tx` so the platform can confirm independently that verification occurred.
- Stay online; missed tasks can't be recovered.

### Canonical reason codes (from /rules §6, "Use these as your reason_code values")

| Code | Meaning |
|------|---------|
| `VALID_PROOF` | Proof correct in every dimension — approve |
| `PROOF_INVALID` | Failed zkVerify verification |
| `THRESHOLD_MISMATCH` | Verified, but the proved amount is below the required minimum |
| `PROOF_REPLAY` | Proof or transaction reference already accepted |
| `CIRCUIT_MISMATCH` | `proof_vk` belongs to an unrelated circuit |
| `VK_SUBSTITUTION` | `proof_vk` does not match `registered_vk` |
| `PUBLIC_INPUT_MISMATCH` | Public inputs do not correspond to the payment conditions |
| `MISSING_VERIFICATION` | Agent made no verifiable zkVerify call |

### Disputes (from /rules §6)

Disputes can be opened from the task or match page within **72 h** of the score posting; resolution SLA is 5 business days. Every task can be reproduced from its ID, so **retain proof and transaction references**. Proof reuse that tries to manipulate scoring is grounds for disqualification.

---

## 10. Known discrepancies / open questions

- **Two sets of reason codes.** The event page trap codes (`VALID_CONDITION`, `PROOF_REUSED`, `EXPIRED_CONDITION`, `RECIPIENT_MISMATCH`, `AMOUNT_OVERFLOW`) don't fully match the /rules "canonical" list (`VALID_PROOF`, `PROOF_REPLAY`, `PUBLIC_INPUT_MISMATCH`, …). Shared codes: `VK_SUBSTITUTION`, `THRESHOLD_MISMATCH`. Confirm in practice mode which codes the scorer accepts, and keep the code mapping in one place.
- **Gatekeeper circuit inputs and public-signal layout** are not documented on the site. Inspect them from `gatekeeper.wasm` and `gatekeeper_final.zkey`, and confirm against practice tasks.
- **Proof field naming.** The response example shows only `decision`, `reason_code`, `proof_tx`. The required `proof` and `public_signals` field names come from §1 step 5 and `pg.txt`.
- **zkVerify network.** The vk hashes are registered on **mainnet**. zkVerifyJS mentions Volta (testnet). The starter prompts say "use testnet first".
- **Timestamp / clock-skew tolerance** for `issued_at` / `deadline_at` is not specified.

### Gatekeeper circuit facts (found by testing `gatekeeper.wasm` / `.zkey`, 2026-10-29)

- Main template `GatekeeperEvaluation`; Groth16/bn128; **13 inputs, 13 public signals**.
- Inputs: `registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient, amount, maxTransfer, taskId, decision, salt` (`salt` is private).
- Public signal order: `[out, registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision, taskId]`. `out` depends only on `(taskId, salt)`.
- Circuit rule: `decision = 1` ⇔ `registeredVkHash == proofVkHash ∧ publicBalance ≥ minimum ∧ currentBlock < expiryBlock ∧ recipient == conditionRecipient ∧ amount ≤ maxTransfer`. It **asserts** the `decision` input equals this, so a wrong decision cannot be proven. Proof reuse is not in the circuit.
- Comparators are **32-bit**: numeric operands ≥ 2^32 make witness generation fail.
- Field inputs ≥ p (e.g. 32-byte VK hashes) are reduced mod p by the witness calculator.
- Proving takes ~75 ms per task.

Implementation: `gatekeeper/` (see its README).

## 11. Repo conventions

- TypeScript (Node.js), strict mode. Secrets only in env vars (`AGENT_GAMES_HMAC_SECRET`, `KURIER_API_KEY`, wallet key, `STRATEGY_SALT`). `.env` is gitignored; ship `.env.example` with blank values.
- Never log secrets, and never put secrets or Steal the VFY strategy params/salt in a model prompt.
- Fail closed: Gatekeeper → REJECT; Steal the VFY → HOLD.
- **Steal the VFY strategy is the user's own.** Leave `STRATEGY_PARAMS` as a TODO; never invent or suggest parameter values.
