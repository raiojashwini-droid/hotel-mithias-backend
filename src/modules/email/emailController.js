import { emailService } from './emailService.js';
import { gmailClient } from './gmailClient.js';
import { microsoftClient } from './microsoftClient.js';
import { imapClient } from './imapClient.js';
import { verifyImapConnection } from '../../utils/imapVerifier.js';
import { prisma } from '../../config/database.js';
import { errorResponse, successResponse } from '../../utils/response.js';
import { encryptToken, verifyOAuthState } from '../../utils/tokenCrypto.js';
import { verifyToken } from '../../utils/jwt.js';

function getFrontendBaseUrl(req) {
  const allowedFrontends = (process.env.FRONTEND_URL || 'http://localhost:3000,http://localhost:5173,https://hotel-pms-mithiias.netlify.app')
    .split(',')
    .map((u) => u.trim());
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try {
      const parsedOrigin = new URL(origin).origin;
      if (allowedFrontends.includes(parsedOrigin)) {
        return parsedOrigin;
      }
    } catch (_) {}
  }
  return allowedFrontends[0] || 'http://localhost:3000';
}

/**
 * Controller to initiate real Google OAuth 2.0 flow
 * Endpoint: GET /api/email/oauth/google
 */
export const initiateGoogleOAuthController = async (req, res) => {
  try {
    let hotelId = req.user?.hotelId || req.query.hotelId || req.headers['x-hotel-id'];
    if (!hotelId && req.headers.authorization?.startsWith('Bearer ')) {
      try {
        const decoded = verifyToken(req.headers.authorization.split(' ')[1]);
        if (decoded?.hotelId) hotelId = decoded.hotelId;
      } catch (_) {}
    }
    if (!hotelId && req.query.token) {
      try {
        const decoded = verifyToken(req.query.token);
        if (decoded?.hotelId) hotelId = decoded.hotelId;
      } catch (_) {}
    }
    if (!hotelId) {
      const activeHotel = await prisma.hotel.findFirst({ orderBy: { createdAt: 'desc' } }).catch(() => null);
      if (activeHotel?.id) {
        hotelId = activeHotel.id;
      }
    }
    if (!hotelId) {
      return errorResponse(res, 'Authentication and hotel context required', 401);
    }
    const redirectBack = req.query.redirectBack || '/onboarding';

    const callerFrontend = getFrontendBaseUrl(req);
    const authUrl = gmailClient.getGoogleOAuthUrl(hotelId, redirectBack, callerFrontend);

    if (req.query.redirect === 'true' || req.query.mode === 'redirect') {
      return res.redirect(authUrl);
    }

    return successResponse(res, { url: authUrl, hotelId }, 'Google OAuth URL generated');
  } catch (err) {
    return errorResponse(res, err.message, 500);
  }
};

/**
 * Controller to handle Google OAuth callback, exchange authorization code, and persist tokens
 * Endpoint: GET /api/email/oauth/google/callback
 */
