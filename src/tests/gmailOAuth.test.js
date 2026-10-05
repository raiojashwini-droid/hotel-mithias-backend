import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../config/database.js';
import { encryptToken, decryptToken, generateOAuthState, verifyOAuthState } from '../utils/tokenCrypto.js';
import { gmailClient, GMAIL_SCOPES } from '../modules/email/gmailClient.js';
import { emailService } from '../modules/email/emailService.js';
import { sendBrevoInvitationEmail } from '../utils/mailer.js';

describe('Real Google Gmail OAuth 2.0 & Multi-Tenant Integration Test Suite', () => {
  const hotelA = `test-hotel-gmail-a-${Date.now()}`;
  const hotelB = `test-hotel-gmail-b-${Date.now()}`;

  before(async () => {
    // Seed isolated test hotels
    await prisma.hotel.createMany({
      data: [
        {
          id: hotelA,
          name: 'Grand Hotel Alpha',
          legalName: 'Alpha Hotels BV',
          email: 'reception@hotel-alpha.com',
          website: 'hotel-alpha.com',
          phone: '+3232274101',
          address: 'Alpha St 1',
          postcode: '2000',
          city: 'Antwerp',
          country: 'Belgium',
          vatNumber: 'BE0111111111',
          bookingEngine: '',
          whatsappNumber: '',
          description: 'Alpha Luxury Hotel',
        },
        {
          id: hotelB,
          name: 'Royal Hotel Beta',
          legalName: 'Beta Hotels BV',
          email: 'reception@hotel-beta.com',
          website: 'hotel-beta.com',
          phone: '+3232274102',
          address: 'Beta Ave 2',
          postcode: '1000',
          city: 'Brussels',
          country: 'Belgium',
          vatNumber: 'BE0222222222',
          bookingEngine: '',
          whatsappNumber: '',
          description: 'Beta Boutique Hotel',
        },
      ],
      skipDuplicates: true,
    });
  });

  after(async () => {
    // Cleanup test data
    await prisma.emailIntegration.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } });
  });

  test('1. AES-256-GCM Token Encryption & Decryption Round-Trip', () => {
    const rawToken = 'ya29.a0ARrdaM_test_gmail_access_token_1234567890';
    const encrypted = encryptToken(rawToken);

    assert.ok(encrypted, 'Encrypted string must exist');
    assert.notEqual(encrypted, rawToken, 'Encrypted string must not be plaintext');
    assert.ok(encrypted.includes(':'), 'Encrypted string must contain IV, tag, and ciphertext parts');

    const decrypted = decryptToken(encrypted);
    assert.equal(decrypted, rawToken, 'Decrypted token must exactly match original plaintext token');
  });

  test('2. OAuth State Generation & Cryptographic Verification', () => {
    const state = generateOAuthState(hotelA, '/onboarding');
    assert.ok(state, 'State token must be generated');
    assert.ok(state.includes('.'), 'State must be HMAC signed');

    const result = verifyOAuthState(state);
    assert.equal(result.valid, true, 'State signature must be valid');
    assert.equal(result.payload.hotelId, hotelA, 'State must contain correct hotelId');
    assert.equal(result.payload.redirectBack, '/onboarding', 'State must preserve redirect target');
  });

  test('3. OAuth State Tampering Rejection', () => {
    const state = generateOAuthState(hotelA, '/onboarding');
    const [payloadBase64, hmac] = state.split('.');

    // Tamper with payload (e.g. switch hotelId to hotelB)
    const tamperedPayload = JSON.stringify({ hotelId: hotelB, redirectBack: '/onboarding', ts: Date.now() });
    const tamperedBase64 = Buffer.from(tamperedPayload, 'utf8').toString('base64url');
    const forgedState = `${tamperedBase64}.${hmac}`;

    const result = verifyOAuthState(forgedState);
    assert.equal(result.valid, false, 'Tampered state must be rejected');
    assert.ok(result.error.includes('mismatch') || result.error.includes('Invalid'), 'Error should report signature mismatch');
  });

  test('4. Google OAuth Authorization URL Generation', () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:5000/api/email/oauth/google/callback';

    const authUrl = gmailClient.getGoogleOAuthUrl(hotelA, '/onboarding');
    assert.ok(authUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), 'Must use official Google OAuth endpoint');

    const parsed = new URL(authUrl);
    assert.equal(parsed.searchParams.get('client_id'), 'test-client-id.apps.googleusercontent.com');
    assert.equal(parsed.searchParams.get('response_type'), 'code');
    assert.equal(parsed.searchParams.get('access_type'), 'offline');
    assert.equal(parsed.searchParams.get('prompt'), 'consent');

    const requestedScopes = parsed.searchParams.get('scope').split(' ');
    assert.ok(requestedScopes.includes('https://www.googleapis.com/auth/gmail.readonly'), 'Must request gmail.readonly');
    assert.ok(requestedScopes.includes('https://www.googleapis.com/auth/gmail.send'), 'Must request gmail.send');
    assert.ok(requestedScopes.includes('openid'), 'Must request openid');
  });

  test('5. Multi-Tenant Database Token Persistence (Hotel A vs Hotel B)', async () => {
    const tokenA = 'ya29.access_token_hotel_alpha';
    const refreshA = '1//refresh_token_hotel_alpha';
    const emailA = 'reception@hotel-alpha.com';

    const tokenB = 'ya29.access_token_hotel_beta';
    const refreshB = '1//refresh_token_hotel_beta';
    const emailB = 'reception@hotel-beta.com';

    // Save Hotel A
    await prisma.emailIntegration.upsert({
      where: { hotelId: hotelA },
      create: {
        hotelId: hotelA,
        email: emailA,
        provider: 'google',
        accessToken: encryptToken(tokenA),
        refreshToken: encryptToken(refreshA),
        tokenExpiry: new Date(Date.now() + 3600000),
        status: 'connected',
      },
      update: {},
    });

    // Save Hotel B
    await prisma.emailIntegration.upsert({
      where: { hotelId: hotelB },
      create: {
        hotelId: hotelB,
        email: emailB,
        provider: 'google',
        accessToken: encryptToken(tokenB),
        refreshToken: encryptToken(refreshB),
        tokenExpiry: new Date(Date.now() + 3600000),
        status: 'connected',
      },
      update: {},
    });

    // Resolve Hotel A
    const credsA = await gmailClient.getValidAccessTokenForHotel(hotelA);
    assert.equal(credsA.email, emailA);
    assert.equal(credsA.accessToken, tokenA);

    // Resolve Hotel B
    const credsB = await gmailClient.getValidAccessTokenForHotel(hotelB);
    assert.equal(credsB.email, emailB);
    assert.equal(credsB.accessToken, tokenB);

    // Verify strict isolation
    assert.notEqual(credsA.accessToken, credsB.accessToken, 'Hotel A must never access Hotel B tokens');
  });

  test('6. Unauthenticated Hotel Access Fails Safely', async () => {
    await assert.rejects(
      async () => {
        await gmailClient.getValidAccessTokenForHotel('unknown-nonexistent-hotel-id');
      },
      { message: /No connected Gmail integration found/ }
    );
  });

  test('7. RFC 2822 MIME Message Construction with Thread ID and Reply Headers', () => {
    const mimeEncoded = gmailClient.createMimeMessage({
      from: 'reception@hotel-alpha.com',
      to: 'guest@example.com',
      subject: 'Reservation Confirmation #RES-101',
      bodyText: 'Dear Guest, your reservation has been confirmed. Welcome to Grand Hotel Alpha!',
      inReplyTo: '<inquiry-101@example.com>',
      references: '<inquiry-101@example.com>',
    });

    assert.ok(mimeEncoded, 'MIME payload must be generated');
    const rawDecoded = Buffer.from(mimeEncoded, 'base64url').toString('utf-8');

    assert.ok(rawDecoded.includes('From: reception@hotel-alpha.com'));
    assert.ok(rawDecoded.includes('To: guest@example.com'));
    assert.ok(rawDecoded.includes('In-Reply-To: <inquiry-101@example.com>'));
    assert.ok(rawDecoded.includes('References: <inquiry-101@example.com>'));
    assert.ok(rawDecoded.includes('Dear Guest, your reservation has been confirmed.'));
  });

  test('8. Outbound Guest Email Dispatches via Gmail API Architecture (No Brevo)', async () => {
    const res = await emailService.sendGuestEmail({
      hotelId: hotelA,
      toEmail: 'guest.lucas@example.com',
      subject: 'Welcome to Grand Hotel Alpha',
      text: 'Here is your check-in code.',
      author: 'staff',
    });

    assert.equal(res.success, true);
    assert.equal(res.dispatched, true);
    assert.ok(res.at);
  });

  test('9. Staff Invitations Continue to Function via Brevo Mailer (Preserved)', async () => {
    const inviteRes = await sendBrevoInvitationEmail({
      toEmail: 'newstaff@hotel-alpha.com',
      toName: 'Sarah Connor',
      role: 'front-office',
      title: 'Front Desk Lead',
      hotelName: 'Grand Hotel Alpha',
    });

    assert.equal(inviteRes.success, true, 'Staff invitation mailer must succeed');
  });
});
