import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { prisma } from '../../config/database.js';
import { decryptToken } from '../../utils/tokenCrypto.js';

/**
 * IMAP client utility for Hostinger / Titan and standard credentials mailboxes
 */
export const imapClient = {
  /**
   * Genuine test of remote IMAP authentication credentials using ImapFlow
   */
  async verifyImapAuth({ host, port = 993, username, password, secure = true }) {
    if (!host || !username || !password) {
      return { ok: false, error: 'Host, username, and password are required' };
    }

    const client = new ImapFlow({
      host: host.trim(),
      port: Number(port) || 993,
      secure: secure !== false,
      auth: {
        user: username.trim(),
        pass: password,
      },
      logger: false,
      emitLogs: false,
    });

    try {
      await client.connect();
      await client.logout();
      return { ok: true, message: 'IMAP authentication successful' };
    } catch (err) {
      try {
        await client.logout();
      } catch (_) {}
      console.warn(`[IMAP Verification Error] ${username} on ${host}:`, err.message);
      return { ok: false, error: err.message || 'IMAP authentication failed' };
    }
  },

  /**
   * Fetch recent messages from IMAP mailbox for a tenant hotel
   */
  async fetchRecentImapMessages(hotelId, maxResults = 10) {
    if (!hotelId) return [];

    const integration = await prisma.emailIntegration.findUnique({
      where: { hotelId },
    });

    if (!integration || !integration.accessToken || integration.status !== 'connected') {
      return [];
    }

    // Only handle credentials or hostinger provider
    if (integration.provider !== 'credentials' && integration.provider !== 'hostinger') {
      return [];
    }

    const decryptedPassword = decryptToken(integration.accessToken);
    if (!decryptedPassword) {
      console.warn(`[IMAP Client] Could not decrypt password for hotel ${hotelId}`);
      return [];
    }

    const host = integration.imapHost || `imap.${integration.email.split('@')[1]}`;
    const port = integration.imapPort || 993;
    const isSecure = port === 993;

    const client = new ImapFlow({
      host,
      port,
      secure: isSecure,
      auth: {
        user: integration.email,
        pass: decryptedPassword,
      },
      logger: false,
      emitLogs: false,
    });

    const messages = [];

    try {
      await client.connect();

      const lock = await client.getMailboxLock('INBOX');
      try {
        // Fetch recent messages sequence (last maxResults)
        const status = client.mailbox;
        const total = status.exists || 0;
        if (total > 0) {
          const startSeq = Math.max(1, total - maxResults + 1);
          const range = `${startSeq}:${total}`;

          for await (const message of client.fetch(range, { envelope: true, source: true })) {
            try {
              const parsed = await simpleParser(message.source);
              messages.push({
                id: message.uid ? `imap-${message.uid}` : `imap-${message.seq}`,
                from: parsed.from?.text || integration.email,
                to: parsed.to?.text || integration.email,
                subject: parsed.subject || 'No Subject',
                bodyText: parsed.text || parsed.html || '',
                date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
              });
            } catch (parseErr) {
              console.warn('[IMAP Parser Warning]:', parseErr.message);
            }
          }
        }
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      try {
        await client.logout();
      } catch (_) {}
      console.warn(`[IMAP Client Error for hotel ${hotelId}]:`, err.message);
    }

    return messages;
  },
};
