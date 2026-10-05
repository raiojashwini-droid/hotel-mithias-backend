import dotenv from 'dotenv';
dotenv.config();

import { pmsService } from '../src/modules/pms/pmsService.js';

async function run() {
  console.log('Testing full PMS sync with auto-detection...');
  const result = await pmsService.syncPmsData('new-hotel-bw6l2q');
  console.log('Sync Result:', result);
}

run();
