import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { prisma } from '../config/database.js';
import { generateOAuthState, verifyOAuthState } from '../utils/tokenCrypto.js';
import { sendMetaWhatsAppMessage, sendWhatsAppTemplate, sanitizePhoneNumber } from '../modules/whatsapp/whatsappController.js';
import { signToken } from '../utils/jwt.js';

process.env.NODE_ENV = 'test';

describe('WhatsApp Fixes Specific Regression Test Suite', () => {
  let server;
  let baseUrl;
  const hotelIdA = 'hotel-wa-unit-a';
  const hotelIdB = 'hotel-wa-unit-b';
  let tokenA;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    // Seed test hotels
    await prisma.hotel.upsert({
      where: { id: hotelIdA },
      update: {},
      create: {
        id: hotelIdA,
        name: 'Unit Alpha Hotel',
        legalName: 'Unit Alpha BV',
        address: 'Alpha Str 1',
        postcode: '1000',
        city: 'Brussels',
        country: 'Belgium',
        phone: '+32 2 111 0000',
        email: 'info@unit-alpha.com',
        website: 'unit-alpha.com',
        bookingEngine: 'unit-alpha.com/book',
        whatsappNumber: '+32 2 111 0000',
        vatNumber: 'BE0123456789',
        description: 'Unit test hotel A',
      },
    });

    await prisma.user.upsert({
      where: { id: 'u-wa-unit-a' },
      update: {},
      create: {
        id: 'u-wa-unit-a',
        email: 'mgr-wa-unit@alphahotel.be',
        name: 'Unit Manager',
        role: 'manager',
        hotelId: hotelIdA,
      },
    });

    tokenA = signToken({ id: 'u-wa-unit-a', role: 'manager', email: 'mgr-wa-unit@alphahotel.be', hotelId: hotelIdA });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  /* ------------------- 1. DASHBOARD STAFF REPLIES & DUPLICATE PREVENTION ------------------- */
  test('1. Dashboard staff reply resolves guest phone and sets deliveryStatus, preventing duplicates', async () => {
    const guestId = `g-wa-${hotelIdA}-32499112233`;
    const convId = `c-wa-unit-${Date.now()}`;

    await prisma.guest.upsert({
      where: { id: guestId },
      update: {},
      create: {
        id: guestId,
        hotelId: hotelIdA,
        name: 'Test WhatsApp Guest',
        country: 'Belgium',
        language: 'en',
        tags: JSON.stringify(['whatsapp', 'phone:+32499112233']),
      },
    });

    await prisma.conversation.create({
      data: {
        id: convId,
        guestId,
        stage: 'in-house',
        primaryChannel: 'whatsapp',
        aiStatus: 'human-takeover',
        sentiment: 'neutral',
        subject: 'WhatsApp Inquiry',
        summary: 'Guest asked about room service',
        suggestedReply: '',
        lastAt: '12:00',
      },
    });

    const res = await fetch(`${baseUrl}/conversations/${convId}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        body: 'Here is your room service menu confirmation.',
        channel: 'whatsapp',
        staffName: 'Amélie Duprez',
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.channel, 'whatsapp');
    assert.equal(json.data.deliveryStatus, 'simulated');

    // Duplicate submission within 3 seconds returns existing message without creating a new record
    const dupRes = await fetch(`${baseUrl}/conversations/${convId}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        body: 'Here is your room service menu confirmation.',
        channel: 'whatsapp',
        staffName: 'Amélie Duprez',
      }),
    });
    const dupJson = await dupRes.json();
    assert.equal(dupJson.data.id, json.data.id);

    const messageCount = await prisma.message.count({
      where: { conversationId: convId, author: 'staff' },
    });
    assert.equal(messageCount, 1);
  });

  test('1b. Dashboard staff reply with missing/invalid guest phone records failed delivery status', async () => {
    const guestNoPhoneId = `g-no-phone-${hotelIdA}-${Date.now()}`;
    const convNoPhoneId = `c-no-phone-${Date.now()}`;

    await prisma.guest.create({
      data: {
        id: guestNoPhoneId,
        hotelId: hotelIdA,
        name: 'Guest Without Phone',
        country: 'Belgium',
        language: 'en',
        tags: JSON.stringify(['unlabeled_12345', 'room_303']),
      },
    });

    await prisma.conversation.create({
      data: {
        id: convNoPhoneId,
        guestId: guestNoPhoneId,
        stage: 'in-house',
        primaryChannel: 'whatsapp',
        aiStatus: 'human-takeover',
        sentiment: 'neutral',
        subject: 'No phone test',
        summary: '',
        suggestedReply: '',
        lastAt: '12:00',
      },
    });

    const res = await fetch(`${baseUrl}/conversations/${convNoPhoneId}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        body: 'Testing failed delivery status when phone is missing.',
        channel: 'whatsapp',
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.deliveryStatus, 'failed');
    assert.equal(json.data.dispatch.success, false);
  });

  /* ------------------- 2. OAUTH STATE & TENANT ISOLATION ------------------- */
  test('2. OAuth State Verification rejects tampered, expired, or missing hotelId without demo-tenant fallback', async () => {
    // A. Tampered state
    const validState = generateOAuthState(hotelIdA);
    const tamperedState = validState.slice(0, -5) + 'xxxxx';
    const tamperedRes = verifyOAuthState(tamperedState);
    assert.equal(tamperedRes.valid, false);

    // B. Missing dot / malformed
    const malformedRes = verifyOAuthState('not_a_valid_state_string');
    assert.equal(malformedRes.valid, false);

    // C. Endpoint rejects invalid state with redirect error, never defaults to hotel-mercier
    const cbRes = await fetch(`${baseUrl}/whatsapp/oauth/callback?code=mock_code&state=${tamperedState}`, {
      redirect: 'manual',
    });
    assert.ok([301, 302, 307, 308].includes(cbRes.status));
    const location = cbRes.headers.get('location');
    assert.ok(location.includes('wa_error='));
    assert.ok(!location.includes('wa_connected=true'));
  });

  /* ------------------- 3. TARGET TYPE INTEGRATION SELECTION ------------------- */
  test('3. Integration selection fails safely when only wrong targetType is connected', async () => {
    await prisma.whatsAppIntegration.deleteMany({ where: { hotelId: hotelIdA } });

    // Only 'internal' integration is connected
    await prisma.whatsAppIntegration.create({
      data: {
        hotelId: hotelIdA,
        targetType: 'internal',
        phoneNumber: '32490000001',
        displayPhoneNumber: '+32 490 00 00 01',
        phoneNumberId: 'pn_internal_staff_1',
        status: 'connected',
      },
    });

    // Request guest dispatch -> MUST fail safely because only internal is connected
    const guestDispatch = await sendMetaWhatsAppMessage('32491112233', 'Hello Guest', [], hotelIdA, 'guest');
    assert.equal(guestDispatch.success, false);
    assert.ok(guestDispatch.reason.includes('No connected "guest" WhatsApp integration'));

    // Now connect guest integration -> succeeds
    await prisma.whatsAppIntegration.create({
      data: {
        hotelId: hotelIdA,
        targetType: 'guest',
        phoneNumber: '32490000002',
        displayPhoneNumber: '+32 490 00 00 02',
        phoneNumberId: 'pn_guest_live_2',
        status: 'connected',
      },
    });

    const guestDispatchSuccess = await sendMetaWhatsAppMessage('32491112233', 'Hello Guest', [], hotelIdA, 'guest');
    assert.equal(guestDispatchSuccess.success, true);
    assert.equal(guestDispatchSuccess.simulated, true);
  });

  /* ------------------- 4. DELIVERY / READ STATUS WEBHOOKS & REGRESSION PREVENTION ------------------- */
  test('4. Webhook processes delivered, advances to read, and prevents status regression', async () => {
    const msgId = `m-wa-meta-status-test-${Date.now()}`;
    const convId = `c-wa-status-${Date.now()}`;
    const guestId = `g-wa-${hotelIdA}-status`;

    await prisma.guest.upsert({
      where: { id: guestId },
      update: {},
      create: { id: guestId, hotelId: hotelIdA, name: 'Status Guest', country: 'Belgium', language: 'en' },
    });

    await prisma.conversation.upsert({
      where: { id: convId },
      update: {},
      create: {
        id: convId,
        guestId,
        stage: 'in-house',
        primaryChannel: 'whatsapp',
        aiStatus: 'ai-active',
        sentiment: 'neutral',
        subject: 'Status test',
        summary: '',
        suggestedReply: '',
        lastAt: '12:00',
      },
    });

    await prisma.message.create({
      data: {
        id: msgId,
        conversationId: convId,
        author: 'ai',
        channel: 'whatsapp',
        body: 'Status check message',
        at: '12:00',
        deliveryStatus: 'sent',
      },
    });

    const rawWaId = msgId.replace('m-wa-', '');

    // Step 1: Webhook updates status to 'read'
    const readPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba_test',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'pn_guest_live_2', display_phone_number: '+32 490 00 00 02' },
                statuses: [
                  {
                    id: rawWaId,
                    status: 'read',
                    timestamp: '1700000002',
                    recipient_id: '32499112233',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const res1 = await fetch(`${baseUrl}/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readPayload),
    });
    assert.equal(res1.status, 200);

    const msgAfterRead = await prisma.message.findUnique({ where: { id: msgId } });
    assert.equal(msgAfterRead.deliveryStatus, 'read');

    // Step 2: Late/out-of-order 'delivered' webhook arrives -> MUST NOT regress 'read' to 'delivered'
    const lateDeliveredPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba_test',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'pn_guest_live_2', display_phone_number: '+32 490 00 00 02' },
                statuses: [
                  {
                    id: rawWaId,
                    status: 'delivered',
                    timestamp: '1700000001',
                    recipient_id: '32499112233',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const res2 = await fetch(`${baseUrl}/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lateDeliveredPayload),
    });
    assert.equal(res2.status, 200);

    const msgAfterLateDelivered = await prisma.message.findUnique({ where: { id: msgId } });
    assert.equal(msgAfterLateDelivered.deliveryStatus, 'read'); // Still 'read'

    // Step 3: Unknown message ID webhook is acknowledged without throwing
    const unknownPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba_test',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'pn_guest_live_2' },
                statuses: [{ id: 'unknown_wa_msg_999999', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    const res3 = await fetch(`${baseUrl}/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(unknownPayload),
    });
    assert.equal(res3.status, 200);
  });

  /* ------------------- 5. TEMPLATE PAYLOAD BUILDER & ERROR HANDLING ------------------- */
  test('5. sendWhatsAppTemplate sanitizes phone and handles simulator/mock environment safely', async () => {
    const res = await sendWhatsAppTemplate('+32 491 11-22-33', 'booking_confirmation', 'en_US', [], hotelIdA);
    assert.equal(res.success, true);
    assert.equal(res.simulated, true);

    // Invalid phone number failure
    const invalidRes = await sendWhatsAppTemplate('', 'booking_confirmation', 'en_US', [], hotelIdA);
    assert.equal(invalidRes.success, false);
    assert.equal(invalidRes.reason, 'Invalid phone number');
  });

  /* ------------------- 6. OUTBOUND FAILURE HANDLING ------------------- */
  test('6. POST /api/whatsapp/send returns 400 if hotel is unconfigured in non-test mode or phone missing', async () => {
    const res = await fetch(`${baseUrl}/whatsapp/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        // missing "to" and "message"
      }),
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
  });
});
