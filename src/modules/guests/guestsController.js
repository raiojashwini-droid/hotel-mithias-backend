import { guestsService } from './guestsService.js';
import { errorResponse, successResponse } from '../../utils/response.js';

export const getGuestsController = async (req, res) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const guests = await guestsService.getGuests(hotelId);
    return successResponse(res, guests, 'Guests retrieved successfully');
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

export const getGuestByIdController = async (req, res) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const guest = await guestsService.getGuestById(hotelId, req.params.id);
    if (!guest) {
      return errorResponse(res, 'Guest not found', 404);
    }
    return successResponse(res, guest, 'Guest details retrieved successfully');
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};
