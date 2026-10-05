import { prisma } from '../../config/database.js';
import { errorResponse, successResponse } from '../../utils/response.js';
import { realtimeService } from '../../services/realtimeService.js';

export const getUpsells = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return successResponse(res, [], 'Upsells pipeline');
    }
    const { status } = req.query;
    const where = { hotelId };
    if (status) where.status = status;

    const upsells = await prisma.upsell.findMany({
      where,
      orderBy: { date: 'desc' },
    });
    return successResponse(res, upsells, 'Upsells pipeline');
  } catch (error) {
    next(error);
  }
};

export const updateUpsellStatus = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return errorResponse(res, 'Unauthorized', 401);
    }
    const { id } = req.params;
    const { status } = req.body;

    const existing = await prisma.upsell.findFirst({
      where: { id, hotelId },
    });
    if (!existing) {
      return errorResponse(res, 'Upsell not found', 404);
    }

    const updated = await prisma.upsell.update({
      where: { id },
      data: { status },
    });

    realtimeService.broadcastToHotel(hotelId, 'upsell:updated', updated);

    return successResponse(res, updated, `Upsell updated to ${status}`);
  } catch (error) {
    next(error);
  }
};