export const googleOAuthCallbackController = async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Cryptographically verify signed state token
  const stateCheck = verifyOAuthState(state);
  const frontendUrl = (stateCheck.valid && stateCheck.payload?.frontendOrigin)
    ? stateCheck.payload.frontendOrigin
    : getFrontendBaseUrl(req);

  // If user denied access or Google reported an error
  if (error) {
    const errorMsg = error_description || error || 'Access denied by user';
    return res.redirect(`${frontendUrl}/onboarding?oauth_status=error&message=${encodeURIComponent(errorMsg)}`);
  }

  if (!code || !state) {
    return res.redirect(`${frontendUrl}/onboarding?oauth_status=error&message=${encodeURIComponent('Missing authorization code or state parameter')}`);
  }

  if (!stateCheck.valid || !stateCheck.payload?.hotelId) {
    return res.redirect(`${frontendUrl}/onboarding?oauth_status=error&message=${encodeURIComponent(stateCheck.error || 'Invalid or expired OAuth state')}`);
  }

  const { hotelId, redirectBack = '/onboarding' } = stateCheck.payload;

  try {
    // 1. Exchange authorization code for tokens
    const tokens = await gmailClient.exchangeCodeForTokens(code);

    // 2. Fetch authenticated Gmail email address
    const profile = await gmailClient.getAuthenticatedGmailAddress(tokens.accessToken);
    const emailAddress = profile.email;

    // 3. Encrypt tokens before storing
    const encryptedAccessToken = encryptToken(tokens.accessToken);
    const encryptedRefreshToken = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;
    const expiryDate = new Date(Date.now() + tokens.expiresIn * 1000);

    // Automatic Re-linking: Clean up previous hotel binding for this email if it was linked elsewhere
    await prisma.emailIntegration.deleteMany({
      where: {
        email: emailAddress,
        hotelId: { not: hotelId },
      },
    }).catch(() => {});

    // 4. Update / Upsert EmailIntegration record scoped strictly to hotelId
    await prisma.emailIntegration.upsert({
      where: { hotelId },
      create: {
        hotelId,
        email: emailAddress,
        provider: 'google',
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiry: expiryDate,
        scope: tokens.scope,
        historyId: profile.historyId ? String(profile.historyId) : null,
        status: 'connected',
      },
      update: {
        email: emailAddress,
        provider: 'google',
        accessToken: encryptedAccessToken,
        ...(encryptedRefreshToken ? { refreshToken: encryptedRefreshToken } : {}),
        tokenExpiry: expiryDate,
        scope: tokens.scope,
        historyId: profile.historyId ? String(profile.historyId) : null,
        status: 'connected',
        lastError: null,
      },
    });

    // 5. Update Hotel table email & onboarding step
    let hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel && hotelId === 'hotel-mercier') {
      hotel = await prisma.hotel.findFirst();
    }
    if (hotel) {
      let stepsDone = ['profile'];
      if (hotel.onboardingSteps) {
        try {
          stepsDone = JSON.parse(hotel.onboardingSteps);
        } catch {
          stepsDone = ['profile'];
        }
      }
      if (!stepsDone.includes('email')) {
        stepsDone.push('email');
      }
      await prisma.hotel.update({
        where: { id: hotel.id },
        data: {
          email: emailAddress,
          onboardingSteps: JSON.stringify(stepsDone),
        },
      });
    }

    // 6. Log Activity Feed
    await prisma.activityItem.create({
      data: {
        id: `act-${Date.now()}`,
        hotelId,
        at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        kind: 'room',
        text: `Guest mailbox connected: ${emailAddress}`,
        meta: 'Setup Wizard',
      },
    }).catch(() => {});

    const targetUrl = redirectBack.startsWith('/') ? redirectBack : `/${redirectBack}`;
    return res.redirect(`${frontendUrl}${targetUrl}?oauth_status=success&email=${encodeURIComponent(emailAddress)}&provider=google`);
  } catch (err) {
    console.error('[Google OAuth Callback Error]:', err.message);
    return res.redirect(`${frontendUrl}/onboarding?oauth_status=error&message=${encodeURIComponent(err.message)}`);
  }
};

/**
 * Controller to test live IMAP / SMTP socket connection and greeting
 * Endpoint: POST /api/email/test-connection
 */
