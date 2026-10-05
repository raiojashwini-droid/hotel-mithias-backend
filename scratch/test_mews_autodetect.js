import dotenv from 'dotenv';
dotenv.config();

import { MewsClient } from '../src/modules/pms/mewsClient.js';

async function run() {
  console.log('--- TEST 1: LIVE DEMO TOKEN AUTO-DETECTION ---');
  const demoToken = 'C66EF7B239D24632943D115EDE9CB810-EA00F8FD8294692C940F6B5A8F9453D';
  const client = new MewsClient();
  
  try {
    const res = await client.validateEnterpriseAccess(demoToken);
    console.log('Test 1 Success:', {
      status: res.status,
      environment: res.environment,
      propertyId: res.propertyId,
      propertyName: res.enterpriseName,
    });
    
    // Now fetch resources to confirm token routed correctly
    const resources = await client.getResources(demoToken, { limit: 5 });
    console.log(`Successfully fetched ${resources.length} live rooms/spaces from Mews!`);
  } catch (err) {
    console.error('Test 1 Failed:', err.message);
  }

  console.log('\n--- TEST 2: INVALID TOKEN GRACEFUL REJECTION ---');
  const fakeToken = 'INVALID_TOKEN_FOR_TESTING_12345';
  try {
    await client.validateEnterpriseAccess(fakeToken);
    console.error('Test 2 should have failed but passed!');
  } catch (err) {
    console.log('Test 2 Passed with clean error:', err.message);
  }
}

run();
