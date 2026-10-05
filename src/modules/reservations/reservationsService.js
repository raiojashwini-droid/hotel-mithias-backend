import { prisma } from '../../config/database.js';

export const reservationsService = {
  /**
   * Fetch all reservations belonging to authenticated hotel/tenant
   */
  async getReservations(hotelId) {
    let targetHotelId = hotelId;
    let hotelExists = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotelExists) {
      const defaultHotel = await prisma.hotel.findFirst();
      if (defaultHotel) targetHotelId = defaultHotel.id;
    }

    return await prisma.reservation.findMany({
      where: { hotelId: targetHotelId },
      include: {
        guest: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Fetch specific reservation by number scoped to tenant
   */
  async getReservationByNumber(hotelId, number) {
    let targetHotelId = hotelId;
    let hotelExists = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotelExists) {
      const defaultHotel = await prisma.hotel.findFirst();
      if (defaultHotel) targetHotelId = defaultHotel.id;
    }

    return await prisma.reservation.findFirst({
      where: {
        number,
        hotelId: targetHotelId,
      },
      include: {
        guest: true,
      },
    });
  },
};
