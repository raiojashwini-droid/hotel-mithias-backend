import { prisma } from '../../config/database.js';
import { errorResponse, successResponse } from '../../utils/response.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeNow() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Normalize backend status → frontend status.
 * Backend default is "Reported", frontend uses "Open".
 */
function normalizeStatus(status) {
  if (status === 'Reported') return 'Open';
  return status;
}

/**
 * Denormalize frontend status → backend status for writes.
 * If frontend sends "Open", we store "Reported" only on initial creation.
 * For updates we pass through as-is (Accepted, In Progress, etc.).
 */
function denormalizeStatus(status) {
  // Frontend "Open" maps to "Reported" only for creation
  // All other statuses are stored verbatim
  return status;
}

/** Map a Prisma Issue row to the frontend Issue shape. */
function formatIssue(i) {
  return {
    id: i.id,
    room: i.room,
    title: i.title,
    detail: i.detail || undefined,
    priority: i.priority,
    reportedBy: i.reportedBy,
    via: i.via,
    createdAt: i.createdAt,
    assignee: i.assignee || undefined,
    status: normalizeStatus(i.status),
    outOfService: Boolean(i.outOfService),
    updates: Array.isArray(i.updates)
      ? i.updates.map((u) => ({ at: u.at, text: u.text, via: u.via || 'dashboard' }))
      : [],
  };
}

// ─── GET /api/issues ───────────────────────────────────────────────────────────

