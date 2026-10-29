You are helping me build an AI agent for "Proof Gatekeeper", an event in the zkVerify Agent Games. Build a production-ready HTTP service in TypeScript (Node.js).

HOW THE GAME WORKS (read carefully):
- The platform NEVER runs my code. My agent is a public HTTPS endpoint the platform POSTs signed tasks to.
- For each task the platform sends a signed JSON envelope describing a transfer request. My agent decides APPROVE or REJECT and returns a Groth16 ZK proof (generated locally with snarkjs) plus its public signals.
- The platform independently re-verifies my proof against its OWN registered verification key AND checks whether my decision was correct. A valid proof is necessary but NOT sufficient — the circuit is the referee, so I cannot fake a decision.
- Score: +12 correct decision, -6 approving a trap, -3 rejecting a valid request, -2 timeout/offline, -2 if the proof fails to verify, plus a reliability bonus (verified proofs / tasks). Over 8 daily rounds the highest total wins.

AUTHORITATIVE SPEC — DO NOT INVENT PROTOCOL DETAILS:
- Read https://agentgames.zkverify.io/build — the full protocol: task/response schemas, the preflight handshake, circuit artifacts, zkVerify paths, and the Security checklist. Treat it as the source of truth over anything you assume.
- Read https://agentgames.zkverify.io/guide for the registration flow.
- Download the gatekeeper circuit artifacts (gatekeeper.wasm, gatekeeper_final.zkey) from the /build artifacts section.

WHAT TO BUILD:
1. An HTTPS POST handler at a path I register (e.g. /agent).
2. HMAC verification of every inbound request: compute the HMAC over the RAW request body and compare it to the x-agent-games-signature header BEFORE parsing JSON. Reject on mismatch.
3. Decision logic: APPROVE only when EVERY check on the /build Security checklist passes (VK matches the registered key, correct circuit/proof system, public inputs prove the required threshold + recipient + amount, proof reference not reused, finalized before approval, valid task signature + timestamp). Otherwise REJECT with a reason_code. Enforce the final safety rules in deterministic code — never let a language model make the final call.
4. Local Groth16 proof generation with snarkjs using the downloaded wasm/zkey.
5. zkVerify submission (Kurier REST or zkVerifyJS) — wait for a Finalized result before treating a proof as confirmed.
6. A signed response { decision, reason_code, proof, public_signals } with a valid x-agent-games-signature header over the raw response body.
7. The preflight responder: reply { ok: true, protocolVersion: "v1" }, signed.
8. A local test harness that replays sample envelopes, plus an .env.example.

SECURITY — NON-NEGOTIABLE:
- NEVER paste a private key, wallet seed phrase, or API key into this chat, and never hardcode or commit them. Load all secrets from environment variables only: AGENT_GAMES_HMAC_SECRET (from the dashboard "Rotate Secret"), KURIER_API_KEY, and any wallet key. Add .env to .gitignore and ship a .env.example with blank values.
- Fail closed: on any timeout (60s hard deadline), error, or uncertainty, REJECT — never approve by default.
- Never log secrets or include them in any prompt you send to a model.
- Use testnet first.

Ask me for anything you need (language/framework preference, hosting target). Start by outlining the file structure, then implement.