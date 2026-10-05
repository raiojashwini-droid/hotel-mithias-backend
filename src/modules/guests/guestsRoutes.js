import { Router } from 'express';
import { getGuestsController, getGuestByIdController } from './guestsController.js';
import { authenticate } from '../../middlewares/auth.js';

const router = Router();

const resolveHotelContext = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }
  if (process.env.DEMO_MODE === 'true') {
    req.user = { id: 'u-jonas', hotelId: 'hotel-mercier', role: 'MANAGER' };
    return next();
  }
  return res.status(401).json({ success: false, message: 'Authentication required. Missing or invalid Bearer token.', data: null });
};

router.get('/', resolveHotelContext, getGuestsController);
router.get('/:id', resolveHotelContext, getGuestByIdController);

export default router;
