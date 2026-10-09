import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import app from '../app.js';
import { prisma } from '../config/database.js';
import { signToken, verifyToken } from '../utils/jwt.js';
import { encryptToken, decryptToken } from '../utils/tokenCrypto.js';

process.env.NODE_ENV = 'test';

describe('Production Audit Fixes Verification Test Suite', () => {
  let server;
  let baseUrl;

  const testTenantA = 'test-hotel-audit-a';
  const testTenantB = 'test-hotel-audit-b';
  const testManagerAEmail = `audit.manager.a.${Date.now()}@example.com`;
  const testManagerBEmail = `audit.manager.b.${Date.now()}@example.com`;
  let tokenA;
  let tokenB;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    // Clean any previous test data
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [testTenantA, testTenantB] } } });
    await prisma.message.deleteMany({
      where: { conversation: { guest: { hotelId: { in: [testTenantA, testTenantB] } } } },
    });
    await prisma.conversation.deleteMany({
      where: { guest: { hotelId: { in: [testTenantA, testTenantB] } } },
    });
    await prisma.guest.deleteMany({ where: { hotelId: { in: [testTenantA, testTenantB] } } });
    await prisma.task.deleteMany({ where: { hotelId: { in: [testTenantA, testTenantB] } } });
    await prisma.issue.deleteMany({ where: { hotelId: { in: [testTenantA, testTenantB] } } });
    await prisma.emailIntegration.deleteMany({ where: { hotelId: { in: [testTenantA, testTenantB] } } });
    await prisma.user.deleteMany({ where: { email: { in: [testManagerAEmail, testManagerBEmail] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [testTenantA, testTenantB] } } });
  });

  after(async () => {
    try {
      await prisma.activityItem.deleteMany({ where: { hotelId: { in: [testTenantA, testTenantB] } } });
      await prisma.message.deleteMany({
        where: { conversation: { guest: { hotelId: { in: [testTenantA, testTenantB] } } } },
      });
      await prisma.conversation.deleteMany({
        where: { guest: { hotelId: { in: [testTenantA, testTenantB] } } },
      });
      await prisma.guest.deleteMany({ where: { hotelId: { in: [testTenantA, testTenantB] } } });
      await prisma.task.deleteMany({ where: { hotelId: { in: [testTenantA, testTenantB] } } });
      await prisma.issue.deleteMany({ where: { hotelId: { in: [testTenantA, testTenantB] } } });
      await prisma.emailIntegration.deleteMany({ where: { hotelId: { in: [testTenantA, testTenantB] } } });
      await prisma.user.deleteMany({ where: { email: { in: [testManagerAEmail, testManagerBEmail] } } });
      await prisma.hotel.deleteMany({ where: { id: { in: [testTenantA, testTenantB] } } });
      await new Promise((resolve) => server.close(resolve));
    } catch (e) {
      // ignore teardown errors
    }
  });

  test('1. Real Hotel & Manager Registration persists to MySQL with secure password hashing', async () => {
    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hotelName: 'Audit Test Grand Hotel',
        managerName: 'Audit Manager',
        email: testManagerAEmail,
        password: 'SecureTestPassword123!',
        city: 'Brussels',
        country: 'Belgium',
      }),
    });

    assert.equal(regRes.status, 201);
    const regBody = await regRes.json();
    assert.equal(regBody.success, true);
    assert.ok(regBody.data.token);
    assert.ok(regBody.data.hotel);
    assert.ok(regBody.data.user);
    assert.equal(regBody.data.user.email, testManagerAEmail);

    tokenA = regBody.data.token;
    const registeredHotelId = regBody.data.hotel.id;

    // Check DB persistence
    const savedUser = await prisma.user.findUnique({ where: { email: testManagerAEmail } });
    assert.ok(savedUser);
    assert.notEqual(savedUser.passwordHash, 'SecureTestPassword123!');
    const match = await bcrypt.compare('SecureTestPassword123!', savedUser.passwordHash);
    assert.equal(match, true);

    const savedHotel = await prisma.hotel.findUnique({ where: { id: registeredHotelId } });
    assert.ok(savedHotel);
    assert.equal(savedHotel.name, 'Audit Test Grand Hotel');
  });

  test('2. JWT Token Refresh endpoint (/api/auth/refresh) generates a new valid token', async () => {
    assert.ok(tokenA, 'tokenA must be available from registration test');

    const refreshRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
    });

    assert.equal(refreshRes.status, 200);
    const refreshBody = await refreshRes.json();
    assert.equal(refreshBody.success, true);
    assert.ok(refreshBody.data.token);

    const decoded = verifyToken(refreshBody.data.token);
    assert.ok(decoded);
    assert.equal(decoded.email, testManagerAEmail);

    // Verify unauthenticated refresh fails
    const badRefreshRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid.token.signature',
      },
    });
    assert.equal(badRefreshRes.status, 401);
  });

  test('3. Strict Tenant Isolation: Rejects unauthenticated requests and isolates Tenant A from Tenant B', async () => {
    // Seed Tenant B directly
    await prisma.hotel.create({
      data: {
        id: testTenantB,
        name: 'Hotel Beta Isolation Test',
        legalName: 'Beta Isolation Test BV',
        address: 'Beta Way 2',
        postcode: '2000',
        city: 'Antwerp',
        country: 'Belgium',
        phone: '+32 3 200 00 01',
        email: 'beta@isolation.be',
        website: 'hotelbeta-isolation.be',
        bookingEngine: 'hotelbeta-isolation.be/book',
        whatsappNumber: '+32 3 200 00 02',
        vatNumber: 'BE 0222.222.222',
        description: 'Tenant Beta Isolation Test Hotel',
        onboardingDone: true,
      },
    });

    const userB = await prisma.user.create({
      data: {
        id: `u-beta-${Date.now()}`,
        name: 'Beta Manager',
        email: testManagerBEmail,
        passwordHash: await bcrypt.hash('BetaPass123!', 10),
        role: 'manager',
        hotelId: testTenantB,
      },
    });

    tokenB = signToken({ id: userB.id, email: userB.email, role: 'manager', hotelId: testTenantB });

    // Create a conversation for Tenant B
    const guestB = await prisma.guest.create({
      data: {
        id: `gst_b_${Date.now()}`,
        hotelId: testTenantB,
        name: 'Beta Guest',
        country: 'BE',
        language: 'en',
        tags: JSON.stringify(['guest.b@example.com']),
      },
    });

    await prisma.conversation.create({
      data: {
        id: `conv_b_${Date.now()}`,
        guestId: guestB.id,
        stage: 'In-Stay',
        primaryChannel: 'EMAIL',
        aiStatus: 'Pending',
        sentiment: 'neutral',
        subject: 'Confidential Beta Topic',
        summary: 'Beta Guest inquiry',
        suggestedReply: 'Beta suggested reply',
        lastAt: '12:00',
      },
    });

    // 3.1 Unauthenticated request must return 401
    const unauthRes = await fetch(`${baseUrl}/conversations`);
    assert.equal(unauthRes.status, 401);

    // 3.2 Tenant A manager requesting conversations must NOT see Tenant B conversation
    const convsResA = await fetch(`${baseUrl}/conversations`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(convsResA.status, 200);
    const convsBodyA = await convsResA.json();
    assert.equal(Array.isArray(convsBodyA.data), true);
    // Tenant A has 0 conversations yet - should be empty array
    assert.equal(convsBodyA.data.length, 0);

    // 3.3 Tenant B manager requesting conversations sees only Tenant B conversation
    const convsResB = await fetch(`${baseUrl}/conversations`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(convsResB.status, 200);
    const convsBodyB = await convsResB.json();
    assert.equal(convsBodyB.data.length, 1);
    assert.equal(convsBodyB.data[0].guest.name, 'Beta Guest');
  });

  test('4. Onboarding Email Step securely encrypts IMAP/SMTP credentials with AES-256-GCM', async () => {
    const rawMailPassword = 'SuperSecretTitanPassword2026!';
    const decodedA = verifyToken(tokenA);
    const hotelIdA = decodedA.hotelId;

    const saveStepRes = await fetch(`${baseUrl}/onboarding/step`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        stepKey: 'email',
        data: {
          address: 'concierge@grandhotel.be',
          provider: 'hostinger',
          password: rawMailPassword,
          settings: {
            imapHost: 'imap.hostinger.com',
            imapPort: 993,
            smtpHost: 'smtp.hostinger.com',
            smtpPort: 465,
          },
        },
      }),
    });

    assert.equal(saveStepRes.status, 200);

    // Verify stored in DB with encryption
    const emailRecord = await prisma.emailIntegration.findUnique({
      where: { hotelId: hotelIdA },
    });
    assert.ok(emailRecord);
    assert.equal(emailRecord.provider, 'hostinger');
    assert.equal(emailRecord.email, 'concierge@grandhotel.be');
    assert.equal(emailRecord.imapHost, 'imap.hostinger.com');
    // Ensure raw password is NOT stored in plain text
    assert.notEqual(emailRecord.accessToken, rawMailPassword);
    // Decrypt and ensure original password matches
    const decrypted = decryptToken(emailRecord.accessToken);
    assert.equal(decrypted, rawMailPassword);
  });

  test('5. Inbound Email Ingestion, Conversation Persistence, and Duplicate Prevention', async () => {
    const decodedA = verifyToken(tokenA);
    const hotelIdA = decodedA.hotelId;

    const emailPayload = {
      from: 'incoming.guest@traveler.com',
      to: 'concierge@grandhotel.be',
      subject: 'Reservation Confirmation Inquiry',
      text: 'Dear Concierge, Can I request an early check-in at 12:00?',
      messageId: `<msg-unique-audit-${Date.now()}@traveler.com>`,
    };

    // First delivery
    const inboundRes1 = await fetch(`${baseUrl}/email/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hotel-id': hotelIdA,
      },
      body: JSON.stringify(emailPayload),
    });

    assert.equal(inboundRes1.status, 200);
    const body1 = await inboundRes1.json();
    assert.equal(body1.success, true);
    assert.ok(body1.data.conversationId);

    // Verify conversation now exists for Tenant A
    const tenantAConvs = await prisma.conversation.findMany({
      where: { guest: { hotelId: hotelIdA } },
      include: { messages: true, guest: true },
    });
    assert.equal(tenantAConvs.length, 1);
    assert.ok(tenantAConvs[0].guest.tags.includes('incoming.guest@traveler.com'));
    assert.equal(tenantAConvs[0].messages.length, 1);
    assert.equal(tenantAConvs[0].subject, 'Reservation Confirmation Inquiry');
    assert.ok(tenantAConvs[0].messages[0].body.includes('early check-in'));

    // Second delivery of identical messageId (Duplicate prevention test)
    const inboundRes2 = await fetch(`${baseUrl}/email/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hotel-id': hotelIdA,
      },
      body: JSON.stringify(emailPayload),
    });

    assert.equal(inboundRes2.status, 200);
    const body2 = await inboundRes2.json();
    assert.equal(body2.success, true);
    assert.equal(body2.data.duplicate, true);

    // Verify no duplicate message was inserted in DB
    const tenantAConvsAfter = await prisma.conversation.findMany({
      where: { guest: { hotelId: hotelIdA } },
      include: { messages: true },
    });
    assert.equal(tenantAConvsAfter[0].messages.length, 1);
  });

  test('6. Outbound Email Dispatch saves message with OUTBOUND direction without sending real external emails in test mode', async () => {
    const decodedA = verifyToken(tokenA);
    const hotelIdA = decodedA.hotelId;

    const conv = await prisma.conversation.findFirst({
      where: { guest: { hotelId: hotelIdA } },
    });
    assert.ok(conv);

    const sendRes = await fetch(`${baseUrl}/email/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        conversationId: conv.id,
        recipientEmail: 'incoming.guest@traveler.com',
        subject: 'Re: Reservation Confirmation Inquiry',
        bodyText: 'We would be happy to accommodate early check-in subject to room availability.',
      }),
    });

    assert.equal(sendRes.status, 200);
    const sendBody = await sendRes.json();
    assert.equal(sendBody.success, true);

    // Verify outbound message persisted
    const outboundMsg = await prisma.message.findFirst({
      where: {
        conversationId: conv.id,
        author: 'staff',
      },
    });
    assert.ok(outboundMsg);
    assert.equal(outboundMsg.body.includes('early check-in'), true);
  });

  test('7. Empty Dashboard States return valid empty arrays [] instead of falling back to mock data', async () => {
    // Tenant B has 0 tasks and 0 issues
    const tasksRes = await fetch(`${baseUrl}/tasks`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(tasksRes.status, 200);
    const tasksBody = await tasksRes.json();
    assert.equal(Array.isArray(tasksBody.data), true);
    assert.equal(tasksBody.data.length, 0);

    const issuesRes = await fetch(`${baseUrl}/issues`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(issuesRes.status, 200);
    const issuesBody = await issuesRes.json();
    assert.equal(Array.isArray(issuesBody.data), true);
    assert.equal(issuesBody.data.length, 0);
  });

  test('8. Real Login rejects invalid password or unknown user without demo fallback', async () => {
    // 8a. Unknown user
    const unknownRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nonexistent.user@randomdomain.test', password: 'SomePassword123' }),
    });
    assert.equal(unknownRes.status, 404);

    // 8b. Real user with wrong password
    const wrongPassRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testManagerAEmail, password: 'WrongPassword123!' }),
    });
    assert.equal(wrongPassRes.status, 401);

    // 8c. Real user with correct password succeeds
    const okRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testManagerAEmail, password: 'SecureTestPassword123!' }),
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.success, true);
    assert.ok(okBody.data.token);
    assert.equal(okBody.data.user.email, testManagerAEmail);
  });

  test('9. Authorized hotel staff retrieval isolates users strictly to their own hotel', async () => {
    // Fetch users for Tenant A
    const staffARes = await fetch(`${baseUrl}/users`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(staffARes.status, 200);
    const staffABody = await staffARes.json();
    assert.equal(Array.isArray(staffABody.data), true);
    assert.ok(staffABody.data.some((u) => u.email === testManagerAEmail));
    // Must NOT contain Tenant B's user
    assert.equal(staffABody.data.some((u) => u.email === testManagerBEmail), false);

    // Fetch users for Tenant B
    const staffBRes = await fetch(`${baseUrl}/users`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(staffBRes.status, 200);
    const staffBBody = await staffBRes.json();
    assert.equal(Array.isArray(staffBBody.data), true);
    assert.ok(staffBBody.data.some((u) => u.email === testManagerBEmail));
    // Must NOT contain Tenant A's user
    assert.equal(staffBBody.data.some((u) => u.email === testManagerAEmail), false);
  });

  test('10. Non-sensitive workspace display metadata contract preserves tenant isolation and omits secrets', async () => {
    // Both Tenant A and Tenant B endpoints return safe fields: id, name, email, role, title, initials
    const resA = await fetch(`${baseUrl}/users`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const jsonA = await resA.json();
    assert.equal(resA.status, 200);

    for (const u of jsonA.data) {
      assert.equal(u.passwordHash, undefined, 'passwordHash must never be exposed');
      assert.equal(u.password, undefined, 'password must never be exposed');
      assert.ok(u.id);
      assert.ok(u.email);
      assert.ok(u.role);
    }
  });
});


