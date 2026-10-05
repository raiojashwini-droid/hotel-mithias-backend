import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { prisma } from '../config/database.js';

describe('Mews PMS Live Webhook & Real-Time Sync Test Suite', () => {
  let server;
  let baseUrl;
  const hotelId = 'test-hotel-mews-live';

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    // Clean prior test data
    await prisma.activityItem.deleteMany({ where: { hotelId } });
    await prisma.reservation.deleteMany({ where: { hotelId } });
    await prisma.room.deleteMany({ where: { hotelId } });
    await prisma.hotel.deleteMany({ where: { id: hotelId } });

    // Seed test hotel and test room
    await prisma.hotel.create({
      data: {
        id: hotelId,
        name: 'Grand Mews Test Hotel',
        legalName: 'Grand Mews BV',
        address: 'Mews Street 10',
        postcode: '2000',
        city: 'Antwerp',
        country: 'Belgium',
        phone: '+32 3 227 41 00',
        email: 'test@mews.be',
        website: 'mews.be',
        bookingEngine: 'mews.be/book',
        whatsappNumber: '+32 3 227 41 08',
        vatNumber: 'BE 0123.456.789',
        description: 'Mews webhook test hotel',
        onboardingDone: true,
      },
    });

    await prisma.room.upsert({
      where: { number: '904' },
      update: {
        hotelId,
        floor: 9,
        status: 'Clean',
        guestStatus: 'Vacant',
        updatedAt: '10:45',
      },
      create: {
        number: '904',
        hotelId,
        floor: 9,
        status: 'Clean',
        guestStatus: 'Vacant',
        updatedAt: '10:45',
      },
    });
  });

  after(async () => {
    await prisma.activityItem.deleteMany({ where: { hotelId } });
    await prisma.reservation.deleteMany({ where: { hotelId } });
    await prisma.guest.deleteMany({ where: { hotelId } });
    await prisma.room.deleteMany({ where: { number: '904' } });
    await prisma.hotel.deleteMany({ where: { id: hotelId } });
    await new Promise((resolve) => server.close(resolve));
  });

  test('1. SSE Realtime Stream accepts connection and responds with initial greeting', async () => {
    const ac = new AbortController();
    const sseRes = await fetch(`${baseUrl}/realtime/events?hotelId=${hotelId}`, { signal: ac.signal });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('content-type'), 'text/event-stream');

    const reader = sseRes.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.ok(text.includes('connected to hotelogx realtime stream'));
    reader.cancel();
    ac.abort();
  });

  test('2. POST /api/pms/webhook processes guest check-in, updates Room, Reservation & ActivityItem', async () => {
    const checkInPayload = {
      event: 'ReservationUpdate',
      hotelId,
      data: {
        reservationId: 'mews-res-10499',
        customerName: 'Lucas Moreau',
        roomNumber: '904',
        status: 'In House',
        state: 'Processed',
        startUtc: '2026-09-07T14:00:00Z',
        endUtc: '2026-09-09T11:00:00Z',
      },
    };

    const res = await fetch(`${baseUrl}/pms/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(checkInPayload),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.processedCount, 1);

    // Verify DB State
    const updatedRoom = await prisma.room.findFirst({
      where: { number: '904' },
    });
    assert.equal(updatedRoom.guestStatus, 'Occupied');

    const reservation = await prisma.reservation.findUnique({
      where: { number: 'mews-res-10499' },
    });
    assert.ok(reservation);
    assert.equal(reservation.status, 'In House');

    const guest = await prisma.guest.findUnique({
      where: { id: 'gst_mews-res-10499' },
    });
    assert.ok(guest);
    assert.equal(guest.name, 'Lucas Moreau');
    assert.equal(guest.room, '904');

    const activities = await prisma.activityItem.findMany({
      where: { hotelId },
    });
    assert.ok(activities.some((a) => a.text.includes('Lucas Moreau checked in to Room 904')));
  });

  test('3. POST /api/pms/webhook/mews processes room state change (Dirty) & logs activity', async () => {
    const roomDirtyPayload = {
      Events: [
        {
          Type: 'ResourceStateUpdate',
          Discriminator: 'ResourceState',
          Value: {
            roomNumber: '904',
            status: 'Dirty',
          },
        },
      ],
      hotelId,
    };

    const res = await fetch(`${baseUrl}/pms/webhook/mews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roomDirtyPayload),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    const room = await prisma.room.findFirst({
      where: { number: '904' },
    });
    assert.equal(room.status, 'Dirty');

    const activities = await prisma.activityItem.findMany({
      where: { hotelId },
    });
    assert.ok(activities.some((a) => a.text.includes('Room 904 status updated to Dirty')));
  });
});
