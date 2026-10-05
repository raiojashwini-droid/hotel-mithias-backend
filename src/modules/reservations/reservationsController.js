import { reservationsService } from './reservationsService.js';
import { errorResponse, successResponse } from '../../utils/response.js';

export const getReservationsController = async (req, res) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const reservations = await reservationsService.getReservations(hotelId);
    return successResponse(res, reservations, 'Reservations retrieved successfully');
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

export const getReservationByNumberController = async (req, res) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const reservation = await reservationsService.getReservationByNumber(hotelId, req.params.number);
    if (!reservation) {
      return errorResponse(res, 'Reservation not found', 404);
    }
    return successResponse(res, reservation, 'Reservation details retrieved successfully');
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};
