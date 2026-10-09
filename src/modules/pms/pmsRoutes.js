import { Router } from 'express';
import {
  connectPmsController,
  disconnectPmsController,
  getPmsStatusController,
  syncPmsController,
  checkAvailabilityController,
  mewsWebhookController,
  getPmsRoomsController,
  getPmsReservationsController,
  updatePmsRoomStatusController,
  getPmsServicesController,
} from './pmsController.js';
import { authenticate } from '../../middlewares/auth.js';

const router = Router();

// Authenticated PMS management endpoints
router.post('/connect', authenticate, connectPmsController);
router.post('/disconnect', authenticate, disconnectPmsController);
router.post('/verify', authenticate, connectPmsController);
router.get('/status', authenticate, getPmsStatusController);
router.post('/sync', authenticate, syncPmsController);
router.get('/availability', checkAvailabilityController);

// Live room, reservation, and services endpoints
router.get('/rooms', authenticate, getPmsRoomsController);
router.get('/reservations', authenticate, getPmsReservationsController);
router.patch('/rooms/:number/status', authenticate, updatePmsRoomStatusController);
router.put('/rooms/:number/status', authenticate, updatePmsRoomStatusController);
router.get('/services', authenticate, getPmsServicesController);

// Public Mews Webhook Receiver (validated via payload/headers inside controller)
router.post('/webhook', mewsWebhookController);
router.post('/webhook/mews', mewsWebhookController);

export default router;

