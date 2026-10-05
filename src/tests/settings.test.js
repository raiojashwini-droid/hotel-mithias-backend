import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { prisma } from '../config/database.js';
import { signToken } from '../utils/jwt.js';

describe('Settings Integration Automated Test Suite (Users & Roles + Subscription & Billing)', () => {
  let server;
  let baseUrl;
  let tokenA;
  let tokenB;
  const hotelA = 'test-hotel-set-a';
  const hotelB = 'test-hotel-set-b';

  let createdUserAId;
  let createdUserBId;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    tokenA = signToken({ id: 'u-jonas', role: 'manager', email: 'jonas@hotelmercier.be', hotelId: hotelA });
    tokenB = signToken({ id: 'u-amelie', role: 'manager', email: 'amelie@hotelmercier.be', hotelId: hotelB });

    // Clean prior test records
    await prisma.invoice.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.subscription.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.user.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } });

    // Create test hotels
    await prisma.hotel.create({
      data: {
        id: hotelA,
        name: 'Hotel Alpha Settings',
        legalName: 'Hotel Alpha BV',
        address: 'Alpha Ave 1',
        postcode: '1000',
        city: 'Brussels',
        country: 'Belgium',
        phone: '+32 2 111 22 33',
        email: 'info@hotel-alpha.com',
        website: 'hotel-alpha.com',
        bookingEngine: 'https://book.hotel-alpha.com',
        whatsappNumber: '+32 2 111 22 33',
        vatNumber: 'BE0111222333',
        description: 'Test Hotel Alpha',
      },
    });

    await prisma.hotel.create({
      data: {
        id: hotelB,
        name: 'Hotel Beta Settings',
        legalName: 'Hotel Beta BV',
        address: 'Beta Ave 2',
        postcode: '2000',
        city: 'Antwerp',
        country: 'Belgium',
        phone: '+32 3 444 55 66',
        email: 'info@hotel-beta.com',
        website: 'hotel-beta.com',
        bookingEngine: 'https://book.hotel-beta.com',
        whatsappNumber: '+32 3 444 55 66',
        vatNumber: 'BE0444555666',
        description: 'Test Hotel Beta',
      },
    });
  });

  after(async () => {
    await prisma.invoice.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.subscription.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.user.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } });

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  /* ------------------------------ USERS & ROLES ------------------------------ */

  test('1. Reject GET /api/users without JWT authentication (401)', async () => {
    const res = await fetch(`${baseUrl}/users`);
    assert.equal(res.status, 401);
  });

  test('2. GET /api/users with valid JWT returns empty array for new hotel', async () => {
    const res = await fetch(`${baseUrl}/users`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data));
  });

  test('3. Tenant A invites a new receptionist user (201)', async () => {
    const res = await fetch(`${baseUrl}/users/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        email: 'sarah.reception@hotel-alpha.com',
        role: 'front-office',
        name: 'Sarah Connor',
        title: 'Senior Receptionist',
      }),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.email, 'sarah.reception@hotel-alpha.com');
    assert.equal(json.data.role, 'front-office');
    createdUserAId = json.data.id;
  });

  test('4. Reject duplicate user invitation for the same email (409)', async () => {
    const res = await fetch(`${baseUrl}/users/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        email: 'sarah.reception@hotel-alpha.com',
        role: 'front-office',
      }),
    });
    assert.equal(res.status, 409);
  });

  test('5. Reject invalid user role during invitation (400)', async () => {
    const res = await fetch(`${baseUrl}/users/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        email: 'invalid.role@hotel-alpha.com',
        role: 'superadmin_nonexistent',
      }),
    });
    assert.equal(res.status, 400);
  });

  test('6. Tenant A updates user role to housekeeping (200)', async () => {
    const res = await fetch(`${baseUrl}/users/${createdUserAId}/role`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ role: 'housekeeping' }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.role, 'housekeeping');
  });

  test('7. Tenant B invites a user (201)', async () => {
    const res = await fetch(`${baseUrl}/users/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        email: 'lucas.tech@hotel-beta.com',
        role: 'maintenance',
        name: 'Lucas Tech',
      }),
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    createdUserBId = json.data.id;
  });

  test('8. Tenant A cannot see Tenant B users (Tenant Isolation)', async () => {
    const resA = await fetch(`${baseUrl}/users`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const jsonA = await resA.json();
    assert.ok(!jsonA.data.some((u) => u.email === 'lucas.tech@hotel-beta.com'));
  });

  test('9. Tenant A cannot modify Tenant B user role (404 / denied)', async () => {
    const res = await fetch(`${baseUrl}/users/${createdUserBId}/role`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ role: 'manager' }),
    });
    assert.equal(res.status, 404);
  });

  test('10. Tenant A cannot delete Tenant B user (404 / denied)', async () => {
    const res = await fetch(`${baseUrl}/users/${createdUserBId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 404);
  });

  test('11. Tenant A deletes its own user (200)', async () => {
    const res = await fetch(`${baseUrl}/users/${createdUserAId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);

    // Verify deletion
    const checkRes = await fetch(`${baseUrl}/users`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const checkJson = await checkRes.json();
    assert.ok(!checkJson.data.some((u) => u.id === createdUserAId));
  });

  /* ------------------------ SUBSCRIPTION & BILLING ------------------------ */

  test('12. Reject GET /api/billing/subscription without JWT (401)', async () => {
    const res = await fetch(`${baseUrl}/billing/subscription`);
    assert.equal(res.status, 401);
  });

  test('13. GET /api/billing/subscription returns seeded active Pro subscription and invoices', async () => {
    const res = await fetch(`${baseUrl}/billing/subscription`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.plan, 'pro');
    assert.equal(json.data.status, 'Active');
    assert.ok(json.data.invoices.length > 0);
  });

  test('14. Tenant A updates subscription to Enterprise yearly (200)', async () => {
    const res = await fetch(`${baseUrl}/billing/subscription`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        plan: 'enterprise',
        billingCycle: 'yearly',
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.plan, 'enterprise');
    assert.equal(json.data.billingCycle, 'yearly');
  });

  test('15. Reject PUT /api/billing/subscription with invalid plan (400)', async () => {
    const res = await fetch(`${baseUrl}/billing/subscription`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ plan: 'unlimited_super_plan_fake' }),
    });
    assert.equal(res.status, 400);
  });

  test('16. GET /api/billing/invoices returns invoices for Tenant A', async () => {
    const res = await fetch(`${baseUrl}/billing/invoices`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.data.length > 0);
  });

  test('17. Tenant B gets default Pro monthly subscription without seeing Tenant A Enterprise plan (Tenant Isolation)', async () => {
    const res = await fetch(`${baseUrl}/billing/subscription`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.plan, 'pro', 'Tenant B must still have Pro plan');
    assert.equal(json.data.billingCycle, 'monthly', 'Tenant B must still have monthly cycle');
  });

  test('18. Tenant B changes to Starter plan without affecting Tenant A', async () => {
    const res = await fetch(`${baseUrl}/billing/subscription`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ plan: 'starter' }),
    });
    assert.equal(res.status, 200);

    // Verify Tenant A still has Enterprise
    const resA = await fetch(`${baseUrl}/billing/subscription`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const jsonA = await resA.json();
    assert.equal(jsonA.data.plan, 'enterprise');
  });

  /* ------------------------------ REGRESSION ------------------------------ */

  test('19. Regression Check: Existing Health, Onboarding Profile, AI Rules, and Knowledge endpoints work', async () => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const profile = await fetch(`${baseUrl}/onboarding/profile`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(profile.status, 200);

    const rules = await fetch(`${baseUrl}/manager/rules`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(rules.status, 200);

    const knowledge = await fetch(`${baseUrl}/knowledge`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(knowledge.status, 200);
  });
});
