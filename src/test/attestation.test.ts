import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  deployContract,
  submitCallTx,
  type DeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  type EnvironmentConfiguration,
  waitForFunds,
} from '@midnight-ntwrk/testkit-js';
import pino from 'pino';

import { getConfig } from '../config.js';
import {
  MidnightWalletProvider,
  syncWallet,
  type WalletSecret,
} from '../wallet.js';
import { buildProviders, type AuditProviders } from '../providers.js';
import {
  CompiledAuditAttestationContract,
  Contract,
  ledger,
  pureCircuits,
  zkConfigPath,
  createAuditPrivateState,
  type Ledger,
} from '../../contracts/index.js';

// Required for GraphQL subscriptions in Node.js
// @ts-expect-error WebSocket global assignment for apollo
globalThis.WebSocket = WebSocket;

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

const ALICE_LOCAL_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';

// A single funded wallet (Alice) pays for every transaction. The on-chain
// *identities* — MNF, the auditor, the attacker — are NOT the wallet: each is a
// public key derived from a distinct witness secret key (`getDappPubKey(sk)`),
// so one payer can act as several protocol parties. This is the whole point of
// the witness-based identity model.
const b32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const MNF_SK = b32(0x11); // Midnight Foundation registry operator
const AUDITOR_SK = b32(0x22); // an approved auditor (Ledger Assurance Labs)
const ATTACKER_SK = b32(0x33); // a non-approved party attempting to self-attest

// One private-state slot per party. Each holds { sk, unresolvedFindings }.
const MNF_PSID = 'mnf-private-state';
const AUDITOR_PSID = 'auditor-private-state';
const ATTACKER_PSID = 'attacker-private-state';

// Code hashes of the (imaginary) contracts being attested.
const CODE_HASH_CLEAN = b32(0xa1); // audit passes → attestation posted
const CODE_HASH_DIRTY = b32(0xb2); // findings remain → attestation must fail
const CODE_HASH_ATTACK = b32(0xc3); // attacker target → must fail

const AUDITOR_NAME = 'Ledger Assurance Labs';
const CLAIM_TIER_BASE = 1n; // base boolean claim
const TIMESTAMP = 1_752_000_000n;

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';

const eq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (a: Uint8Array): string => Buffer.from(a).toString('hex');

function resolveSecret(net: string): WalletSecret {
  if (net === 'local') return { kind: 'seed', value: ALICE_LOCAL_SEED };
  const upper = net.toUpperCase();
  const seedHex = process.env[`MIDNIGHT_${upper}_SEED`]?.trim();
  if (seedHex) return { kind: 'seed', value: seedHex };
  const mnemonic = process.env[`MIDNIGHT_${upper}_MNEMONIC`]
    ?.trim()
    .replace(/\s+/g, ' ');
  if (mnemonic) return { kind: 'mnemonic', value: mnemonic };
  throw new Error(`Set MIDNIGHT_${upper}_SEED or _MNEMONIC for network '${net}'.`);
}

