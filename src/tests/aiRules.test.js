import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { prisma } from '../config/database.js';
import { signToken } from '../utils/jwt.js';

describe('Phase 8 Configure AI Behaviour Automated E2E Test Suite', () => {
  let server;
  let baseUrl;
  let tokenA;
  let tokenB;
  const hotelA = 'test-hotel-ai-a';
  const hotelB = 'test-hotel-ai-b';

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api`;

    tokenA = signToken({ id: 'u-jonas', role: 'manager', email: 'jonas@hotelmercier.be', hotelId: hotelA });
    tokenB = signToken({ id: 'u-amelie', role: 'manager', email: 'amelie@hotelmercier.be', hotelId: hotelB });

    // Clean any prior test records for these test hotels
    await prisma.aiRule.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } });

    // Create test hotel records
    await prisma.hotel.create({
      data: {
        id: hotelA,
        name: 'Test Hotel Alpha AI',
        legalName: 'Test Hotel Alpha BV',
        address: 'Alpha St 1',
        postcode: '1000',
        city: 'Brussels',
        country: 'Belgium',
        phone: '+32 2 111 22 33',
        email: 'info@hotel-ai-a.com',
        website: 'hotel-ai-a.com',
        bookingEngine: 'https://book.hotel-ai-a.com',
        whatsappNumber: '+32 2 111 22 33',
        vatNumber: 'BE0123456789',
        description: 'Test Hotel A',
        aiMode: 'Autonomous',
      },
    });

    await prisma.hotel.create({
      data: {
        id: hotelB,
        name: 'Test Hotel Beta AI',
        legalName: 'Test Hotel Beta BV',
        address: 'Beta St 2',
        postcode: '2000',
        city: 'Antwerp',
        country: 'Belgium',
        phone: '+32 3 444 55 66',
        email: 'info@hotel-ai-b.com',
        website: 'hotel-ai-b.com',
        bookingEngine: 'https://book.hotel-ai-b.com',
        whatsappNumber: '+32 3 444 55 66',
        vatNumber: 'BE0987654321',
        description: 'Test Hotel B',
        aiMode: 'Autonomous',
      },
    });
  });

  after(async () => {
    await prisma.aiRule.deleteMany({ where: { hotelId: { in: [hotelA, hotelB] } } });
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } });

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('1. Reject PUT /api/manager/rules without JWT authentication (401)', async () => {
    const res = await fetch(`${baseUrl}/manager/rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiMode: 'Approval Required' }),
    });
    assert.equal(res.status, 401);
  });

  test('2. Reject PUT /api/manager/rules with invalid aiMode value (400)', async () => {
    const res = await fetch(`${baseUrl}/manager/rules`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({ aiMode: 'Invalid_Mode_XYZ' }),
    });
    assert.equal(res.status, 400);
  });

  test('3. Tenant A gets seeded default 12 rules and default aiMode', async () => {
    const res = await fetch(`${baseUrl}/manager/rules`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.aiMode, 'Autonomous');
    assert.equal(json.data.rules.length, 12);
    assert.ok(json.data.rules.every((r) => r.hotelId === hotelA));
  });

  test('4. Tenant A updates global aiMode to Approval Required and General questions rule to Human Approval', async () => {
    const res = await fetch(`${baseUrl}/manager/rules`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        aiMode: 'Approval Required',
        rules: [
          { topic: 'General questions', mode: 'Approve', note: 'Approval required for all inquiries' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.aiMode, 'Approval Required');

    const generalRule = json.data.rules.find((r) => r.topic === 'General questions');
    assert.ok(generalRule);
    assert.equal(generalRule.mode, 'Human Approval');
  });

  test('5. Tenant A settings persist in database after simulated reload', async () => {
    const res = await fetch(`${baseUrl}/manager/rules`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.aiMode, 'Approval Required');
    const generalRule = json.data.rules.find((r) => r.topic === 'General questions');
    assert.equal(generalRule.mode, 'Human Approval');
    assert.equal(generalRule.hotelId, hotelA);
  });

  test('6. Tenant B receives independent rules and does NOT see Tenant A customized settings (Tenant Isolation)', async () => {
    const res = await fetch(`${baseUrl}/manager/rules`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.aiMode, 'Autonomous', 'Tenant B must still have its own default aiMode');
    const generalRuleB = json.data.rules.find((r) => r.topic === 'General questions');
    assert.equal(generalRuleB.mode, 'Autonomous', 'Tenant B General questions rule must NOT be affected by Tenant A');
    assert.equal(generalRuleB.hotelId, hotelB);
  });

  test('7. Tenant B updates aiMode to Suggestions Only without affecting Tenant A', async () => {
    const res = await fetch(`${baseUrl}/manager/rules`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        aiMode: 'Suggestions Only',
      }),
    });
    assert.equal(res.status, 200);

    // Verify Tenant A still has Approval Required
    const resA = await fetch(`${baseUrl}/manager/rules`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const jsonA = await resA.json();
    assert.equal(jsonA.data.aiMode, 'Approval Required', 'Tenant A aiMode must remain Approval Required');

    // Verify Tenant B has Suggestions Only
    const resB = await fetch(`${baseUrl}/manager/rules`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const jsonB = await resB.json();
    assert.equal(jsonB.data.aiMode, 'Suggestions Only', 'Tenant B aiMode must be Suggestions Only');
  });
});
