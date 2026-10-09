import { gmailClient } from './gmailClient.js';
import { microsoftClient } from './microsoftClient.js';
import { imapClient } from './imapClient.js';
import { smtpClient } from './smtpClient.js';
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
    } else if (key === 'credentials' || key === 'hostinger') {
      return {
        name: 'credentials',
        imapClient,
        smtpClient,
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
        } else if (providerType === 'credentials' || providerType === 'hostinger') {
          return await smtpClient.sendSmtpGuestMail({
            hotelId,
            to: options.to || options.toEmail,
            subject: options.subject,
            bodyText: options.bodyText || options.text,
            threadId: options.threadId,
          });
        } else {
          throw new Error(`Outbound email dispatch not configured for provider '${providerType}'`);
        }
      },

      async fetchRecentMessages(maxResults = 10) {
        if (providerType === 'google') {
          return await gmailClient.fetchRecentGmailMessages(hotelId, maxResults);
        } else if (providerType === 'microsoft') {
          return await microsoftClient.fetchRecentMicrosoftMessages(hotelId, maxResults);
        } else if (providerType === 'credentials' || providerType === 'hostinger') {
          return await imapClient.fetchRecentImapMessages(hotelId, maxResults);
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
        } else if (providerType === 'credentials' || providerType === 'hostinger') {
          const { decryptToken } = await import('../../utils/tokenCrypto.js');
          const pass = decryptToken(integration.accessToken);
          const result = await imapClient.verifyImapAuth({
            host: integration.imapHost || `imap.${integration.email.split('@')[1]}`,
            port: integration.imapPort || 993,
            username: integration.email,
            password: pass,
          });
          return {
            success: result.ok,
            verified: result.ok,
            provider: 'credentials',
            email: integration.email,
            status: result.ok ? 'connected' : 'error',
            message: result.message || result.error,
          };
        } else {
          return {
            success: false,
            verified: false,
            provider: providerType,
            message: 'No supported email provider connected',
          };
        }
      },
    };
  },
};

