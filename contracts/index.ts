// Exports the compiled audit-attestation contract wired with its witnesses.
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import path from 'node:path';

export {
  Contract,
  ledger,
  pureCircuits,
  type Witnesses,
  type Ledger,
  type Attestation,
  type ImpureCircuits,
  type PureCircuits,
} from './managed/audit-attestation/contract/index.js';
export * from './witnesses.js';

import { Contract } from './managed/audit-attestation/contract/index.js';
import { witnesses } from './witnesses.js';

const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');
export const zkConfigPath = path.resolve(currentDir, 'managed', 'audit-attestation');

export const CompiledAuditAttestationContract = CompiledContract.make(
  'AuditAttestationContract',
  Contract,
).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);
