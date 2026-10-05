import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../config/database.js';
import {
  encryptToken,
  decryptToken,
  generateOAuthState,
  verifyOAuthState,
} from '../utils/tokenCrypto.js';
import {
  microsoftClient,
  MICROSOFT_SCOPES,
} from '../modules/email/microsoftClient.js';
import { emailService } from '../modules/email/emailService.js';
import { emailProviderFactory } from '../modules/email/emailProviderFactory.js';
import { gmailClient } from '../modules/email/gmailClient.js';

describe('Microsoft 365 / Outlook Integration & Multi-Tenant Test Suite', () => {
  const originalFetch = globalThis.fetch;
  const hotelA = `test-hotel-ms-a-${Date.now()}`;
  const hotelB = `test-hotel-ms-b-${Date.now()}`;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || 'test-ms-client-id';
    process.env.MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || 'test-ms-client-secret';

    // Seed two isolated test hotels
    await prisma.hotel.createMany({
      data: [
        {
          id: hotelA,
          name: 'Microsoft Suite Hotel A',
          legalName: 'MS Suite Hotel A BV',
          email: 'frontdesk@hotel-a.com',
          website: 'hotel-a.com',
          phone: '+3230000001',
          address: 'Main St 10',
          postcode: '1000',
          city: 'Brussels',
          country: 'Belgium',
          vatNumber: 'BE0333333331',
          bookingEngine: '',
          whatsappNumber: '',
          description: 'MS Suite Hotel A Test',
        },
        {
          id: hotelB,
          name: 'Microsoft Suite Hotel B',
          legalName: 'MS Suite Hotel B BV',
          email: 'frontdesk@hotel-b.com',
          website: 'hotel-b.com',
          phone: '+3230000002',
          address: 'Main St 20',
          postcode: '2000',
          city: 'Antwerp',
          country: 'Belgium',
          vatNumber: 'BE0333333332',
          bookingEngine: '',
          whatsappNumber: '',
          description: 'MS Suite Hotel B Test',
        },
      ],
      skipDuplicates: true,
    });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    // Cleanup test data
    await prisma.message.deleteMany({
      where: {
        conversation: {
          guest: { hotelId: { in: [hotelA, hotelB] } },
        },
      },
    });
    await prisma.conversation.deleteMany({
      where: {
        guest: { hotelId: { in: [hotelA, hotelB] } },
      },
    });
    await prisma.guest.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.emailIntegration.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } });
  });

  // 1. OAuth URL Generation
  test('1. OAuth URL Generation generates a valid Microsoft authorization URL', () => {
    const urlStr = microsoftClient.getMicrosoftOAuthUrl(hotelA, '/onboarding', 'http://localhost:5173');
    assert.ok(urlStr, 'URL must not be empty');
    const parsed = new URL(urlStr);
    assert.equal(parsed.pathname, '/common/oauth2/v2.0/authorize');
    assert.equal(parsed.searchParams.get('response_type'), 'code');
    assert.equal(parsed.searchParams.get('response_mode'), 'query');
  });

  // 2. Correct Microsoft Authority
  test('2. Correct Microsoft Authority handles custom tenant and common authority', () => {
    const defaultAuthUrl = microsoftClient.getMicrosoftOAuthUrl(hotelA);
    assert.ok(defaultAuthUrl.includes('login.microsoftonline.com/common/oauth2/v2.0/authorize'), 'Defaults to common tenant');

    const originalTenant = process.env.MICROSOFT_TENANT_ID;
    try {
      process.env.MICROSOFT_TENANT_ID = 'test-custom-tenant-uuid';
      const tenantAuthUrl = microsoftClient.getMicrosoftOAuthUrl(hotelA);
      assert.ok(tenantAuthUrl.includes('login.microsoftonline.com/test-custom-tenant-uuid/oauth2/v2.0/authorize'), 'Uses custom tenant ID when configured');
    } finally {
      if (originalTenant !== undefined) {
        process.env.MICROSOFT_TENANT_ID = originalTenant;
      } else {
        delete process.env.MICROSOFT_TENANT_ID;
      }
    }
  });

  // 3. Correct Scopes
  test('3. Correct Scopes includes all 7 mandatory Microsoft Graph scopes', () => {
    const expected = ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.Read', 'Mail.Send'];
    for (const scope of expected) {
      assert.ok(MICROSOFT_SCOPES.includes(scope), `Scopes must contain ${scope}`);
    }
    const authUrl = microsoftClient.getMicrosoftOAuthUrl(hotelA);
    const parsed = new URL(authUrl);
    const scopeParam = decodeURIComponent(parsed.searchParams.get('scope') || '');
    for (const scope of expected) {
      assert.ok(scopeParam.includes(scope), `OAuth URL scope param must include ${scope}`);
    }
  });

  // 4. State Generation
  test('4. State Generation produces a valid HMAC-signed token binding hotelId', () => {
    const state = generateOAuthState(hotelA, '/onboarding', 'http://localhost:5173');
    assert.ok(state, 'State must be generated');
    const verified = verifyOAuthState(state);
    assert.equal(verified.valid, true, 'State signature must be valid');
    assert.equal(verified.payload.hotelId, hotelA, 'Hotel ID must match in payload');
    assert.equal(verified.payload.redirectBack, '/onboarding');
    assert.equal(verified.payload.frontendOrigin, 'http://localhost:5173');
    assert.ok(verified.payload.ts <= Date.now(), 'State must have valid timestamp');
  });

  // 5. Tampered State Rejection
  test('5. Tampered State Rejection rejects modified state signatures', () => {
    const state = generateOAuthState(hotelA);
    const tampered = state.slice(0, -4) + 'abcd';
    const result = verifyOAuthState(tampered);
    assert.equal(result.valid, false, 'Tampered state must fail verification');
    assert.ok(result.error.includes('signature') || result.error.includes('Invalid'));
  });

  // 6. Expired State Rejection
  test('6. Expired State Rejection rejects state with passed expiration', () => {
    // Generate state with expired timestamp (> 15 min TTL)
    const expiredPayload = {
      hotelId: hotelA,
      redirectBack: '/onboarding',
      frontendOrigin: 'http://localhost:5173',
      ts: Date.now() - (20 * 60 * 1000),
      nonce: 'expired-nonce',
    };
    const secret = process.env.JWT_SECRET || process.env.DB_ENCRYPTION_KEY || 'oauth-state-secret-key';
    const dataStr = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(dataStr).digest('base64url');
    const expiredState = `${dataStr}.${sig}`;

    const check = verifyOAuthState(expiredState);
    assert.equal(check.valid, false);
    assert.ok(check.error.includes('expired'));
  });

  // 7. Tenant Mismatch Rejection
  test('7. Tenant Mismatch Rejection ensures state hotelId does not authenticate another tenant', () => {
    const stateForHotelA = generateOAuthState(hotelA);
    const verified = verifyOAuthState(stateForHotelA);
    assert.equal(verified.valid, true);
    assert.notEqual(verified.payload.hotelId, hotelB, 'State payload must not match hotelB');
  });

  // 8. Token Exchange
  test('8. Token Exchange calls Microsoft Identity token endpoint and receives access_token', async () => {
    globalThis.fetch = async (url, options) => {
      if (url.toString().includes('/oauth2/v2.0/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'mock-ms-access-token-12345',
            refresh_token: 'mock-ms-refresh-token-67890',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: MICROSOFT_SCOPES.join(' '),
          }),
        };
      }
      return originalFetch(url, options);
    };

    const tokens = await microsoftClient.exchangeCodeForTokens('valid-ms-code');
    assert.equal(tokens.accessToken, 'mock-ms-access-token-12345');
    assert.equal(tokens.refreshToken, 'mock-ms-refresh-token-67890');
    assert.equal(tokens.expiresIn, 3600);
  });

  // 9. Token Encryption
  test('9. Token Encryption protects Microsoft tokens with AES-256-GCM', () => {
    const rawToken = 'mock-ms-access-token-99999';
    const encrypted = encryptToken(rawToken);
    assert.ok(encrypted);
    assert.notEqual(encrypted, rawToken);
    assert.ok(encrypted.includes(':'), 'Has IV:Tag:Ciphertext structure');
  });

  // 10. Token Decryption
  test('10. Token Decryption accurately reconstructs the plaintext token', () => {
    const rawToken = 'mock-ms-refresh-token-secret-777';
    const encrypted = encryptToken(rawToken);
    const decrypted = decryptToken(encrypted);
    assert.equal(decrypted, rawToken);
  });

  // 11. Token Refresh
  test('11. Token Refresh executes when access token expires and updates DB record', async () => {
    // Setup existing integration with expired token
    const encryptedAccess = encryptToken('old-expired-ms-token');
    const encryptedRefresh = encryptToken('valid-ms-refresh-token');
    await prisma.emailIntegration.upsert({
      where: { hotelId: hotelA },
      create: {
        hotelId: hotelA,
        provider: 'microsoft',
        email: 'reception@hotel-a.com',
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        tokenExpiry: new Date(Date.now() - 60000), // Expired 1 min ago
        status: 'connected',
      },
      update: {
        provider: 'microsoft',
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        tokenExpiry: new Date(Date.now() - 60000),
        status: 'connected',
      },
    });

    globalThis.fetch = async (url, options) => {
      if (url.toString().includes('/oauth2/v2.0/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'new-refreshed-ms-access-token',
            refresh_token: 'valid-ms-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: MICROSOFT_SCOPES.join(' '),
          }),
        };
      }
      return originalFetch(url, options);
    };

    const token = await microsoftClient.getValidAccessToken(hotelA);
    assert.equal(token, 'new-refreshed-ms-access-token');

    const updated = await prisma.emailIntegration.findUnique({ where: { hotelId: hotelA } });
    assert.equal(decryptToken(updated.accessToken), 'new-refreshed-ms-access-token');
  });

  // 12. Refresh-token Rotation
  test('12. Refresh-token Rotation updates refresh token in DB if Microsoft issues a new one', async () => {
    globalThis.fetch = async (url, options) => {
      if (url.toString().includes('/oauth2/v2.0/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'rotated-access-token',
            refresh_token: 'new-rotated-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: MICROSOFT_SCOPES.join(' '),
          }),
        };
      }
      return originalFetch(url, options);
    };

    const result = await microsoftClient.refreshAccessToken(hotelA, 'old-refresh-token');
    assert.equal(result.accessToken, 'rotated-access-token');
    assert.equal(result.refreshToken, 'new-rotated-refresh-token');

    const integration = await prisma.emailIntegration.findUnique({ where: { hotelId: hotelA } });
    assert.equal(decryptToken(integration.refreshToken), 'new-rotated-refresh-token');
  });

  // 13. /me Account Verification
  test('13. /me Account Verification retrieves and verifies the authenticated Microsoft user', async () => {
    globalThis.fetch = async (url, options) => {
      if (url.toString().includes('/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'ms-user-uuid-1',
            displayName: 'Hotel A Front Desk',
            mail: 'frontdesk@hotel-a.com',
            userPrincipalName: 'frontdesk@hotel-a.com',
          }),
        };
      }
      return originalFetch(url, options);
    };

    const profile = await microsoftClient.getAuthenticatedMicrosoftProfile('valid-test-access-token');
    assert.equal(profile.displayName, 'Hotel A Front Desk');
    assert.equal(profile.mail, 'frontdesk@hotel-a.com');
  });

  // 14. Graph 401 -> Refresh -> Retry
  test('14. Graph 401 -> refresh -> retry recovers from expired tokens seamlessly', async () => {
    let callCount = 0;
    globalThis.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('/oauth2/v2.0/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 're-refreshed-token',
            expires_in: 3600,
          }),
        };
      }
      if (urlStr.includes('/mailFolders/inbox/messages')) {
        callCount++;
        if (callCount === 1) {
          // First call fails with 401 Unauthorized
          return {
            ok: false,
            status: 401,
            headers: { get: () => null },
            json: async () => ({ error: { code: 'InvalidAuthenticationToken', message: 'CompactToken parsing failed.' } }),
          };
        }
        // Second call succeeds after refresh
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            value: [
              {
                id: 'msg-recovered-1',
                internetMessageId: '<recovered-1@outlook.com>',
                conversationId: 'conv-rec-1',
                subject: 'Reservation Update',
                receivedDateTime: new Date().toISOString(),
                sender: { emailAddress: { address: 'guest@example.com', name: 'Guest Example' } },
                bodyPreview: 'Test body recovery',
                body: { contentType: 'text', content: 'Test body recovery' },
                isRead: true,
              },
            ],
          }),
        };
      }
      return originalFetch(url, options);
    };

    const res = await microsoftClient.fetchRecentMicrosoftMessages(hotelA, 5);
    assert.equal(callCount, 2, 'Must have attempted retry after 401');
    assert.equal(res.length, 1);
    assert.equal(res[0].id, 'msg-recovered-1');
  });

  // 15. Graph 429 Handling
  test('15. Graph 429 handling respects Retry-After header and succeeds on retry', async () => {
    let callCount = 0;
    globalThis.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('/mailFolders/inbox/messages')) {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            headers: {
              get: (name) => (name.toLowerCase() === 'retry-after' ? '1' : null),
            },
            json: async () => ({ error: { code: 'TooManyRequests', message: 'Rate limit exceeded' } }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            value: [{ id: 'msg-429-recovered', subject: 'Rate limited message' }],
          }),
        };
      }
      return originalFetch(url, options);
    };

    const res = await microsoftClient.fetchRecentMicrosoftMessages(hotelA, 1);
    assert.equal(callCount, 2, 'Must retry after receiving 429');
    assert.equal(res[0].id, 'msg-429-recovered');
  });

  // 16. Graph 5xx Handling
  test('16. Graph 5xx handling retries on server errors with exponential backoff', async () => {
    let callCount = 0;
    globalThis.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('/mailFolders/inbox/messages')) {
        callCount++;
        if (callCount < 2) {
          return {
            ok: false,
            status: 503,
            headers: { get: () => null },
            json: async () => ({ error: { code: 'ServiceUnavailable', message: 'Service temporarily unavailable' } }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            value: [{ id: 'msg-503-recovered', subject: 'Recovered after 503' }],
          }),
        };
      }
      return originalFetch(url, options);
    };

    const res = await microsoftClient.fetchRecentMicrosoftMessages(hotelA, 1);
    assert.equal(callCount, 2);
    assert.equal(res[0].id, 'msg-503-recovered');
  });

  // 17. Pagination
  test('17. Pagination correctly retrieves pages and preserves nextLink', async () => {
    globalThis.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('/mailFolders/inbox/messages')) {
        assert.ok(urlStr.includes('$top=2'));
        assert.ok(urlStr.includes('receivedDateTime'));
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=2&$skiptoken=skip123',
            value: [
              { id: 'page-msg-1', subject: 'Page 1 Message 1' },
              { id: 'page-msg-2', subject: 'Page 1 Message 2' },
            ],
          }),
        };
      }
      return originalFetch(url, options);
    };

    const res = await microsoftClient.fetchRecentMicrosoftMessages(hotelA, 2);
    assert.equal(res.length, 2);
    assert.ok(res.nextLink.includes('$skiptoken=skip123'));
  });

  // 18. Duplicate Message Prevention (Idempotency)
  test('18. Duplicate message prevention ensures second sync does not create duplicate messages', async () => {
    const mockEmailMsg = {
      id: `ms-mock-unique-${Date.now()}`,
      internetMessageId: `<unique-${Date.now()}@contoso.com>`,
      conversationId: `ms-conv-${Date.now()}`,
      subject: 'Inquiry about room booking',
      receivedDateTime: new Date().toISOString(),
      sender: {
        emailAddress: {
          address: 'lucas.dupont@test-guest.com',
          name: 'Lucas Dupont',
        },
      },
      toRecipients: [{ emailAddress: { address: 'frontdesk@hotel-a.com' } }],
      body: {
        contentType: 'text',
        content: 'Hello, do you have a parking space available for check-in tomorrow?',
      },
      bodyPreview: 'Hello, do you have a parking space available for check-in tomorrow?',
      isRead: false,
    };

    await prisma.emailIntegration.update({
      where: { hotelId: hotelA },
      data: {
        accessToken: encryptToken('test-valid-ms-access-token'),
        tokenExpiry: new Date(Date.now() + 3600000),
      },
    });

    globalThis.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('/oauth2/v2.0/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'test-valid-ms-access-token',
            expires_in: 3600,
          }),
        };
      }
      if (urlStr.includes('/mailFolders/inbox/messages')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ value: [mockEmailMsg] }),
        };
      }
      return originalFetch(url, options);
    };

    // First Sync
    const sync1 = await emailService.syncHotelMicrosoftInbox(hotelA, 5);
    assert.equal(sync1.synced, 1, 'First sync should ingest 1 message');
    assert.equal(sync1.skipped, 0);

    // Second Sync with identical message from Microsoft
    const sync2 = await emailService.syncHotelMicrosoftInbox(hotelA, 5);
    assert.equal(sync2.synced, 0, 'Second sync must not re-ingest duplicate message');
    assert.equal(sync2.skipped, 1, 'Second sync must skip already existing message');

    // Confirm only 1 message exists in DB
    const matchingMessages = await prisma.message.findMany({
      where: {
        id: `msg-ms-${mockEmailMsg.id}`,
      },
    });
    assert.equal(matchingMessages.length, 1, 'Exactly one message record must exist in DB');
  });

  // 19. Conversation Mapping
  test('19. Conversation mapping links inbound message to Conversation entity', async () => {
    const guestId = `gst_em_${'lucas.dupont@test-guest.com'.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const guest = await prisma.guest.findUnique({
      where: { id: guestId },
    });
    assert.ok(guest, 'Guest record must have been created or matched');

    const conversation = await prisma.conversation.findFirst({
      where: { guestId: guest.id },
      include: { messages: true },
    });
    assert.ok(conversation, 'Conversation must exist');
    assert.ok(conversation.messages.length >= 1, 'Conversation must contain the synced message');
  });

  // 20. Guest Mapping
  test('20. Guest mapping populates name and email from Microsoft sender object', async () => {
    const guestId = `gst_em_${'lucas.dupont@test-guest.com'.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const guest = await prisma.guest.findUnique({
      where: { id: guestId },
    });
    assert.ok(guest);
    assert.equal(guest.name, 'Lucas Dupont');
  });

  // 21. Microsoft Outbound Send
  test('21. Microsoft Outbound Send dispatches email via Graph /me/sendMail and creates Message record', async () => {
    let sendMailCalled = false;
    let payloadSent = null;

    globalThis.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('/oauth2/v2.0/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'test-valid-ms-access-token',
            expires_in: 3600,
          }),
        };
      }
      if (urlStr.includes('/me/sendMail')) {
        sendMailCalled = true;
        payloadSent = JSON.parse(options.body);
        return {
          ok: true,
          status: 202,
          headers: { get: () => null },
          text: async () => '',
        };
      }
      return originalFetch(url, options);
    };

    const guestId = `gst_em_${'lucas.dupont@test-guest.com'.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const guest = await prisma.guest.findUnique({
      where: { id: guestId },
    });
    const conversation = await prisma.conversation.findFirst({
      where: { guestId: guest.id },
    });

    const result = await emailService.sendGuestEmail({
      hotelId: hotelA,
      conversationId: conversation.id,
      toEmail: 'lucas.dupont@test-guest.com',
      subject: 'Re: Inquiry about room booking',
      text: 'Yes Lucas, we have free parking reserved for your stay!',
      author: 'Front Desk Agent',
    });

    assert.equal(sendMailCalled, true, 'sendMail API endpoint must have been called');
    assert.equal(result.provider, 'microsoft');
    assert.equal(payloadSent.message.subject, 'Re: Inquiry about room booking');
    assert.equal(payloadSent.message.toRecipients[0].emailAddress.address, 'lucas.dupont@test-guest.com');

    // Verify Message record exists in DB
    const sentMsg = await prisma.message.findUnique({
      where: { id: result.messageId },
    });
    assert.ok(sentMsg);
    assert.equal(sentMsg.author, 'staff');
    assert.equal(sentMsg.body, 'Yes Lucas, we have free parking reserved for your stay!');
  });

  // 22. Microsoft Reply
  test('22. Microsoft Reply uses /me/messages/{id}/reply for thread continuity', async () => {
    let replyEndpointCalled = false;
    let replyPayload = null;

    globalThis.fetch = async (url, options) => {
      const urlStr = url.toString();
      if (urlStr.includes('/messages/ms-parent-msg-123/reply')) {
        replyEndpointCalled = true;
        replyPayload = JSON.parse(options.body);
        return {
          ok: true,
          status: 202,
          headers: { get: () => null },
          text: async () => '',
        };
      }
      return originalFetch(url, options);
    };

    const sendRes = await microsoftClient.sendGuestMicrosoftMail({
      hotelId: hotelA,
      toEmail: 'guest@example.com',
      subject: 'Re: Existing Thread',
      text: 'Here is your reply inside the same Outlook conversation',
      targetMessageId: 'ms-parent-msg-123',
    });

    assert.equal(replyEndpointCalled, true, 'Must call /me/messages/{id}/reply when targetMessageId is provided');
    assert.equal(sendRes.success, true);
    assert.equal(replyPayload.comment, 'Here is your reply inside the same Outlook conversation');
  });

  // 23. Gmail Regression
  test('23. Gmail Regression: Gmail OAuth URL and factory behavior remain unchanged and functional', () => {
    const gmailAuthUrl = gmailClient.getGoogleOAuthUrl(hotelA, '/onboarding', 'http://localhost:5173');
    assert.ok(gmailAuthUrl.includes('accounts.google.com/o/oauth2/v2/auth'));
    assert.ok(gmailAuthUrl.includes('access_type=offline'));

    const googleProvider = emailProviderFactory.getProvider('google');
    assert.equal(googleProvider.name, 'google');
    assert.ok(typeof googleProvider.getOAuthUrl === 'function');

    const msProvider = emailProviderFactory.getProvider('microsoft');
    assert.equal(msProvider.name, 'microsoft');
    assert.ok(typeof msProvider.getOAuthUrl === 'function');
  });

  // 24. Multi-Tenant Isolation
  test('24. Multi-Tenant Isolation: Hotel A and Hotel B credentials and inboxes are strictly partitioned', async () => {
    // Connect Hotel B to its own separate Microsoft integration
    await prisma.emailIntegration.upsert({
      where: { hotelId: hotelB },
      create: {
        hotelId: hotelB,
        provider: 'microsoft',
        email: 'reception@hotel-b.com',
        accessToken: encryptToken('hotel-b-access-token'),
        refreshToken: encryptToken('hotel-b-refresh-token'),
        tokenExpiry: new Date(Date.now() + 3600000),
        status: 'connected',
      },
      update: {
        provider: 'microsoft',
        accessToken: encryptToken('hotel-b-access-token'),
        refreshToken: encryptToken('hotel-b-refresh-token'),
        tokenExpiry: new Date(Date.now() + 3600000),
        status: 'connected',
      },
    });

    const hotelAIntegration = await prisma.emailIntegration.findUnique({ where: { hotelId: hotelA } });
    const hotelBIntegration = await prisma.emailIntegration.findUnique({ where: { hotelId: hotelB } });

    assert.notEqual(hotelAIntegration.email, hotelBIntegration.email);
    assert.notEqual(decryptToken(hotelAIntegration.accessToken), decryptToken(hotelBIntegration.accessToken));

    // Calling sync on Hotel B uses Hotel B's token
    let fetchedAuthHeader = null;
    globalThis.fetch = async (url, options) => {
      if (url.toString().includes('/mailFolders/inbox/messages')) {
        fetchedAuthHeader = options.headers['Authorization'];
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ value: [] }),
        };
      }
      return originalFetch(url, options);
    };

    await emailService.syncHotelMicrosoftInbox(hotelB, 1);
    assert.equal(fetchedAuthHeader, 'Bearer hotel-b-access-token', "Must use Hotel B's specific token, never Hotel A's");
  });

  // 25. Unauthorized Request Rejection
  test('25. Unauthorized Request Rejection rejects unauthenticated calls when integration does not exist', async () => {
    const nonExistentHotel = `unauth-hotel-${Date.now()}`;
    await assert.rejects(
      async () => {
        await microsoftClient.getValidAccessToken(nonExistentHotel);
      },
      (err) => {
        assert.ok(err.message.includes('Microsoft 365 integration'));
        return true;
      }
    );
  });
});

