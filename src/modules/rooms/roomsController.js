import { prisma } from '../../config/database.js';
import { errorResponse, successResponse } from '../../utils/response.js';
import { pmsService } from '../pms/pmsService.js';

/**
 * Valid room status transitions.
 * Managers (role === 'manager') bypass these restrictions for operational overrides.
 */
const ALLOWED_TRANSITIONS = {
  Dirty:       ['Cleaning', 'DND', 'Guest Inside', 'Maintenance', 'Blocked'],
  Cleaning:    ['Clean', 'DND', 'Guest Inside', 'Maintenance'],
  Clean:       ['Inspected', 'Dirty'],
  Inspected:   ['Dirty'],
  DND:         ['Dirty', 'Cleaning', 'Guest Inside'],
  'Guest Inside': ['Dirty', 'DND'],
  Maintenance: ['Dirty'],
  Blocked:     ['Dirty', 'Clean'],
};

function isTransitionAllowed(fromStatus, toStatus, role) {
  if (role === 'manager') return true; // managers can override
  const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

/* ----------------------------------------------------------------- GET all -- */
export const getRooms = async (req, res, next) => {
  try {
    const hotelId = req.user.hotelId;
    const { floor, status } = req.query;
    const where = { hotelId };
    if (floor) where.floor = parseInt(floor, 10);
    if (status) where.status = status;

    const rooms = await prisma.room.findMany({
      where,
      orderBy: { number: 'asc' },
    });
    return successResponse(res, rooms, 'Rooms fetched successfully');
  } catch (error) {
    next(error);
  }
};

/* --------------------------------------------------------------- GET single -- */
export const getRoomByNumber = async (req, res, next) => {
  try {
    const hotelId = req.user.hotelId;
    const { number } = req.params;
    const room = await prisma.room.findFirst({
      where: { number, hotelId },
    });
    if (!room) {
      return errorResponse(res, `Room ${number} not found`, 404);
    }
    return successResponse(res, room, 'Room fetched');
  } catch (error) {
    next(error);
  }
};

/* --------------------------------------------------------- PATCH room status -- */
export const updateRoomStatus = async (req, res, next) => {
  try {
    const hotelId = req.user.hotelId;
    const userRole = req.user.role || 'front-office';
    const { number } = req.params;
    const { status, cleaner, note } = req.body;

    if (!status) {
      return errorResponse(res, 'status is required', 400);
    }

    // 1. Ownership check + current state read (outside transaction — read-only)
    const existing = await prisma.room.findFirst({ where: { number, hotelId } });
    if (!existing) {
      return errorResponse(res, `Room ${number} not found for this hotel`, 404);
    }

    // 2. State machine validation
    if (!isTransitionAllowed(existing.status, status, userRole)) {
      return errorResponse(
        res,
        `Transition from "${existing.status}" to "${status}" is not permitted`,
        409,
      );
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const isReleased = status === 'Clean' || status === 'Inspected';

    // 3. Atomic transaction with 15s timeout for cloud DB latency
    const result = await prisma.$transaction(async (tx) => {
      // 3a. Update the room
      const updatedRoom = await tx.room.update({
        where: { hotelId_number: { hotelId, number } },
        data: {
          status,
          cleaner: cleaner !== undefined ? cleaner : existing.cleaner,
          note: note !== undefined ? note : existing.note,
          updatedAt: timeStr,
        },
      });

      let completedTaskIds = [];

      // 3b. If room is released, complete open housekeeping tasks for this room
      if (isReleased) {
        const openTasks = await tx.task.findMany({
          where: {
            hotelId,
            room: number,
            department: 'Housekeeping',
            status: { notIn: ['Completed', 'Escalated'] },
          },
          select: { id: true, title: true, conversationId: true },
        });

        if (openTasks.length > 0) {
          // Update all matching tasks to Completed
          await tx.task.updateMany({
            where: {
              id: { in: openTasks.map((t) => t.id) },
              hotelId,
            },
            data: { status: 'Completed' },
          });

          // Create a TaskTrail entry for each completed task
          const trailEntries = openTasks.map((t) => ({
            taskId: t.id,
            at: timeStr,
            text: `Room ${number} released — task closed automatically`,
            via: 'dashboard',
          }));
          await tx.taskTrail.createMany({ data: trailEntries });

          completedTaskIds = openTasks.map((t) => t.id);
        }
      }

      // 3c. Record activity item
      await tx.activityItem.create({
        data: {
          id: `act-${Date.now()}`,
          hotelId,
          at: timeStr,
          kind: 'room',
          text: `Room ${number} is now ${status}`,
          meta: cleaner ? `by ${cleaner}` : undefined,
        },
      });

      return { updatedRoom, completedTaskIds };
    }, { maxWait: 10000, timeout: 15000 });

    // Asynchronously propagate space status change to Mews PMS if room is connected
    if (existing?.mewsId) {
      pmsService.syncRoomStatusToMews(hotelId, number, status).catch((err) => {
        console.warn(`[RoomsController] Background Mews sync for room ${number} note:`, err.message);
      });
    }

    return successResponse(
      res,
      { ...result.updatedRoom, room: result.updatedRoom, completedTaskIds: result.completedTaskIds },
      `Room ${number} updated to ${status}`,
    );
  } catch (error) {
    next(error);
  }
};