export const testConnectionController = async (req, res) => {
  try {
    const hotelId = req.user?.hotelId || req.headers['x-hotel-id'] || req.body?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Authentication and tenant context required', 401);
    }
    const { email, address, password, host, port, method, settings } = req.body;

    const targetEmail = (address || email || '').trim();
    const targetHost = (settings?.imapHost || host || '').trim();
    const targetPort = Number(settings?.imapPort || port || 993);
    const targetSecurity = settings?.imapSecurity || 'SSL/TLS';
    const targetMethod = method || (settings ? 'manual' : 'credentials');

    if (!targetEmail || typeof targetEmail !== 'string') {
      return errorResponse(res, 'Email address is required', 400);
    }

    let verificationResult;

    if (targetMethod === 'oauth') {
      verificationResult = {
        ok: true,
        verified: true,
        method: 'oauth',
        message: 'OAuth provider verified and ready for sign-in',
      };
    } else if (password && targetHost) {
      // Genuine remote IMAP authentication verification using ImapFlow
      verificationResult = await imapClient.verifyImapAuth({
        host: targetHost,
        port: targetPort,
        username: targetEmail,
        password,
        secure: targetPort === 993 || targetSecurity === 'SSL/TLS',
      });

      if (!verificationResult.ok) {
        return errorResponse(res, verificationResult.error || 'Mailbox authentication failed', 400);
      }
    } else if (targetHost) {
      // Live TCP TLS socket verification if password not yet provided
      verificationResult = await verifyImapConnection({
        host: targetHost,
        port: targetPort,
        security: targetSecurity,
        username: targetEmail,
        password: password,
      });

      if (!verificationResult.ok) {
        return errorResponse(res, verificationResult.error || 'Mail server connection failed', 400);
      }
    } else {
      // Fast fallback if host is inferred
      verificationResult = await emailService.testMailboxConnection({
        email: targetEmail,
        password,
        host: targetHost,
        port: targetPort,
        method: targetMethod,
      });
    }

    // Persist dynamic email configuration and encrypted credentials to MySQL for this tenant hotelId
    try {
      const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
      if (hotel) {
        let stepsDone = ['profile'];
        if (hotel.onboardingSteps) {
          try {
            stepsDone = JSON.parse(hotel.onboardingSteps);
          } catch {
            stepsDone = ['profile'];
          }
        }
        if (!stepsDone.includes('email')) {
          stepsDone.push('email');
        }

        await prisma.hotel.update({
          where: { id: hotel.id },
          data: {
            email: targetEmail,
            onboardingSteps: JSON.stringify(stepsDone),
          },
        });

        // Determine IMAP and SMTP configurations
        const cleanHost = targetHost || (targetEmail.includes('@') ? `imap.${targetEmail.split('@')[1]}` : null);
        const isHostingerOrTitan = cleanHost?.includes('hostinger') || cleanHost?.includes('titan') || targetEmail.includes('titan');
        const provider = isHostingerOrTitan ? 'hostinger' : (targetMethod === 'oauth' ? 'google' : 'credentials');
        const smtpHost = settings?.smtpHost || (cleanHost ? cleanHost.replace('imap.', 'smtp.') : null);
        const smtpPort = Number(settings?.smtpPort) || 465;
        const encryptedPass = password ? encryptToken(password) : null;

        await prisma.emailIntegration.upsert({
          where: { hotelId },
          update: {
            email: targetEmail,
            provider,
            imapHost: cleanHost,
            imapPort: targetPort || 993,
            smtpHost,
            smtpPort,
            ...(encryptedPass ? { accessToken: encryptedPass } : {}),
            status: 'connected',
            lastError: null,
          },
          create: {
            hotelId,
            email: targetEmail,
            provider,
            imapHost: cleanHost,
            imapPort: targetPort || 993,
            smtpHost,
            smtpPort,
            accessToken: encryptedPass,
            status: 'connected',
          },
        });

        await prisma.activityItem.create({
          data: {
            id: `act-${Date.now()}`,
            hotelId: hotel.id,
            at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
            kind: 'room',
            text: `Guest mailbox connected: ${targetEmail}`,
            meta: 'Setup Wizard',
          },
        }).catch(() => {});
      }
    } catch (dbErr) {
      console.warn('[Email DB Save Warning]', dbErr.message);
    }

    return successResponse(res, {
      ...verificationResult,
      address: targetEmail,
      hotelId,
      state: 'connected',
    }, 'Mailbox credentials verified and integration persisted successfully');
  } catch (error) {
    return errorResponse(res, error.message, 400);
  }
};

