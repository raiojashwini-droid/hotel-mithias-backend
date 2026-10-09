import { Router } from 'express';
import { getReservationsController, getReservationByNumberController } from './reservationsController.js';
import { authenticate } from '../../middlewares/auth.js';

const router = Router();

router.get('/', authenticate, getReservationsController);
router.get('/:number', authenticate, getReservationByNumberController);

export default router;