export const getIssues = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { status, room } = req.query;
    const where = { hotelId };
    if (status) where.status = status;
    if (room) where.room = room;

    const issues = await prisma.issue.findMany({
      where,
      include: { updates: { orderBy: { id: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    return successResponse(res, issues.map(formatIssue), 'Issues list');
  } catch (error) {
    next(error);
  }
};

// ─── POST /api/issues ──────────────────────────────────────────────────────────

export const createIssue = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const {
      room,
      title,
      detail,
      priority = 'Normal',
      reportedBy,
      via = 'Dashboard',
      assignee,
      outOfService,
    } = req.body;

    if (!room || !title) {
      return errorResponse(res, 'Room and title are required', 400);
    }

    // Use authenticated user name as reporter if not provided
    const reporter = reportedBy || req.user?.name || 'Staff';

    // Determine outOfService: explicit body value OR priority is Urgent
    const isOos = outOfService !== undefined ? Boolean(outOfService) : priority === 'Urgent';

    const at = timeNow();

    // Generate a unique MT-XXX id (collision-safe: check existing max)
    const existing = await prisma.issue.findMany({
      where: { hotelId },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    const numbers = existing
      .map((e) => parseInt(e.id.replace('MT-', ''), 10))
      .filter((n) => !isNaN(n));
    const nextNum = numbers.length > 0 ? Math.max(...numbers) + 1 : 100;
    const id = `MT-${nextNum}`;

    // All writes in a single transaction
    const issue = await prisma.$transaction(async (tx) => {
      const created = await tx.issue.create({
        data: {
          id,
          hotelId,
          room,
          title,
          detail: detail || null,
          priority,
          reportedBy: reporter,
          via,
          createdAt: at,
          assignee: assignee || null,
          status: assignee ? 'Accepted' : 'Reported',
          outOfService: isOos,
          updates: {
            create: [{ at, text: `Reported by ${reporter} via ${via}`, via: 'dashboard' }],
          },
        },
        include: { updates: true },
      });

      // If urgent or outOfService, set room to Maintenance
      if (isOos) {
        await tx.room.updateMany({
          where: { number: room, hotelId },
          data: { status: 'Maintenance', updatedAt: at },
        });
      }

      // Activity log
      await tx.activityItem.create({
        data: {
          id: `act-${Date.now()}`,
          hotelId,
          at,
          kind: 'maintenance',
          text: `New issue ${id} — ${title} (Room ${room})`,
          meta: `Priority: ${priority}`,
        },
      });

      return created;
    });

    return successResponse(res, formatIssue(issue), 'Issue created successfully', 201);
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/issues/:id/status ─────────────────────────────────────────────

export const updateIssueStatus = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { id } = req.params;
    const { status, note, via = 'dashboard' } = req.body;

    if (!status) {
      return errorResponse(res, 'status is required', 400);
    }

    const existing = await prisma.issue.findFirst({
      where: { id, hotelId },
      include: { updates: { orderBy: { id: 'asc' } } },
    });

    if (!existing) {
      return errorResponse(res, 'Issue not found', 404);
    }

    const at = timeNow();

    if (status === 'Completed') {
      // Full closed-loop transaction:
      // 1. Complete issue  2. Room → Dirty  3. Close open Maintenance tasks
      // 4. Create HK re-inspect task  5. Activity log
      const updated = await prisma.$transaction(async (tx) => {
        // 1. Update issue
        const updatedIssue = await tx.issue.update({
          where: { id },
          data: {
            status: 'Completed',
            outOfService: false,
            updates: {
              create: {
                at,
                text: note || `Issue completed by ${req.user?.name ?? 'technician'}`,
                via,
              },
            },
          },
          include: { updates: { orderBy: { id: 'asc' } } },
        });

        // 2. Room → Dirty (authoritative backend transition)
        await tx.room.updateMany({
          where: { number: existing.room, hotelId },
          data: {
            status: 'Dirty',
            updatedAt: at,
            note: 'Maintenance finished. Requires housekeeping re-inspection.',
          },
        });

        // 3. Close any open Maintenance tasks linked to this room
        const maintenanceTasks = await tx.task.findMany({
          where: {
            hotelId,
            room: existing.room,
            department: 'Maintenance',
            status: { not: 'Completed' },
          },
        });
        for (const t of maintenanceTasks) {
          await tx.task.update({
            where: { id: t.id },
            data: {
              status: 'Completed',
              trail: {
                create: {
                  at,
                  text: `Auto-completed — issue ${id} resolved`,
                  via: 'ai',
                },
              },
            },
          });
        }

        // 4. Create Housekeeping re-inspect task
        const hkTaskId = `t-hk-${Date.now()}`;
        await tx.task.create({
          data: {
            id: hkTaskId,
            hotelId,
            title: `Re-inspect Room ${existing.room} after ${existing.title}`,
            room: existing.room,
            department: 'Housekeeping',
            priority: 'High',
            createdAt: at,
            status: 'New',
            source: 'Maintenance',
            trail: {
              create: {
                at,
                text: `Auto-generated — maintenance ticket ${id} completed`,
                via: 'ai',
              },
            },
          },
        });

        // 5. Activity log
        await tx.activityItem.create({
          data: {
            id: `act-${Date.now()}`,
            hotelId,
            at,
            kind: 'maintenance',
            text: `Issue ${id} completed — Room ${existing.room} back for HK recheck`,
            meta: note || undefined,
          },
        });

        return updatedIssue;
      });

      return successResponse(res, formatIssue(updated), 'Issue completed — closed-loop automation done');
    }

    // Non-Completed status update (Accept, In Progress, Waiting Parts, Escalated, etc.)
    const updated = await prisma.$transaction(async (tx) => {
      const updatedIssue = await tx.issue.update({
        where: { id },
        data: {
          status,
          updates: {
            create: {
              at,
              text: note || `Status updated to ${status}`,
              via,
            },
          },
        },
        include: { updates: { orderBy: { id: 'asc' } } },
      });

      await tx.activityItem.create({
        data: {
          id: `act-${Date.now()}`,
          hotelId,
          at,
          kind: 'maintenance',
          text: `Issue ${id} (Room ${existing.room}) — ${status}`,
          meta: note || undefined,
        },
      });

      return updatedIssue;
    });

    return successResponse(res, formatIssue(updated), 'Issue status updated');
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/issues/:id/assign ─────────────────────────────────────────────

export const assignIssue = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { id } = req.params;
    const { assignee } = req.body;

    if (!assignee) {
      return errorResponse(res, 'assignee is required', 400);
    }

    const existing = await prisma.issue.findFirst({
      where: { id, hotelId },
    });

    if (!existing) {
      return errorResponse(res, 'Issue not found', 404);
    }

    const at = timeNow();

    const updated = await prisma.$transaction(async (tx) => {
      const updatedIssue = await tx.issue.update({
        where: { id },
        data: {
          assignee,
          // Only advance to Accepted if currently Open/Reported
          status:
            existing.status === 'Reported' || existing.status === 'Open'
              ? 'Accepted'
              : existing.status,
          updates: {
            create: {
              at,
              text: `Assigned to ${assignee}`,
              via: 'dashboard',
            },
          },
        },
        include: { updates: { orderBy: { id: 'asc' } } },
      });

      await tx.activityItem.create({
        data: {
          id: `act-${Date.now()}`,
          hotelId,
          at,
          kind: 'maintenance',
          text: `Issue ${id} assigned to ${assignee} (Room ${existing.room})`,
          meta: undefined,
        },
      });

      return updatedIssue;
    });

    return successResponse(res, formatIssue(updated), 'Issue assigned');
  } catch (error) {
    next(error);
  }
};
