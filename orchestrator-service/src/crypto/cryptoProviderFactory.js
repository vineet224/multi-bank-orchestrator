import { LocalMockProvider } from './providers/localMockProvider.js';
import { AwsKmsProvider } from './providers/awsKmsProvider.js';
import { AzureVaultProvider } from './providers/azureVaultProvider.js';
import { RemoteWebhookProvider } from './providers/remoteWebhookProvider.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Crypto Provider Factory (cryptoProviderFactory.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Dynamic Factory Pattern for non-custodial crypto adapters.
 * - Resolves client configuration from database without hardcoding cloud vendor SDKs.
 * - Ensures zero credential leakage across tenants in multi-tenant SaaS mode.
 */
export class CryptoProviderFactory {
  /**
   * Instantiates the configured crypto provider for a client
   * @param {Object} credentialRecord
   * @param {string} credentialRecord.cryptoMode - 'AWS_KMS' | 'AZURE_VAULT' | 'REMOTE_API' | 'LOCAL_MOCK'
   * @param {Object} [credentialRecord.cryptoConfig] - Key ARN, Vault URL, Webhook URL, etc.
   * @param {string} [credentialRecord.clientPublicKey]
   * @returns {import('./cryptoProvider.interface.js').CryptoProviderInterface}
   */
  static create(credentialRecord) {
    const mode = credentialRecord?.cryptoMode || 'LOCAL_MOCK';
    const config = {
      ...(credentialRecord?.cryptoConfig || {}),
      clientPublicKeyPem: credentialRecord?.clientPublicKey,
    };

    switch (mode) {
      case 'AWS_KMS':
        return new AwsKmsProvider(config);

      case 'AZURE_VAULT':
        return new AzureVaultProvider(config);

      case 'REMOTE_API':
        return new RemoteWebhookProvider(config);

      case 'LOCAL_MOCK':
      default:
        return new LocalMockProvider(config);
    }
  }
}
