import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { prisma } from '../config/database.js';
import { signToken } from '../utils/jwt.js';

describe('General Manager Module Full-Stack Automated Test Suite', () => {
  let server;
  let baseUrl;
  let managerTokenA;
  let managerTokenB;
  const hotelA = 'test-gm-hotel-a';
  const hotelB = 'test-gm-hotel-b';

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    managerTokenA = signToken({ id: 'u-jonas', role: 'manager', email: 'jonas@hotelmercier.be', hotelId: hotelA });
    managerTokenB = signToken({ id: 'u-amelie', role: 'manager', email: 'amelie@hotelmercier.be', hotelId: hotelB });

    // Clean test data
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.issue.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.task.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.upsell.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.subscription.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.user.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } });

    // Create test hotels
    await prisma.hotel.create({
      data: {
        id: hotelA,
        name: 'Grand Horizon GM A',
        legalName: 'Grand Horizon BV',
        address: 'Boulevard 1',
        postcode: '1000',
        city: 'Brussels',
        country: 'Belgium',
        phone: '+32 2 999 00 11',
        email: 'gm@grandhorizon.be',
        website: 'grandhorizon.be',
        bookingEngine: 'https://book.grandhorizon.be',
        whatsappNumber: '+32 2 999 00 11',
        vatNumber: 'BE0999000111',
        description: 'Luxury hotel for GM test suite',
      },
    });

    await prisma.hotel.create({
      data: {
        id: hotelB,
        name: 'Grand Horizon GM B',
        legalName: 'Grand Horizon Beta BV',
        address: 'Boulevard 2',
        postcode: '2000',
        city: 'Antwerp',
        country: 'Belgium',
        phone: '+32 3 888 00 22',
        email: 'gm@grandhorizon-beta.be',
        website: 'grandhorizon-beta.be',
        bookingEngine: 'https://book.grandhorizon-beta.be',
        whatsappNumber: '+32 3 888 00 22',
        vatNumber: 'BE0888000222',
        description: 'Second hotel for GM tenant isolation',
      },
    });

    // Create initial activities for Hotel A
    await prisma.activityItem.create({
      data: {
        id: `act-${Date.now()}-1`,
        hotelId: hotelA,
        at: '10:00',
        kind: 'system',
        text: 'System health check completed successfully',
        meta: 'automated',
      },
    });
  });

  after(async () => {
    await prisma.activityItem.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.issue.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.task.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.upsell.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.subscription.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.user.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } });

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  /* ------------------- DASHBOARD & BRIEFING ------------------- */

  test('1. GET /api/manager/briefing returns real dynamic hotel name and aggregated metrics', async () => {
    const res = await fetch(`${baseUrl}/manager/briefing`, {
      headers: { Authorization: `Bearer ${managerTokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.hotelName, 'Grand Horizon GM A');
    assert.ok(typeof json.data.occupancy.total === 'number');
    assert.ok(typeof json.data.operations.openTasks === 'number');
  });

  test('2. GET /api/manager/activity returns activity feed for Hotel A', async () => {
    const res = await fetch(`${baseUrl}/manager/activity`, {
      headers: { Authorization: `Bearer ${managerTokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.data.some((a) => a.text.includes('System health check')));
  });

  test('3. Tenant B does NOT see Tenant A activity items (Tenant Isolation)', async () => {
    const res = await fetch(`${baseUrl}/manager/activity`, {
      headers: { Authorization: `Bearer ${managerTokenB}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(!json.data.some((a) => a.text.includes('System health check')));
  });

  /* ---------------------- TASKS PIPELINE ---------------------- */

  test('4. General Manager creates a task (201)', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerTokenA}`,
      },
      body: JSON.stringify({
        title: 'VIP Champagne Setup in Suite 401',
        detail: 'Prepare vintage bottle and chilled flutes before 16:00',
        department: 'Front Office',
        priority: 'High',
        room: '401',
      }),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.title, 'VIP Champagne Setup in Suite 401');
    assert.equal(json.data.status, 'New');
  });

  test('5. General Manager retrieves tasks and verifies new task exists', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      headers: { Authorization: `Bearer ${managerTokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.data.some((t) => t.title === 'VIP Champagne Setup in Suite 401'));
  });

  /* --------------------- UPSELLS PIPELINE --------------------- */

  test('6. General Manager retrieves upsells pipeline', async () => {
    const res = await fetch(`${baseUrl}/upsells`, {
      headers: { Authorization: `Bearer ${managerTokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data));
  });

  /* ------------------- SETTINGS & AI BEHAVIOUR ------------------- */

  test('7. General Manager retrieves and updates AI Rules', async () => {
    const getRes = await fetch(`${baseUrl}/manager/rules`, {
      headers: { Authorization: `Bearer ${managerTokenA}` },
    });
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.ok(getJson.data.rules.length > 0);

    const putRes = await fetch(`${baseUrl}/manager/rules`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerTokenA}`,
      },
      body: JSON.stringify({
        aiMode: 'Autonomous',
        rules: [{ topic: 'VIP guests', mode: 'Human Approval' }],
      }),
    });
    assert.equal(putRes.status, 200);
    const putJson = await putRes.json();
    assert.equal(putJson.data.aiMode, 'Autonomous');
  });

  /* ----------------- USERS & ROLES IN GM FLOW ----------------- */

  test('8. General Manager invites team member and updates role', async () => {
    const inviteRes = await fetch(`${baseUrl}/users/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerTokenA}`,
      },
      body: JSON.stringify({
        email: 'elena.rodriguez@grandhorizon.be',
        role: 'front-office',
        name: 'Elena Rodriguez',
        title: 'Duty Manager',
      }),
    });
    assert.equal(inviteRes.status, 201);
    const inviteJson = await inviteRes.json();
    const userId = inviteJson.data.id;

    const updateRoleRes = await fetch(`${baseUrl}/users/${userId}/role`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerTokenA}`,
      },
      body: JSON.stringify({ role: 'manager' }),
    });
    assert.equal(updateRoleRes.status, 200);

    const deleteRes = await fetch(`${baseUrl}/users/${userId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${managerTokenA}` },
    });
    assert.equal(deleteRes.status, 200);
  });

  /* ---------------- SUBSCRIPTION & BILLING IN GM FLOW ---------------- */

  test('9. General Manager retrieves subscription and invoice history', async () => {
    const subRes = await fetch(`${baseUrl}/billing/subscription`, {
      headers: { Authorization: `Bearer ${managerTokenA}` },
    });
    assert.equal(subRes.status, 200);
    const subJson = await subRes.json();
    assert.equal(subJson.data.plan, 'pro');
    assert.ok(subJson.data.invoices.length > 0);
  });
});
