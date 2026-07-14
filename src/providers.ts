import { type MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { type MidnightWalletProvider } from './wallet.js';
import { type NetworkConfig } from './config.js';

// Impure circuits (the ones with proving/verifier keys). getDappPubKey is a
// pure circuit and is not part of the ZK config provider circuit set.
export type AuditCircuits =
  | 'approveAuditor'
  | 'revokeAuditor'
  | 'postAttestation'
  | 'revokeAttestation';

export type AuditProviders = MidnightProviders<any>;

export function buildProviders(
  wallet: MidnightWalletProvider,
  zkConfigPath: string,
  config: NetworkConfig,
): AuditProviders {
  const zkConfigProvider = new NodeZkConfigProvider<AuditCircuits>(zkConfigPath);

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `audit-attestation-${Date.now()}`,
      privateStoragePasswordProvider: () => 'Audit-Attestation-Test-Password',
      accountId: wallet.getCoinPublicKey(),
    }),
    publicDataProvider: indexerPublicDataProvider(
      config.indexer,
      config.indexerWS,
    ),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider: wallet,
    midnightProvider: wallet,
  };
}
