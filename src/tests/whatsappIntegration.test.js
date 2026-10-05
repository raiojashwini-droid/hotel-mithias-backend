import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { prisma } from '../config/database.js';
import { ensureWhatsAppColumns } from '../modules/onboarding/onboardingController.js';

describe('Guest WhatsApp Integration & Multi-Tenant Test Suite (Step 4)', () => {
  let server;
  let baseUrl;
  const hotelIdA = 'test-hotel-wa-a';
  const hotelIdB = 'test-hotel-wa-b';
  const phoneA = '32491111111';
  const phoneB = '32492222222';
  const phoneIdA = 'meta_phone_id_hotel_a';
  const phoneIdB = 'meta_phone_id_hotel_b';

  before(async () => {
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}/api`;
        resolve();
      });
    });

    // Ensure database columns exist in MySQL cleanly
    await ensureWhatsAppColumns();

    // Clean prior test records
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.task.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.message.deleteMany({ where: { conversation: { guest: { hotelId: { in: [hotelIdA, hotelIdB] } } } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { guest: { hotelId: { in: [hotelIdA, hotelIdB] } } } }).catch(() => {});
    await prisma.guest.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.whatsAppIntegration.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});

    // Seed Hotel A and Hotel B with distinct WhatsApp numbers and Integrations
    await prisma.hotel.create({
      data: {
        id: hotelIdA,
        name: 'Grand Hotel Alpha',
        legalName: 'Alpha Hotels BV',
        address: 'Alpha Boulevard 1',
        postcode: '2000',
        city: 'Antwerp',
        country: 'Belgium',
        phone: '+32 3 111 00 00',
        email: 'info@alphahotel.be',
        website: 'alphahotel.be',
        bookingEngine: 'alphahotel.be/book',
        whatsappNumber: '+32 3 111 22 33',
        vatNumber: 'BE 0111.111.111',
        description: 'Alpha luxury boutique hotel',
        onboardingDone: true,
      },
    });

    await prisma.hotel.create({
      data: {
        id: hotelIdB,
        name: 'Royal Hotel Beta',
        legalName: 'Beta Hotels BV',
        address: 'Beta Avenue 2',
        postcode: '1000',
        city: 'Brussels',
        country: 'Belgium',
        phone: '+32 2 222 00 00',
        email: 'info@betahotel.be',
        website: 'betahotel.be',
        bookingEngine: 'betahotel.be/book',
        whatsappNumber: '+32 2 222 33 44',
        vatNumber: 'BE 0222.222.222',
        description: 'Beta luxury business hotel',
        onboardingDone: true,
      },
    });

    await prisma.whatsAppIntegration.create({
      data: {
        hotelId: hotelIdA,
        targetType: 'guest',
        phoneNumber: phoneA,
        displayPhoneNumber: '+32 491 11 11 11',
        phoneNumberId: phoneIdA,
        wabaId: 'waba_hotel_a',
        status: 'connected',
      },
    });

    await prisma.whatsAppIntegration.create({
      data: {
        hotelId: hotelIdB,
        targetType: 'guest',
        phoneNumber: phoneB,
        displayPhoneNumber: '+32 492 22 22 22',
        phoneNumberId: phoneIdB,
        wabaId: 'waba_hotel_b',
        status: 'connected',
      },
    });
  });

  after(async () => {
    // Cleanup test data
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.task.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.message.deleteMany({ where: { conversation: { guest: { hotelId: { in: [hotelIdA, hotelIdB] } } } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { guest: { hotelId: { in: [hotelIdA, hotelIdB] } } } }).catch(() => {});
    await prisma.guest.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.whatsAppIntegration.deleteMany({ where: { hotelId: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelIdA, hotelIdB] } } }).catch(() => {});

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('1. GET /api/whatsapp/webhook handles Meta verification challenge handshake', async () => {
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.VERIFY_TOKEN || 'hotelogxcom2606';
    const challenge = '1158201444';

    const res = await fetch(
      `${baseUrl}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=${challenge}`
    );

    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, challenge);
  });

  test('2. Meta Cloud Webhook resolves Hotel A via phone_number_id strictly', async () => {
    const metaPayloadHotelA = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba_hotel_a',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+32 491 11 11 11',
                  phone_number_id: phoneIdA,
                },
                contacts: [{ profile: { name: 'Alice Alpha' }, wa_id: '32488100001' }],
                messages: [
                  {
                    from: '32488100001',
                    id: 'wamid_meta_001',
                    text: { body: 'Hello Alpha Front Desk, do you have room service?' },
                    type: 'text',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const res = await fetch(`${baseUrl}/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metaPayloadHotelA),
    });

    assert.equal(res.status, 200);

    // Verify Guest created under hotelIdA
    const guest = await prisma.guest.findUnique({
      where: { id: `g-wa-${hotelIdA}-32488100001` },
      include: { conversations: { include: { messages: true } } },
    });
    assert.ok(guest, 'Guest record should be created for Hotel A');
    assert.equal(guest.hotelId, hotelIdA);
    assert.equal(guest.name, 'Alice Alpha');
    assert.ok(guest.conversations.length > 0);
  });

  test('3. Meta Cloud Webhook resolves Hotel B via phone_number_id strictly', async () => {
    const metaPayloadHotelB = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba_hotel_b',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+32 492 22 22 22',
                  phone_number_id: phoneIdB,
                },
                contacts: [{ profile: { name: 'Bob Beta' }, wa_id: '32488200002' }],
                messages: [
                  {
                    from: '32488200002',
                    id: 'wamid_meta_002',
                    text: { body: 'Could we get 2 extra towels for Room 302?' },
                    type: 'text',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const res = await fetch(`${baseUrl}/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metaPayloadHotelB),
    });

    assert.equal(res.status, 200);

    // Verify Guest created under hotelIdB
    const guest = await prisma.guest.findUnique({
      where: { id: `g-wa-${hotelIdB}-32488200002` },
      include: { conversations: { include: { messages: true } } },
    });
    assert.ok(guest, 'Guest record should be created for Hotel B');
    assert.equal(guest.hotelId, hotelIdB);
    assert.equal(guest.name, 'Bob Beta');

    // Verify Task created strictly under hotelIdB
    const task = await prisma.task.findFirst({
      where: { hotelId: hotelIdB, room: '302' },
    });
    assert.ok(task, 'Task should exist for Hotel B');
    assert.equal(task.hotelId, hotelIdB);

    // Verify Hotel A has no tasks for Room 302
    const taskA = await prisma.task.findFirst({
      where: { hotelId: hotelIdA, room: '302' },
    });
    assert.equal(taskA, null, 'Hotel A must NOT receive Hotel B tasks');
  });

  test('4. Unknown / Unmapped Meta phone_number_id fails safely and does NOT pollute default hotel', async () => {
    const unmappedPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba_unknown_999',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+1 999 000 9999',
                  phone_number_id: 'unknown_phone_id_999',
                },
                contacts: [{ profile: { name: 'Stranger' }, wa_id: '19990009999' }],
                messages: [
                  {
                    from: '19990009999',
                    id: 'wamid_unknown_001',
                    text: { body: 'Hello is this any hotel?' },
                    type: 'text',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const res = await fetch(`${baseUrl}/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(unmappedPayload),
    });

    // Must return 200 to acknowledge Meta webhook without crashing or retrying
    assert.equal(res.status, 200);

    // Verify NO guest record was created anywhere for this unknown contact
    const anyGuest = await prisma.guest.findFirst({
      where: { id: { contains: '19990009999' } },
    });
    assert.equal(anyGuest, null, 'Unmapped number must NOT create guest in any tenant');
  });

  test('5. Cross-Tenant Isolation: Same guest phone messaging Hotel A and Hotel B creates separate isolated records', async () => {
    const sharedPhone = '32470000000';

    // Guest messages Hotel A
    await fetch(`${baseUrl}/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hotelId: hotelIdA,
        fromPhone: sharedPhone,
        senderName: 'Shared Visitor',
        message: 'Hello Hotel Alpha, what time is check-in?',
      }),
    });

    // Same guest messages Hotel B
    await fetch(`${baseUrl}/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hotelId: hotelIdB,
        fromPhone: sharedPhone,
        senderName: 'Shared Visitor',
        message: 'Hello Hotel Beta, do you have parking?',
      }),
    });

    const guestInA = await prisma.guest.findUnique({
      where: { id: `g-wa-${hotelIdA}-${sharedPhone}` },
    });
    const guestInB = await prisma.guest.findUnique({
      where: { id: `g-wa-${hotelIdB}-${sharedPhone}` },
    });

    assert.ok(guestInA, 'Guest record must exist in Hotel A');
    assert.equal(guestInA.hotelId, hotelIdA);

    assert.ok(guestInB, 'Guest record must exist in Hotel B');
    assert.equal(guestInB.hotelId, hotelIdB);

    assert.notEqual(guestInA.id, guestInB.id, 'Guest IDs must be distinct and scoped per tenant');
  });

  test('6. POST /api/whatsapp/send dispatches outbound WhatsApp message safely with tenant scope', async () => {
    const sendPayload = {
      hotelId: hotelIdA,
      to: '32491111111',
      message: 'Your check-in has been confirmed at Grand Hotel Alpha.',
    };

    const res = await fetch(`${baseUrl}/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendPayload),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.success);
  });

  test('7. POST /api/whatsapp/embedded-signup exchanges credentials and updates tenant integration', async () => {
    const signupPayload = {
      hotelId: hotelIdA,
      targetType: 'guest',
      code: 'mock_meta_oauth_code_12345',
      wabaId: 'waba_meta_live_9999',
      phoneNumberId: 'pn_meta_live_8888',
      displayPhoneNumber: '+32 499 99 99 99',
    };

    const res = await fetch(`${baseUrl}/whatsapp/embedded-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signupPayload),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.integration.hotelId, hotelIdA);
    assert.equal(json.data.integration.phoneNumberId, 'pn_meta_live_8888');
    assert.equal(json.data.integration.wabaId, 'waba_meta_live_9999');

    // Verify persisted in MySQL
    const integrationInDb = await prisma.whatsAppIntegration.findFirst({
      where: { hotelId: hotelIdA, targetType: 'guest' },
    });
    assert.ok(integrationInDb);
    assert.equal(integrationInDb.phoneNumberId, 'pn_meta_live_8888');
  });
});

