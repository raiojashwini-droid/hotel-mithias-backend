import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { prisma } from '../config/database.js';

describe('Guest Email Integration Test Suite (Step 3)', () => {
  let server;
  let baseUrl;
  const hotelId = 'test-hotel-email-live';

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    // Clean prior test data
    await prisma.activityItem.deleteMany({ where: { hotelId } });
    await prisma.message.deleteMany({
      where: {
        conversation: {
          guest: { hotelId },
        },
      },
    });
    await prisma.conversation.deleteMany({
      where: {
        guest: { hotelId },
      },
    });
    await prisma.guest.deleteMany({ where: { hotelId } });
    await prisma.hotel.deleteMany({ where: { id: hotelId } });

    // Seed test hotel
    await prisma.hotel.create({
      data: {
        id: hotelId,
        name: 'Grand Horizon Email Test Hotel',
        legalName: 'Grand Horizon BV',
        address: 'Email Avenue 5',
        postcode: '2000',
        city: 'Antwerp',
        country: 'Belgium',
        phone: '+32 3 227 41 00',
        email: 'reception@grandhorizon.be',
        website: 'grandhorizon.be',
        bookingEngine: 'grandhorizon.be/book',
        whatsappNumber: '+32 3 227 41 08',
        vatNumber: 'BE 0123.456.789',
        description: 'Email integration test hotel',
        onboardingDone: true,
      },
    });
  });

  after(async () => {
    await prisma.activityItem.deleteMany({ where: { hotelId } });
    await prisma.message.deleteMany({
      where: {
        conversation: {
          guest: { hotelId },
        },
      },
    });
    await prisma.conversation.deleteMany({
      where: {
        guest: { hotelId },
      },
    });
    await prisma.guest.deleteMany({ where: { hotelId } });
    await prisma.hotel.deleteMany({ where: { id: hotelId } });
    await new Promise((resolve) => server.close(resolve));
  });

  test('1. POST /api/email/test-connection validates OAuth method and rejects invalid email', async () => {
    // 1.1 Invalid email rejection
    const badRes = await fetch(`${baseUrl}/email/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invalid-email-format' }),
    });
    assert.equal(badRes.status, 400);

    // 1.2 Valid OAuth method
    const oauthRes = await fetch(`${baseUrl}/email/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'reception@grandhorizon.be',
        method: 'oauth',
      }),
    });
    assert.equal(oauthRes.status, 200);
    const oauthJson = await oauthRes.json();
    assert.equal(oauthJson.success, true);
    assert.equal(oauthJson.data.verified, true);
  });

  test('2. POST /api/email/inbound processes incoming guest email, creates Conversation, Message & ActivityItem', async () => {
    const inboundPayload = {
      hotelId,
      from: 'Sarah Jenkins <sarah.jenkins@example.com>',
      to: 'reception@grandhorizon.be',
      subject: 'Early check-in inquiry for Room 204',
      text: 'Hello, we will be arriving around 1:00 PM. Is it possible to check in early?',
    };

    const res = await fetch(`${baseUrl}/email/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inboundPayload),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.conversationId);
    assert.ok(json.data.guestId);

    // Verify Guest in MySQL
    const guest = await prisma.guest.findUnique({
      where: { id: json.data.guestId },
    });
    assert.ok(guest);
    assert.equal(guest.name, 'Sarah Jenkins');

    // Verify Conversation
    const conversation = await prisma.conversation.findUnique({
      where: { id: json.data.conversationId },
      include: { messages: true },
    });
    assert.ok(conversation);
    assert.equal(conversation.primaryChannel, 'email');
    assert.ok(conversation.subject.includes('Early check-in inquiry'));
    assert.ok(conversation.messages.length >= 1);
    assert.equal(conversation.messages[0].author, 'guest');
    assert.equal(conversation.messages[0].channel, 'email');
    assert.ok(conversation.messages[0].body.includes('arriving around 1:00 PM'));

    // Verify ActivityItem
    const activities = await prisma.activityItem.findMany({
      where: { hotelId },
    });
    assert.ok(activities.some((a) => a.text.includes('Sarah Jenkins')));
  });

  test('3. POST /api/email/send dispatches outbound reply and appends message to conversation thread', async () => {
    // Locate the conversation created in test 2
    const conversation = await prisma.conversation.findFirst({
      where: { guest: { hotelId } },
    });
    assert.ok(conversation);

    const sendPayload = {
      hotelId,
      conversationId: conversation.id,
      toEmail: 'sarah.jenkins@example.com',
      subject: 'Re: Early check-in inquiry for Room 204',
      text: 'Dear Sarah, we have noted your 1:00 PM arrival. Your room will be prioritized for early turnover.',
      author: 'staff',
    };

    const res = await fetch(`${baseUrl}/email/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendPayload),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.dispatched);

    // Verify appended message in database
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { id: 'asc' },
    });
    assert.ok(messages.length >= 2);
    const lastMsg = messages[messages.length - 1];
    assert.equal(lastMsg.author, 'staff');
    assert.equal(lastMsg.channel, 'email');
    assert.ok(lastMsg.body.includes('Your room will be prioritized'));
  });

  test('4. POST /api/email/inbound generates intelligent Wi-Fi reply from Knowledge Base', async () => {
    const wifiPayload = {
      hotelId,
      from: 'Yashvant Sharma <yashvant@gmail.com>',
      to: 'reception@grandhorizon.be',
      subject: 'Wi-Fi Information',
      text: 'Hello, I want to on wifi.',
    };

    const res = await fetch(`${baseUrl}/email/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wifiPayload),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.conversationId);

    // Verify conversation suggestedReply contains Wi-Fi details
    const conversation = await prisma.conversation.findUnique({
      where: { id: json.data.conversationId },
    });
    assert.ok(conversation);
    assert.ok(
      conversation.suggestedReply.toLowerCase().includes('wi-fi') ||
      conversation.suggestedReply.toLowerCase().includes('wifi') ||
      conversation.suggestedReply.toLowerCase().includes('network')
    );
  });

  test('5. POST /api/email/inbound automatically creates Housekeeping Task for towel requests', async () => {
    const towelPayload = {
      hotelId,
      from: 'Elena Rostova <elena.rostova@example.com>',
      to: 'reception@grandhorizon.be',
      subject: 'Extra towels for Room 302',
      text: 'Good afternoon, could we please have 2 extra bath towels brought to Room 302?',
    };

    const res = await fetch(`${baseUrl}/email/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(towelPayload),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);

    // Verify Housekeeping Task created in MySQL
    const task = await prisma.task.findFirst({
      where: {
        hotelId,
        department: 'Housekeeping',
        room: '302',
      },
    });
    assert.ok(task);
    assert.ok(task.title.toLowerCase().includes('towel'));

    // Verify Guest room is populated
    const guest = await prisma.guest.findUnique({
      where: { id: json.data.guestId },
    });
    assert.ok(guest);
    assert.equal(guest.room, '302');

    // Verify PMS Reservation is linked
    const reservation = await prisma.reservation.findFirst({
      where: { guestId: json.data.guestId },
    });
    assert.ok(reservation);
    assert.equal(reservation.number, 'RES-302');
    assert.equal(reservation.status, 'In House');
  });
});