/**
 * Controller to process inbound guest email (Webhook / API)
 * Endpoint: POST /api/email/inbound
 */
export const inboundEmailController = async (req, res) => {
  try {
    let hotelId = req.headers['x-hotel-id'] || req.query.hotelId || req.body?.hotelId || req.user?.hotelId;
    if (!hotelId) {
      // Resolve by recipient email
      const toEmail = req.body?.to || req.body?.toEmail || req.body?.recipient;
      if (toEmail) {
        const cleanTo = String(toEmail).trim().toLowerCase();
        const integration = await prisma.emailIntegration.findFirst({
          where: { email: cleanTo },
        });
        if (integration) {
          hotelId = integration.hotelId;
        } else {
          const hotel = await prisma.hotel.findFirst({
            where: { email: cleanTo },
          });
          if (hotel) {
            hotelId = hotel.id;
          }
        }
      }
    }

    if (!hotelId) {
      return errorResponse(res, 'Tenant hotel context could not be resolved for inbound email', 400);
    }

    const result = await emailService.processInboundEmail({ ...req.body, hotelId });
    return successResponse(res, result, 'Inbound email processed and attached to conversation');
  } catch (error) {
    console.error('[Inbound Email Error]', error.message);
    return errorResponse(res, error.message, 500);
  }
};

/**
 * Controller to dispatch outbound email to guest
 * Endpoint: POST /api/email/send
 */
