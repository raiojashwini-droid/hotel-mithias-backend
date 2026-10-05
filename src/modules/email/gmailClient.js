import { prisma } from '../../config/database.js';
import { encryptToken, decryptToken, generateOAuthState, verifyOAuthState } from '../../utils/tokenCrypto.js';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

export const gmailClient = {
  /**
   * Generates the Google OAuth 2.0 Authorization URL with signed state
   */
  getGoogleOAuthUrl(hotelId, redirectBack = '/onboarding', frontendOrigin = null) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/email/oauth/google/callback';

    if (!clientId) {
      throw new Error('GOOGLE_CLIENT_ID is not configured in environment variables');
    }

    const state = generateOAuthState(hotelId, redirectBack, frontendOrigin);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent', // Force consent prompt to guarantee refresh_token
      state,
      include_granted_scopes: 'true',
    });

    return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
  },

  /**
   * Exchanges authorization code for access_token and refresh_token
   */
  async exchangeCodeForTokens(code) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/email/oauth/google/callback';

    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing in backend configuration');
    }

    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      const errMsg = data.error_description || data.error || 'Failed to exchange authorization code with Google';
      throw new Error(`Google OAuth Exchange Error: ${errMsg}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: Number(data.expires_in) || 3600,
      scope: data.scope,
      tokenType: data.token_type,
    };
  },

  /**
   * Retrieves the authenticated Gmail email address and profile
   */
  async getAuthenticatedGmailAddress(accessToken) {
    const res = await fetch(`${GMAIL_API_BASE}/profile`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to retrieve Gmail profile: ${errText}`);
    }

    const profile = await res.json();
    return {
      email: profile.emailAddress,
      historyId: profile.historyId,
      messagesTotal: profile.messagesTotal,
    };
  },

  /**
   * Refreshes an expired access token using the stored refresh token
   */
  async refreshAccessToken(refreshToken) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth credentials missing for token refresh');
    }

    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      const errMsg = data.error_description || data.error || 'Token refresh failed';
      throw new Error(`Google Token Refresh Error: ${errMsg}`);
    }

    return {
      accessToken: data.access_token,
      expiresIn: Number(data.expires_in) || 3600,
      scope: data.scope,
    };
  },

  /**
   * Resolves a valid, unexpired access token for a specific tenant hotelId
   * Automatically refreshes and updates DB if expired.
   */
  async getValidAccessTokenForHotel(hotelId) {
    if (!hotelId) {
      throw new Error('hotelId is required to resolve Gmail access token');
    }

    const integration = await prisma.emailIntegration.findUnique({
      where: { hotelId },
    });

    if (!integration || integration.provider !== 'google' || !integration.accessToken) {
      throw new Error(`No connected Gmail integration found for hotel "${hotelId}"`);
    }

    let rawAccessToken = decryptToken(integration.accessToken);
    const rawRefreshToken = decryptToken(integration.refreshToken);

    const isExpired = integration.tokenExpiry ? new Date() >= new Date(integration.tokenExpiry.getTime() - 60000) : false;

    if (isExpired && rawRefreshToken) {
      try {
        const refreshed = await this.refreshAccessToken(rawRefreshToken);
        rawAccessToken = refreshed.accessToken;
        const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000);

        await prisma.emailIntegration.update({
          where: { hotelId },
          data: {
            accessToken: encryptToken(refreshed.accessToken),
            tokenExpiry: newExpiry,
            status: 'connected',
            lastError: null,
          },
        });
      } catch (refreshErr) {
        await prisma.emailIntegration.update({
          where: { hotelId },
          data: {
            status: 'error',
            lastError: `OAuth Token Refresh Failed: ${refreshErr.message}`,
          },
        }).catch(() => {});
        throw new Error(`Gmail access expired and could not be refreshed. Please reconnect Gmail. (${refreshErr.message})`);
      }
    }

    return {
      accessToken: rawAccessToken,
      email: integration.email,
      integration,
    };
  },

  /**
   * Builds an RFC 2822 standard email message string
   */
  createMimeMessage({ from, to, subject, bodyText, threadId, inReplyTo, references }) {
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject || 'Message from Hotel', 'utf-8').toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
    ];

    if (inReplyTo) {
      headers.push(`In-Reply-To: ${inReplyTo}`);
    }
    if (references) {
      headers.push(`References: ${references}`);
    } else if (inReplyTo) {
      headers.push(`References: ${inReplyTo}`);
    }

    const emailContent = `${headers.join('\r\n')}\r\n\r\n${bodyText || ''}`;
    // Base64url encode without padding
    return Buffer.from(emailContent, 'utf-8').toString('base64url');
  },

  /**
   * Sends an outbound email to a guest via the hotel's authenticated Gmail account
   */
  async sendGuestGmail({ hotelId, to, subject, bodyText, threadId, inReplyTo, references }) {
    if (!hotelId || !to || !bodyText) {
      throw new Error('hotelId, to recipient, and bodyText are required to send Gmail');
    }

    const { accessToken, email: fromEmail } = await this.getValidAccessTokenForHotel(hotelId);

    const rawMessage = this.createMimeMessage({
      from: fromEmail,
      to,
      subject,
      bodyText,
      threadId,
      inReplyTo,
      references,
    });

    const payload = {
      raw: rawMessage,
    };
    if (threadId) {
      payload.threadId = threadId;
    }

    const res = await fetch(`${GMAIL_API_BASE}/messages/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      const errMsg = data.error?.message || data.error || 'Failed to send message via Gmail API';
      throw new Error(`Gmail API Send Error: ${errMsg}`);
    }

    return {
      success: true,
      messageId: data.id,
      threadId: data.threadId,
      from: fromEmail,
      to,
    };
  },

  /**
   * Fetches unread or recent messages from the hotel's connected Gmail inbox
   */
  async fetchRecentGmailMessages(hotelId, maxResults = 10) {
    const { accessToken } = await this.getValidAccessTokenForHotel(hotelId);

    const listRes = await fetch(`${GMAIL_API_BASE}/messages?maxResults=${maxResults}&q=label:INBOX`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!listRes.ok) {
      const err = await listRes.text();
      throw new Error(`Failed to list messages from Gmail: ${err}`);
    }

    const listData = await listRes.json();
    const messages = listData.messages || [];

    const detailedMessages = [];
    for (const msgSummary of messages) {
      try {
        const msgRes = await fetch(`${GMAIL_API_BASE}/messages/${msgSummary.id}?format=full`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (msgRes.ok) {
          const detail = await msgRes.json();
          const parsed = this.parseGmailMessagePayload(detail);
          detailedMessages.push(parsed);
        }
      } catch (err) {
        console.warn(`[GmailClient] Could not fetch message ${msgSummary.id}:`, err.message);
      }
    }

    return detailedMessages;
  },

  /**
   * Parses raw Gmail message object into clean standardized email format
   */
  parseGmailMessagePayload(gmailMsg) {
    const headers = gmailMsg.payload?.headers || [];
    const getHeader = (name) => {
      const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
      return found ? found.value : '';
    };

    const from = getHeader('From');
    const to = getHeader('To');
    const subject = getHeader('Subject') || 'Guest Inquiry';
    const messageId = getHeader('Message-ID') || getHeader('Message-Id');
    const dateStr = getHeader('Date');

    let bodyText = '';
    if (gmailMsg.snippet) {
      bodyText = gmailMsg.snippet;
    }

    // Try extracting plain text from payload parts if available
    const parts = gmailMsg.payload?.parts || [];
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        try {
          bodyText = Buffer.from(part.body.data, 'base64url').toString('utf-8');
          break;
        } catch (_) {}
      }
    }

    if (!bodyText && gmailMsg.payload?.body?.data) {
      try {
        bodyText = Buffer.from(gmailMsg.payload.body.data, 'base64url').toString('utf-8');
      } catch (_) {}
    }

    return {
      id: gmailMsg.id,
      threadId: gmailMsg.threadId,
      from,
      to,
      subject,
      bodyText,
      messageId,
      date: dateStr,
      historyId: gmailMsg.historyId,
    };
  },
};