describe(`ZK Audit Attestation (${network})`, () => {
  let wallet: MidnightWalletProvider;
  let providers: AuditProviders;
  let contractAddress: ContractAddress;

  // Public identities derived from the witness secret keys (computed with the
  // contract's own pure circuit, so TS and the ZK circuit agree exactly).
  const mnfPk = pureCircuits.getDappPubKey(MNF_SK);
  const auditorPk = pureCircuits.getDappPubKey(AUDITOR_SK);

  const config = getConfig();
  const secret = resolveSecret(network);
  const isRemote = network !== 'local';
  const syncTimeoutMs = Number(
    process.env['MIDNIGHT_SYNC_TIMEOUT_MS'] ?? (isRemote ? 3_600_000 : 600_000),
  );

  async function readLedger(): Promise<Ledger> {
    const state = await providers.publicDataProvider.queryContractState(
      contractAddress,
    );
    expect(state).not.toBeNull();
    return ledger(state!.data);
  }

  async function callAs(
    psid: string,
    sk: Uint8Array,
    unresolvedFindings: bigint,
    circuitId: 'approveAuditor' | 'revokeAuditor' | 'postAttestation' | 'revokeAttestation',
    args: unknown[],
  ): Promise<void> {
    // Seed this party's private state (witness sk + confidential finding count),
    // then submit the call. submitCallTx builds the ZK proof from this state.
    providers.privateStateProvider.setContractAddress(contractAddress);
    await providers.privateStateProvider.set(
      psid,
      createAuditPrivateState(sk, unresolvedFindings),
    );
    await (submitCallTx<Contract, typeof circuitId>)(providers, {
      compiledContract: CompiledAuditAttestationContract,
      contractAddress,
      privateStateId: psid,
      circuitId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
    });
  }

  beforeAll(async () => {
    setNetworkId(config.networkId);
    const envConfig: EnvironmentConfiguration = {
      walletNetworkId: config.networkId,
      networkId: config.networkId,
      indexer: config.indexer,
      indexerWS: config.indexerWS,
      node: config.node,
      nodeWS: config.nodeWS,
      faucet: config.faucet,
      proofServer: config.proofServer,
    };

    wallet = await MidnightWalletProvider.build(logger, envConfig, secret);
    await wallet.start();
    await syncWallet(logger, wallet.wallet, syncTimeoutMs);

    if (isRemote) {
      await waitForFunds(wallet.wallet, envConfig, false, wallet.unshieldedKeystore);
    }

    providers = buildProviders(wallet, zkConfigPath, config);
    logger.info(`MNF identity:     0x${hex(mnfPk)}`);
    logger.info(`Auditor identity: 0x${hex(auditorPk)}`);
  }, 15 * 60_000);

  afterAll(async () => {
    if (wallet) await wallet.stop();
  });

  it('deploys with the MNF operator as owner', async () => {
    const deployed: DeployedContract<Contract> = await (deployContract<Contract>)(
      providers,
      {
        compiledContract: CompiledAuditAttestationContract,
        privateStateId: MNF_PSID,
        // Deployer is MNF: owner = getDappPubKey(MNF_SK).
        initialPrivateState: createAuditPrivateState(MNF_SK, 0n),
      },
    );
    contractAddress = deployed.deployTxData.public.contractAddress;
    logger.info(`Deployed at: ${contractAddress}`);
    expect(contractAddress.length).toBeGreaterThan(0);

    const ld = await readLedger();
    expect(eq(ld.owner, mnfPk)).toBe(true);
    expect(ld.approvedAuditors.isEmpty()).toBe(true);
    expect(ld.attestations.isEmpty()).toBe(true);
  });

  it('lets MNF approve a named auditor (curated registry)', async () => {
    await callAs(MNF_PSID, MNF_SK, 0n, 'approveAuditor', [auditorPk, AUDITOR_NAME]);

    const ld = await readLedger();
    expect(ld.approvedAuditors.member(auditorPk)).toBe(true);
    expect(ld.approvedAuditors.lookup(auditorPk)).toBe(true);
    expect(ld.auditorNames.lookup(auditorPk)).toBe(AUDITOR_NAME);
  });

  it('rejects auditor approval from a non-owner', async () => {
    // Attacker (not MNF) tries to approve themselves as an auditor.
    const attackerPk = pureCircuits.getDappPubKey(ATTACKER_SK);
    await expect(
      callAs(ATTACKER_PSID, ATTACKER_SK, 0n, 'approveAuditor', [
        attackerPk,
        'Rogue Auditor',
      ]),
    ).rejects.toThrow();

    const ld = await readLedger();
    expect(ld.approvedAuditors.member(attackerPk)).toBe(false);
  });

  it('lets an approved auditor attest a clean contract — finding count stays private', async () => {
    // unresolvedFindings = 0 → the ZK circuit's `assert(count == 0)` passes.
    await callAs(AUDITOR_PSID, AUDITOR_SK, 0n, 'postAttestation', [
      CODE_HASH_CLEAN,
      CLAIM_TIER_BASE,
      TIMESTAMP,
    ]);

    const ld = await readLedger();
    expect(ld.attestations.member(CODE_HASH_CLEAN)).toBe(true);
    const rec = ld.attestations.lookup(CODE_HASH_CLEAN);
    expect(rec.conclusion).toBe(true);
    expect(rec.active).toBe(true);
    expect(eq(rec.auditor, auditorPk)).toBe(true);
    expect(rec.claimTier).toBe(CLAIM_TIER_BASE);

    // The whole thesis: the attestation record has NO field for the finding
    // count. The private witness (0 here, but could be any audited value) never
    // reaches the ledger — only the proven boolean conclusion does.
    expect(Object.keys(rec)).not.toContain('unresolvedFindings');
    expect(Object.keys(rec).sort()).toEqual(
      ['active', 'auditor', 'claimTier', 'conclusion', 'timestamp'].sort(),
    );
  });

  it('rejects an attestation when unresolved findings remain (proof cannot be built)', async () => {
    // Same approved auditor, but the confidential report has 5 unresolved
    // Critical/High findings → `assert(count == 0)` fails → no valid proof.
    await expect(
      callAs(AUDITOR_PSID, AUDITOR_SK, 5n, 'postAttestation', [
        CODE_HASH_DIRTY,
        CLAIM_TIER_BASE,
        TIMESTAMP,
      ]),
    ).rejects.toThrow();

    const ld = await readLedger();
    expect(ld.attestations.member(CODE_HASH_DIRTY)).toBe(false);
  });

  it('rejects an attestation from a non-approved party (no self-attestation)', async () => {
    await expect(
      callAs(ATTACKER_PSID, ATTACKER_SK, 0n, 'postAttestation', [
        CODE_HASH_ATTACK,
        CLAIM_TIER_BASE,
        TIMESTAMP,
      ]),
    ).rejects.toThrow();

    const ld = await readLedger();
    expect(ld.attestations.member(CODE_HASH_ATTACK)).toBe(false);
  });

  it('lets MNF revoke the attestation (signal self-voids)', async () => {
    await callAs(MNF_PSID, MNF_SK, 0n, 'revokeAttestation', [CODE_HASH_CLEAN]);

    const ld = await readLedger();
    const rec = ld.attestations.lookup(CODE_HASH_CLEAN);
    expect(rec.active).toBe(false);
    // The record persists for auditability; only its `active` flag flips.
    expect(rec.conclusion).toBe(true);
  });

  it('stops a revoked auditor from posting new attestations', async () => {
    await callAs(MNF_PSID, MNF_SK, 0n, 'revokeAuditor', [auditorPk]);
    expect((await readLedger()).approvedAuditors.lookup(auditorPk)).toBe(false);

    await expect(
      callAs(AUDITOR_PSID, AUDITOR_SK, 0n, 'postAttestation', [
        b32(0xd4),
        CLAIM_TIER_BASE,
        TIMESTAMP,
      ]),
    ).rejects.toThrow();
  });
});
