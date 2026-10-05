import { prisma } from '../../config/database.js';

export const guestsService = {
  /**
   * Fetch all guests belonging to the authenticated hotel/tenant
   */
  async getGuests(hotelId) {
    let targetHotelId = hotelId;
    let hotelExists = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotelExists) {
      const defaultHotel = await prisma.hotel.findFirst();
      if (defaultHotel) targetHotelId = defaultHotel.id;
    }

    return await prisma.guest.findMany({
      where: { hotelId: targetHotelId },
      include: {
        reservations: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Fetch specific guest by ID scoped to tenant
   */
  async getGuestById(hotelId, id) {
    let targetHotelId = hotelId;
    let hotelExists = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotelExists) {
      const defaultHotel = await prisma.hotel.findFirst();
      if (defaultHotel) targetHotelId = defaultHotel.id;
    }

    return await prisma.guest.findFirst({
      where: {
        id,
        hotelId: targetHotelId,
      },
      include: {
        reservations: true,
      },
    });
  },
};
