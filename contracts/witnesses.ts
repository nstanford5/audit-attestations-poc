// Private-state definitions and witness implementations for the
// ZK-native audit attestation contract.
//
// This file holds everything relevant to PRIVATE state. The witnesses run
// locally on the prover's machine; their values are confidential and never
// leave the device except as constraints inside the ZK proof.

import { type Ledger } from './managed/audit-attestation/contract/index.js';
import { type WitnessContext } from '@midnight-ntwrk/compact-runtime';

// The prover's private state.
//   sk:                the 32-byte secret used to derive this DApp identity.
//   unresolvedFindings: count of unresolved Critical/High findings from the
//                       confidential audit report. Never disclosed on-chain.
export type AuditPrivateState = {
  sk: Uint8Array;
  unresolvedFindings: bigint;
};

export const createAuditPrivateState = (
  sk: Uint8Array,
  unresolvedFindings: bigint,
): AuditPrivateState => ({
  sk,
  unresolvedFindings,
});

export const witnesses = {
  // Return the caller's secret key for DApp-specific identity derivation.
  localSk: ({
    privateState,
  }: WitnessContext<Ledger, AuditPrivateState>): [AuditPrivateState, Uint8Array] => {
    return [privateState, privateState.sk];
  },

  // Return the confidential count of unresolved Critical/High findings.
  // The contract constrains this to 0 WITHOUT disclosing it, so the count
  // itself never appears on-chain.
  unresolvedFindings: ({
    privateState,
  }: WitnessContext<Ledger, AuditPrivateState>): [AuditPrivateState, bigint] => {
    return [privateState, privateState.unresolvedFindings];
  },
};
