import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { prisma } from '../config/database.js';
import { signToken } from '../utils/jwt.js';

describe('Front Office Agent Full-Stack Automated Test Suite', () => {
  let server;
  let baseUrl;
  let foTokenA;
  let foTokenB;
  let managerTokenA;
  const hotelA = 'test-fo-hotel-a';
  const hotelB = 'test-fo-hotel-b';

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    foTokenA = signToken({ id: 'u-amelie-a', role: 'front-office', email: 'amelie@fo-hotel-a.com', hotelId: hotelA });
    foTokenB = signToken({ id: 'u-amelie-b', role: 'front-office', email: 'amelie@fo-hotel-b.com', hotelId: hotelB });
    managerTokenA = signToken({ id: 'u-jonas-a', role: 'manager', email: 'jonas@fo-hotel-a.com', hotelId: hotelA });

    // Clean test data
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.taskTrail.deleteMany({ where: { task: { hotelId: { in: [hotelA, hotelB] } } } });
    await prisma.task.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.message.deleteMany({ where: { conversation: { guest: { hotelId: { in: [hotelA, hotelB] } } } } });
    await prisma.conversation.deleteMany({ where: { guest: { hotelId: { in: [hotelA, hotelB] } } } });
    await prisma.reservation.deleteMany({ where: { guest: { hotelId: { in: [hotelA, hotelB] } } } });
    await prisma.guest.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.room.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.user.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } });

    // Create test hotels
    await prisma.hotel.create({
      data: {
        id: hotelA,
        name: 'Hotel Mercier Alpha',
        legalName: 'Mercier Alpha BV',
        address: 'Kloosterstraat 44',
        postcode: '2000',
        city: 'Antwerp',
        country: 'Belgium',
        phone: '+32 3 200 11 00',
        email: 'info@fo-hotel-a.com',
        website: 'fo-hotel-a.com',
        bookingEngine: 'https://book.fo-hotel-a.com',
        whatsappNumber: '+32 3 200 11 00',
        vatNumber: 'BE0444111222',
        description: 'Test Hotel A for Front Office suite',
      },
    });

    await prisma.hotel.create({
      data: {
        id: hotelB,
        name: 'Hotel Mercier Beta',
        legalName: 'Mercier Beta BV',
        address: 'Kloosterstraat 88',
        postcode: '2000',
        city: 'Antwerp',
        country: 'Belgium',
        phone: '+32 3 200 22 00',
        email: 'info@fo-hotel-b.com',
        website: 'fo-hotel-b.com',
        bookingEngine: 'https://book.fo-hotel-b.com',
        whatsappNumber: '+32 3 200 22 00',
        vatNumber: 'BE0444333444',
        description: 'Test Hotel B for Front Office suite',
      },
    });

    // Create test users
    await prisma.user.create({
      data: {
        id: 'u-amelie-a',
        hotelId: hotelA,
        name: 'Amélie Duprez',
        email: 'amelie@fo-hotel-a.com',
        role: 'front-office',
        title: 'Front Office Receptionist',
      },
    });

    await prisma.user.create({
      data: {
        id: 'u-amelie-b',
        hotelId: hotelB,
        name: 'Amélie Beta',
        email: 'amelie@fo-hotel-b.com',
        role: 'front-office',
        title: 'Front Office Receptionist',
      },
    });

    // Create test rooms
    await prisma.room.create({
      data: {
        number: '101-FO-A',
        hotelId: hotelA,
        floor: 1,
        status: 'Clean',
        cleaningType: 'Stayover',
        guestStatus: 'Occupied',
        updatedAt: '08:00',
      },
    });

    await prisma.room.create({
      data: {
        number: '101-FO-B',
        hotelId: hotelB,
        floor: 1,
        status: 'Dirty',
        cleaningType: 'Departure',
        guestStatus: 'Vacant',
        updatedAt: '08:00',
      },
    });

    // Create test guests & reservations
    await prisma.guest.create({
      data: {
        id: 'g-fo-a1',
        hotelId: hotelA,
        name: 'Clara Bertrand',
        room: '101-FO-A',
        country: 'France',
        language: 'French',
        vip: true,
        tags: JSON.stringify(['VIP', 'Quiet room']),
        reservations: {
          create: {
            number: 'RES-FO-A1',
            arrival: 'Today',
            departure: 'Tomorrow',
            nights: 1,
            adults: 2,
            children: 0,
            roomType: 'Deluxe King',
            rate: '€189 / night',
          },
        },
      },
    });

    await prisma.guest.create({
      data: {
        id: 'g-fo-b1',
        hotelId: hotelB,
        name: 'Boris Becker',
        room: '101-FO-B',
        country: 'Germany',
        language: 'German',
        vip: false,
        tags: JSON.stringify(['Late checkout']),
        reservations: {
          create: {
            number: 'RES-FO-B1',
            arrival: 'Today',
            departure: 'Tomorrow',
            nights: 1,
            adults: 1,
            children: 0,
            roomType: 'Standard Room',
            rate: '€120 / night',
          },
        },
      },
    });

    // Create test conversations
    await prisma.conversation.create({
      data: {
        id: 'conv-fo-a1',
        guestId: 'g-fo-a1',
        stage: 'in-house',
        primaryChannel: 'whatsapp',
        aiStatus: 'ai-handling',
        sentiment: 'neutral',
        subject: 'Pillows request',
        summary: 'Guest requested extra pillows.',
        suggestedReply: 'We will bring extra pillows right away.',
        lastAt: '09:00',
        messages: {
          create: {
            id: 'msg-fo-a1-1',
            author: 'guest',
            channel: 'whatsapp',
            body: 'Can I have 2 extra pillows in room 101?',
            at: '09:00',
          },
        },
      },
    });

    await prisma.conversation.create({
      data: {
        id: 'conv-fo-b1',
        guestId: 'g-fo-b1',
        stage: 'in-house',
        primaryChannel: 'whatsapp',
        aiStatus: 'ai-handling',
        sentiment: 'neutral',
        subject: 'Taxi booking',
        summary: 'Guest wants a taxi to airport.',
        suggestedReply: 'Taxi booked for 14:00.',
        lastAt: '09:15',
        messages: {
          create: {
            id: 'msg-fo-b1-1',
            author: 'guest',
            channel: 'whatsapp',
            body: 'Please call a taxi for 2 PM.',
            at: '09:15',
          },
        },
      },
    });
  });

  after(async () => {
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.taskTrail.deleteMany({ where: { task: { hotelId: { in: [hotelA, hotelB] } } } });
    await prisma.task.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.message.deleteMany({ where: { conversation: { guest: { hotelId: { in: [hotelA, hotelB] } } } } });
    await prisma.conversation.deleteMany({ where: { guest: { hotelId: { in: [hotelA, hotelB] } } } });
    await prisma.reservation.deleteMany({ where: { guest: { hotelId: { in: [hotelA, hotelB] } } } });
    await prisma.guest.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.room.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.user.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } });

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('1. Front Office login with valid credentials returns JWT token and user info', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'amelie@fo-hotel-a.com', userId: 'u-amelie-a' }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.token);
    assert.equal(json.data.user.role, 'front-office');
    assert.equal(json.data.user.email, 'amelie@fo-hotel-a.com');
  });

  test('2. Invalid login credentials rejected (404 / 401)', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nonexistent-user@nowhere.com' }),
    });
    assert.equal(res.status, 404);
  });

  test('3. Tenant A Front Office retrieves conversations for Hotel A only (Tenant Isolation)', async () => {
    const res = await fetch(`${baseUrl}/conversations`, {
      headers: { Authorization: `Bearer ${foTokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].id, 'conv-fo-a1');
    assert.equal(json.data[0].guest.name, 'Clara Bertrand');
    assert.ok(json.data[0].channels.includes('whatsapp'));
  });

  test('4. Tenant B Front Office retrieves conversations for Hotel B only', async () => {
    const res = await fetch(`${baseUrl}/conversations`, {
      headers: { Authorization: `Bearer ${foTokenB}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].id, 'conv-fo-b1');
    assert.equal(json.data[0].guest.name, 'Boris Becker');
  });

  test('5. Tenant A cannot retrieve Tenant B conversation details (404)', async () => {
    const res = await fetch(`${baseUrl}/conversations/conv-fo-b1`, {
      headers: { Authorization: `Bearer ${foTokenA}` },
    });
    assert.equal(res.status, 404);
  });

  test('6. Front Office sends reply to guest, persists message and updates lastAt in database', async () => {
    const res = await fetch(`${baseUrl}/conversations/conv-fo-a1/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${foTokenA}`,
      },
      body: JSON.stringify({
        body: 'Hello Clara, housekeeping will bring 2 pillows immediately.',
        staffName: 'Amélie Duprez',
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.author, 'staff');
    assert.equal(json.data.body, 'Hello Clara, housekeeping will bring 2 pillows immediately.');

    // Verify conversation updated in DB
    const updated = await prisma.conversation.findUnique({ where: { id: 'conv-fo-a1' } });
    assert.equal(updated.aiStatus, 'human-takeover');
    assert.equal(updated.unread, 0);

    // Verify Message row in DB
    const msgs = await prisma.message.findMany({ where: { conversationId: 'conv-fo-a1' } });
    assert.equal(msgs.length, 2);
  });

  test('7. Tenant A cannot reply to Tenant B conversation (404)', async () => {
    const res = await fetch(`${baseUrl}/conversations/conv-fo-b1/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${foTokenA}`,
      },
      body: JSON.stringify({ body: 'Unauthorized reply attempt' }),
    });
    assert.equal(res.status, 404);
  });

  test('8. Front Office toggles AI Takeover and returns conversation to AI', async () => {
    // Hand back to AI
    const res = await fetch(`${baseUrl}/conversations/conv-fo-a1/takeover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${foTokenA}`,
      },
      body: JSON.stringify({ aiStatus: 'ai-handling' }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.aiStatus, 'ai-handling');

    const inDb = await prisma.conversation.findUnique({ where: { id: 'conv-fo-a1' } });
    assert.equal(inDb.aiStatus, 'ai-handling');
  });

  test('9. Front Office escalates conversation to manager', async () => {
    const res = await fetch(`${baseUrl}/conversations/conv-fo-a1/escalate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${foTokenA}`,
      },
      body: JSON.stringify({
        reason: 'Guest requesting late checkout beyond policy',
        urgency: 'High',
        suggested: 'Offer complimentary 12:30 or €30 until 14:00',
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.aiStatus, 'escalated');
    assert.equal(json.data.escalation.reason, 'Guest requesting late checkout beyond policy');

    const inDb = await prisma.conversation.findUnique({ where: { id: 'conv-fo-a1' } });
    assert.equal(inDb.aiStatus, 'escalated');
  });

  test('10. Front Office resolves conversation', async () => {
    const res = await fetch(`${baseUrl}/conversations/conv-fo-a1/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${foTokenA}`,
      },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.aiStatus, 'resolved');

    const inDb = await prisma.conversation.findUnique({ where: { id: 'conv-fo-a1' } });
    assert.equal(inDb.aiStatus, 'resolved');
  });

  let createdTaskId;

  test('11. Front Office creates a task with TaskTrail audit entry', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${foTokenA}`,
      },
      body: JSON.stringify({
        title: 'Deliver 2 extra hypoallergenic pillows',
        detail: 'For Clara Bertrand in Room 101-FO-A',
        room: '101-FO-A',
        guest: 'Clara Bertrand',
        department: 'Housekeeping',
        priority: 'High',
        due: '10:00',
        assignee: 'Maria Silva',
        source: 'Front Office',
        conversationId: 'conv-fo-a1',
      }),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.title, 'Deliver 2 extra hypoallergenic pillows');
    assert.equal(json.data.department, 'Housekeeping');
    createdTaskId = json.data.id;

    // Verify persisted Task and TaskTrail
    const taskInDb = await prisma.task.findUnique({
      where: { id: createdTaskId },
      include: { trail: true },
    });
    assert.ok(taskInDb);
    assert.equal(taskInDb.hotelId, hotelA);
    assert.equal(taskInDb.trail.length, 1);
  });

  test('12. Front Office retrieves tasks for Hotel A (Tenant Isolation)', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      headers: { Authorization: `Bearer ${foTokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].id, createdTaskId);
  });

  test('13. Tenant B Front Office cannot see Tenant A task (Tenant Isolation)', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      headers: { Authorization: `Bearer ${foTokenB}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.length, 0);
  });

  test('14. Front Office updates task status to Completed and appends TaskTrail entry', async () => {
    const res = await fetch(`${baseUrl}/tasks/${createdTaskId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${foTokenA}`,
      },
      body: JSON.stringify({
        status: 'Completed',
        note: 'Pillows delivered by Maria Silva',
        via: 'whatsapp',
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.status, 'Completed');

    // Verify in DB
    const taskInDb = await prisma.task.findUnique({
      where: { id: createdTaskId },
      include: { trail: true },
    });
    assert.equal(taskInDb.status, 'Completed');
    assert.equal(taskInDb.trail.length, 2);
    assert.ok(taskInDb.trail.some((t) => t.text.includes('Pillows delivered')));
  });

  test('15. Tenant B cannot update Tenant A task (404)', async () => {
    const res = await fetch(`${baseUrl}/tasks/${createdTaskId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${foTokenB}`,
      },
      body: JSON.stringify({ status: 'Cancelled' }),
    });
    assert.equal(res.status, 404);
  });

  test('16. Front Office retrieves live rooms for Hotel A', async () => {
    const res = await fetch(`${baseUrl}/rooms`, {
      headers: { Authorization: `Bearer ${foTokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].number, '101-FO-A');
  });

  test('17. Front Office updates room status', async () => {
    const res = await fetch(`${baseUrl}/rooms/101-FO-A/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${foTokenA}`,
      },
      body: JSON.stringify({
        status: 'Inspected',
        cleaner: 'Maria Silva',
        note: 'Inspected by Front Office',
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.status, 'Inspected');

    const inDb = await prisma.room.findUnique({ where: { number: '101-FO-A' } });
    assert.equal(inDb.status, 'Inspected');
  });
});
