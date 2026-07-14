# ZK-Native Audit Attestation — PoC

A proof-of-concept Midnight DApp that implements the core of the
[ZK-Native Audit Attestation design](../ai-ethics/zk-audit-attestation-design.md):
an **MNF-curated registry of named auditors** post **on-chain audit
attestations** for smart contracts, where the sensitive audit findings stay
**private** and only a **proven boolean conclusion** plus public metadata is
written to the ledger.

> **Thesis it demonstrates:** *trust through verifiability, not transparency.*
> The auditor proves "no unresolved Critical/High findings" without the finding
> data ever touching the chain.

This repo is scaffolded from `example-hello-world` and runs end-to-end against a
local Midnight devnet (node `1.0.0`, indexer `4.3.3`, proof-server `8.1.0`,
Midnight JS SDK `4.1.1`, Compact `language_version 0.23`).

## What it proves (the E2E suite)

`src/test/attestation.test.ts` deploys the contract and exercises the full
lifecycle against a live devnet. **All 8 tests pass**, generating real ZK proofs
for every state-changing call:

| Test | Design-doc property |
|---|---|
| Deploys with the MNF operator as owner | Identity plane — MNF is the curated root of trust |
| MNF approves a named auditor | Curated, **non-anonymous** registry |
| Rejects auditor approval from a non-owner | Only MNF curates the registry |
| Approved auditor attests a clean contract — **finding count stays private** | The ZK thesis: private witness, public boolean |
| Rejects attestation when unresolved findings remain | `assert(count == 0)` — proof cannot be built on a dirty report |
| Rejects attestation from a non-approved party | No self-attestation |
| MNF revokes the attestation | Revocation — signal self-voids, record kept for audit |
| Stops a revoked auditor from posting | Revocation propagates |

The privacy property is asserted directly: the on-chain `Attestation` record has
**no field** for the finding count — only `{ auditor, conclusion, claimTier,
timestamp, active }`.

## Architecture mapping

| Design doc | This PoC |
|---|---|
| **Identity plane** — MNF-curated approved-auditor registry | `owner: Bytes<32>` (sealed) + `approvedAuditors: Map<Bytes<32>, Boolean>` + `auditorNames: Map<Bytes<32>, Opaque<"string">>` |
| **Attestation plane** — records bound to a code hash | `attestations: Map<Bytes<32>, Attestation>`, keyed by the audited contract's code hash |
| **The private witness** — the confidential report | `witness unresolvedFindings(): Uint<16>` — asserted `== 0` **without** `disclose()`, so it never reaches the ledger |
| **Auditor identity** (non-anonymous) | `getDappPubKey(sk) = persistentHash([pad(32,"audit-attest:pk:"), sk])`; the derived pubkey is stored/compared publicly |
| **Base boolean claim** | `conclusion: true` + `claimTier` (1 = base) written on success |
| **Hash-binding / supersession** | attestation keyed by `codeHash`; a different code hash is a different (absent) record |
| **Revocation** | `revokeAuditor` (MNF) and `revokeAttestation` (MNF or the attesting auditor) |

Contract: [`contracts/audit-attestation.compact`](contracts/audit-attestation.compact) ·
Witnesses: [`contracts/witnesses.ts`](contracts/witnesses.ts)

## How the identity model lets one wallet play many parties

Protocol identity (MNF / auditor / attacker) is **not** the wallet — it is a
public key derived from a witness secret key (`localSk()`). The test uses a
single funded wallet (Alice) that pays for every transaction, but supplies a
different `sk` (and a different confidential finding count) via a distinct
`privateStateId` for each party. That is exactly how a real deployment separates
the payer from the attested identity.

## Prerequisites

- Node ≥ 22, Yarn 1.x
- Docker (for the local devnet)
- The Compact CLI (`compact`) on your `PATH`

## Run it

```bash
yarn install
yarn compile              # compiles contracts/audit-attestation.compact -> contracts/managed/
yarn env:up               # starts node + indexer + proof-server (waits for health)
yarn wait:dust            # blocks until the test wallet has spendable DUST
yarn test:local           # deploy + full lifecycle against the local devnet
yarn env:down             # tear down the devnet
```

`yarn validate` runs `env:up`, the local tests, then `env:down` in one step.

## Known PoC limitations (not production-ready)

- **Identity is prover-claimed.** `localSk()` is a witness value with no
  cryptographic binding to the transaction signer (same as the reference example
  contracts). Owner/auditor gating is only as strong as the secret's secrecy;
  production auth would bind identity to the signer.
- **The conclusion is trusted from the auditor.** As the design doc states
  plainly, ZK proves the *integrity* of the statement, not its *truth* — a
  negligent or dishonest approved auditor can still post a valid proof of a
  false conclusion. The registry curation, revocation, and non-repudiation are
  the mitigations, not the cryptography.
- **`timestamp` is auditor-supplied**, not a trusted on-chain clock.
- **No selective-disclosure claim menu yet.** Only the base boolean claim
  (`claimTier = 1`) is implemented; richer opt-in claims are future work.
- **Code-hash binding is illustrative.** The PoC treats `codeHash` as an opaque
  32-byte key; canonicalizing exactly what it commits to is left to a later
  phase.