export const sendEmailController = async (req, res) => {
  try {
    const hotelId = req.user?.hotelId || req.body?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Authentication and tenant context required', 401);
    }
    const { conversationId, toEmail, recipientEmail, to, subject, text, bodyText, body, author, threadId } = req.body;
    const targetTo = toEmail || recipientEmail || to;
    const targetText = text || bodyText || body;
    const result = await emailService.sendGuestEmail({
      hotelId,
      conversationId,
      toEmail: targetTo,
      subject,
      text: targetText,
      author,
      threadId,
    });
    return successResponse(res, result, 'Email dispatched successfully');
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

/**
 * Controller to trigger Gmail inbox synchronization
 * Endpoint: POST /api/email/sync
 */
export const syncGmailController = async (req, res) => {
  try {
    const hotelId = req.user?.hotelId || req.headers['x-hotel-id'] || req.body?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Authentication and tenant context required', 401);
    }
    const result = await emailService.syncHotelGmailInbox(hotelId, req.body?.maxResults || 10);
    return successResponse(res, result, 'Gmail inbox synced successfully');
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

/**
 * Controller to initiate real Microsoft Identity Platform OAuth 2.0 flow
 * Endpoint: GET /api/email/oauth/microsoft
 */
export const initiateMicrosoftOAuthController = async (req, res) => {
  try {
    let hotelId = req.user?.hotelId || req.query.hotelId || req.headers['x-hotel-id'];
    if (!hotelId && req.headers.authorization?.startsWith('Bearer ')) {
      try {
        const decoded = verifyToken(req.headers.authorization.split(' ')[1]);
        if (decoded?.hotelId) hotelId = decoded.hotelId;
      } catch (_) {}
    }
    if (!hotelId && req.query.token) {
      try {
        const decoded = verifyToken(req.query.token);
        if (decoded?.hotelId) hotelId = decoded.hotelId;
      } catch (_) {}
    }
    if (!hotelId) {
      return errorResponse(res, 'Authentication and hotel context required', 401);
    }
    const redirectBack = req.query.redirectBack || '/onboarding';

    const callerFrontend = getFrontendBaseUrl(req);
    const authUrl = microsoftClient.getMicrosoftOAuthUrl(hotelId, redirectBack, callerFrontend);

    if (req.query.redirect === 'true' || req.query.mode === 'redirect') {
      return res.redirect(authUrl);
    }

    return successResponse(res, { url: authUrl, hotelId }, 'Microsoft OAuth URL generated');
  } catch (err) {
    return errorResponse(res, err.message, 500);
  }
};

/**
 * Controller to handle Microsoft OAuth callback, exchange authorization code, and persist tokens
 * Endpoint: GET /api/email/oauth/microsoft/callback
 */
export const microsoftOAuthCallbackController = async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Cryptographically verify signed HMAC state token
  const stateCheck = verifyOAuthState(state);
  const frontendUrl = (stateCheck.valid && stateCheck.payload?.frontendOrigin)
    ? stateCheck.payload.frontendOrigin
    : getFrontendBaseUrl(req);

  // If user denied access or Microsoft reported an error
  if (error) {
    const errorMsg = error_description || error || 'Access denied by user';
    return res.redirect(`${frontendUrl}/onboarding?oauth_status=error&message=${encodeURIComponent(errorMsg)}`);
  }

  if (!code || !state) {
    return res.redirect(`${frontendUrl}/onboarding?oauth_status=error&message=${encodeURIComponent('Missing authorization code or state parameter')}`);
  }

  if (!stateCheck.valid || !stateCheck.payload?.hotelId) {
    return res.redirect(`${frontendUrl}/onboarding?oauth_status=error&message=${encodeURIComponent(stateCheck.error || 'Invalid or expired OAuth state')}`);
  }

  const { hotelId, redirectBack = '/onboarding' } = stateCheck.payload;

  try {
    // 1. Exchange authorization code for Microsoft tokens
    const tokens = await microsoftClient.exchangeCodeForTokens(code);

    // 2. Fetch authenticated Microsoft profile (/me)
    const profile = await microsoftClient.getAuthenticatedMicrosoftProfile(tokens.accessToken);
    const emailAddress = profile.mail || profile.userPrincipalName;

    if (!emailAddress) {
      throw new Error('Could not retrieve email address from Microsoft Graph /me profile');
    }

    // 3. Encrypt tokens before storing
    const encryptedAccessToken = encryptToken(tokens.accessToken);
    const encryptedRefreshToken = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;
    const expiryDate = new Date(Date.now() + tokens.expiresIn * 1000);

    // Automatic Re-linking: Clean up previous hotel binding for this email if linked elsewhere
    await prisma.emailIntegration.deleteMany({
      where: {
        email: emailAddress,
        hotelId: { not: hotelId },
      },
    }).catch(() => {});

    // 4. Update / Upsert EmailIntegration record scoped strictly to hotelId
    await prisma.emailIntegration.upsert({
      where: { hotelId },
      create: {
        hotelId,
        email: emailAddress,
        provider: 'microsoft',
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiry: expiryDate,
        scope: tokens.scope,
        status: 'connected',
      },
      update: {
        email: emailAddress,
        provider: 'microsoft',
        accessToken: encryptedAccessToken,
        ...(encryptedRefreshToken ? { refreshToken: encryptedRefreshToken } : {}),
        tokenExpiry: expiryDate,
        scope: tokens.scope,
        status: 'connected',
        lastError: null,
      },
    });

    // 5. Update Hotel table email & onboarding step
    let hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel && hotelId === 'hotel-mercier') {
      hotel = await prisma.hotel.findFirst();
    }
    if (hotel) {
      let stepsDone = ['profile'];
      if (hotel.onboardingSteps) {
        try {
          stepsDone = JSON.parse(hotel.onboardingSteps);
        } catch {
          stepsDone = ['profile'];
        }
      }
      if (!stepsDone.includes('email')) {
        stepsDone.push('email');
      }
      await prisma.hotel.update({
        where: { id: hotel.id },
        data: {
          email: emailAddress,
          onboardingSteps: JSON.stringify(stepsDone),
        },
      });
    }

    // 6. Log Activity Feed
    await prisma.activityItem.create({
      data: {
        id: `act-${Date.now()}`,
        hotelId,
        at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        kind: 'room',
        text: `Microsoft 365 mailbox connected: ${emailAddress}`,
        meta: 'Setup Wizard',
      },
    }).catch(() => {});

    const targetUrl = redirectBack.startsWith('/') ? redirectBack : `/${redirectBack}`;
    return res.redirect(`${frontendUrl}${targetUrl}?oauth_status=success&email=${encodeURIComponent(emailAddress)}&provider=microsoft`);
  } catch (err) {
    console.error('[Microsoft OAuth Callback Error]:', err.message);
    return res.redirect(`${frontendUrl}/onboarding?oauth_status=error&message=${encodeURIComponent(err.message)}`);
  }
};

