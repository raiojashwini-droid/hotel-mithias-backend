import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { getRooms, getRoomByNumber, updateRoomStatus } from './roomsController.js';

const router = Router();

// All Housekeeping room endpoints require a valid JWT
router.get('/', authenticate, getRooms);
router.get('/:number', authenticate, getRoomByNumber);
router.patch('/:number/status', authenticate, updateRoomStatus);

export default router;
