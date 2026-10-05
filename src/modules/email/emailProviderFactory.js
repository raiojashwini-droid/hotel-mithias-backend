import { gmailClient } from './gmailClient.js';
import { microsoftClient } from './microsoftClient.js';
import { prisma } from '../../config/database.js';

/**
 * Factory providing unified interface for supported email providers (Google Workspace, Microsoft 365, IMAP/SMTP)
 */
export const emailProviderFactory = {
  /**
   * Resolves static provider metadata and OAuth helper by provider key ('google' | 'microsoft')
   */
  getProvider(name) {
    const key = (name || '').toLowerCase();
    if (key === 'google') {
      return {
        name: 'google',
        client: gmailClient,
        getOAuthUrl: (hotelId, redirectBack, origin) => gmailClient.getGoogleOAuthUrl(hotelId, redirectBack, origin),
      };
    } else if (key === 'microsoft') {
      return {
        name: 'microsoft',
        client: microsoftClient,
        getOAuthUrl: (hotelId, redirectBack, origin) => microsoftClient.getMicrosoftOAuthUrl(hotelId, redirectBack, origin),
      };
    }
    return null;
  },

  /**
   * Resolves the configured provider client for a specific hotel
   */
  async getProviderForHotel(hotelId) {
    if (!hotelId) {
      throw new Error('hotelId is required to resolve email provider');
    }

    const integration = await prisma.emailIntegration.findUnique({
      where: { hotelId },
    });

    const providerType = integration?.provider?.toLowerCase() || 'none';

    return {
      type: providerType,
      integration,
      isConfigured: Boolean(integration && integration.status === 'connected'),

      async sendEmail(options) {
        if (providerType === 'google') {
          return await gmailClient.sendGuestGmail(options);
        } else if (providerType === 'microsoft') {
          return await microsoftClient.sendGuestMicrosoftMail(options);
        } else {
          throw new Error(`Outbound email dispatch not configured for provider '${providerType}'`);
        }
      },

      async fetchRecentMessages(maxResults = 10) {
        if (providerType === 'google') {
          return await gmailClient.fetchRecentGmailMessages(hotelId, maxResults);
        } else if (providerType === 'microsoft') {
          return await microsoftClient.fetchRecentMicrosoftMessages(hotelId, maxResults);
        } else {
          return [];
        }
      },

      async testConnection() {
        if (providerType === 'google') {
          const { accessToken, email } = await gmailClient.getValidAccessTokenForHotel(hotelId);
          const profile = await gmailClient.getAuthenticatedGmailAddress(accessToken);
          return {
            success: true,
            verified: true,
            provider: 'google',
            email: profile.email || email,
            status: 'connected',
          };
        } else if (providerType === 'microsoft') {
          return await microsoftClient.testConnection(hotelId);
        } else {
          return {
            success: false,
            verified: false,
            provider: providerType,
            message: 'No supported cloud OAuth provider connected',
          };
        }
      },
    };
  },
};
