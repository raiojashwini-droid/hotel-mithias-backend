import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { prisma } from '../config/database.js';
import { verifyImapConnection } from '../utils/imapVerifier.js';

describe('Multi-Tenant Dynamic Guest Email & IMAP Handshake Suite', () => {
  let server;
  let baseUrl;
  const tenantA = 'tenant-hotel-alpha';
  const tenantB = 'tenant-hotel-beta';

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    // Clean prior test fixtures
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [tenantA, tenantB] } } });
    await prisma.message.deleteMany({
      where: {
        conversation: {
          guest: { hotelId: { in: [tenantA, tenantB] } },
        },
      },
    });
    await prisma.conversation.deleteMany({
      where: {
        guest: { hotelId: { in: [tenantA, tenantB] } },
      },
    });
    await prisma.guest.deleteMany({ where: { hotelId: { in: [tenantA, tenantB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });

    // Seed Tenant A
    await prisma.hotel.create({
      data: {
        id: tenantA,
        name: 'Hotel Alpha Resort',
        legalName: 'Alpha Resort BV',
        address: 'Alpha Boulevard 1',
        postcode: '1000',
        city: 'Brussels',
        country: 'Belgium',
        phone: '+32 2 100 00 01',
        email: 'info@hotelalpha.be',
        website: 'hotelalpha.be',
        bookingEngine: 'hotelalpha.be/book',
        whatsappNumber: '+32 2 100 00 02',
        vatNumber: 'BE 0111.111.111',
        description: 'Tenant Alpha Test Hotel',
        onboardingDone: true,
      },
    });

    // Seed Tenant B
    await prisma.hotel.create({
      data: {
        id: tenantB,
        name: 'Hotel Beta Palace',
        legalName: 'Beta Palace BV',
        address: 'Beta Street 2',
        postcode: '2000',
        city: 'Antwerp',
        country: 'Belgium',
        phone: '+32 3 200 00 01',
        email: 'contact@hotelbeta.be',
        website: 'hotelbeta.be',
        bookingEngine: 'hotelbeta.be/book',
        whatsappNumber: '+32 3 200 00 02',
        vatNumber: 'BE 0222.222.222',
        description: 'Tenant Beta Test Hotel',
        onboardingDone: true,
      },
    });
  });

  after(async () => {
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [tenantA, tenantB] } } });
    await prisma.message.deleteMany({
      where: {
        conversation: {
          guest: { hotelId: { in: [tenantA, tenantB] } },
        },
      },
    });
    await prisma.conversation.deleteMany({
      where: {
        guest: { hotelId: { in: [tenantA, tenantB] } },
      },
    });
    await prisma.guest.deleteMany({ where: { hotelId: { in: [tenantA, tenantB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await new Promise((resolve) => server.close(resolve));
  });

  test('1. imapVerifier handles unreachable host and timeouts gracefully', async () => {
    const result = await verifyImapConnection({
      host: '192.0.2.1', // RFC 5737 non-routable test IP
      port: 993,
      timeoutMs: 1500,
    });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.ok(result.latencyMs >= 0);
  });

  test('2. POST /api/email/test-connection verifies OAuth and persists dynamically to Tenant A in MySQL', async () => {
    const res = await fetch(`${baseUrl}/email/test-connection`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hotel-id': tenantA,
      },
      body: JSON.stringify({
        address: 'guest-concierge@hotelalpha.be',
        method: 'oauth',
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.hotelId, tenantA);
    assert.equal(body.data.address, 'guest-concierge@hotelalpha.be');

    // Verify in database that Tenant A is updated and Tenant B is untouched
    const updatedHotelA = await prisma.hotel.findUnique({ where: { id: tenantA } });
    assert.equal(updatedHotelA.email, 'guest-concierge@hotelalpha.be');

    const unchangedHotelB = await prisma.hotel.findUnique({ where: { id: tenantB } });
    assert.equal(unchangedHotelB.email, 'contact@hotelbeta.be');
  });

  test('3. Dynamic multi-tenant inbound email isolation between Tenant A and Tenant B', async () => {
    // 3.1 Send email to Tenant A
    const resA = await fetch(`${baseUrl}/email/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hotel-id': tenantA,
      },
      body: JSON.stringify({
        from: 'sarah.guest@example.com',
        to: 'guest-concierge@hotelalpha.be',
        subject: 'Late Check-in Request',
        text: 'Hello Hotel Alpha, will reception be open at 23:00?',
      }),
    });

    assert.equal(resA.status, 200);
    const bodyA = await resA.json();
    assert.equal(bodyA.success, true);

    // Verify conversation is attached to Tenant A
    const convA = await prisma.conversation.findFirst({
      where: { id: bodyA.data.conversationId },
      include: { guest: true },
    });
    assert.equal(convA.guest.hotelId, tenantA);

    // 3.2 Verify Tenant B has zero conversations
    const convsB = await prisma.conversation.findMany({
      where: { guest: { hotelId: tenantB } },
    });
    assert.equal(convsB.length, 0);
  });
});