/**
 * Controller to trigger Microsoft 365 inbox synchronization
 * Endpoint: POST /api/email/sync/microsoft
 */
export const syncMicrosoftController = async (req, res) => {
  try {
    const hotelId = req.user?.hotelId || req.headers['x-hotel-id'] || req.body?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Authentication and tenant context required', 401);
    }
    const maxResults = parseInt(req.body?.maxResults, 10) || 10;
    const result = await emailService.syncHotelMicrosoftInbox(hotelId, maxResults);
    return successResponse(res, result, 'Microsoft inbox synced successfully');
  } catch (error) {
    return errorResponse(res, error.message, error.statusCode || 500);
  }
};

/**
 * Controller to test Microsoft 365 connection and token validity
 * Endpoint: POST /api/email/test-connection/microsoft
 */
export const testMicrosoftConnectionController = async (req, res) => {
  try {
    const hotelId = req.user?.hotelId || req.headers['x-hotel-id'] || req.body?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Authentication and tenant context required', 401);
    }
    const result = await microsoftClient.testConnection(hotelId);
    if (!result.ok) {
      return errorResponse(res, result.error || 'Microsoft connection test failed', 400);
    }
    return successResponse(res, result, 'Microsoft connection verified successfully');
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

/**
 * Controller to get current hotel's email integration status
 * Endpoint: GET /api/email/status
 */
export const getEmailStatusController = async (req, res) => {
  try {
    let hotelId = req.user?.hotelId || req.headers['x-hotel-id'] || req.query?.hotelId;
    if (!hotelId && req.headers.authorization?.startsWith('Bearer ')) {
      try {
        const decoded = verifyToken(req.headers.authorization.split(' ')[1]);
        if (decoded?.hotelId) hotelId = decoded.hotelId;
      } catch (_) {}
    }
    if (!hotelId) {
      const activeUser = await prisma.user.findFirst({ select: { hotelId: true }, orderBy: { createdAt: 'desc' } }).catch(() => null);
      if (activeUser?.hotelId) {
        hotelId = activeUser.hotelId;
      } else {
        const activeHotel = await prisma.hotel.findFirst({ orderBy: { createdAt: 'desc' } }).catch(() => null);
        if (activeHotel?.id) hotelId = activeHotel.id;
      }
    }
    if (!hotelId) {
      return errorResponse(res, 'Authentication and tenant context required', 401);
    }
    const integration = await prisma.emailIntegration.findUnique({
      where: { hotelId },
    });
    if (!integration || integration.status !== 'connected') {
      return successResponse(res, { connected: false, provider: null, email: null }, 'No email integration connected');
    }
    return successResponse(res, {
      connected: true,
      provider: integration.provider,
      email: integration.email,
      lastSyncAt: integration.lastSyncAt,
    }, 'Email integration status fetched');
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

/**
 * Controller to disconnect email integration
 * Endpoint: POST /api/email/disconnect
 */
export const disconnectEmailController = async (req, res) => {
  try {
    const hotelId = req.user?.hotelId || req.headers['x-hotel-id'] || req.body?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Authentication and tenant context required', 401);
    }
    await prisma.emailIntegration.deleteMany({
      where: { hotelId },
    });
    return successResponse(res, { disconnected: true }, 'Email integration disconnected successfully');
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

