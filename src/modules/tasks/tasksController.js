import { prisma } from '../../config/database.js';
import { errorResponse, successResponse } from '../../utils/response.js';

export const getTasks = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { department, status, source } = req.query;
    const where = { hotelId };

    if (department) where.department = department;
    if (status) where.status = status;
    if (source) where.source = source;

    const tasks = await prisma.task.findMany({
      where,
      include: {
        trail: {
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return successResponse(res, tasks, 'Tasks list');
  } catch (error) {
    next(error);
  }
};

export const getTaskById = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { id } = req.params;
    const task = await prisma.task.findFirst({
      where: { id, hotelId },
      include: { trail: true },
    });
    if (!task) {
      return errorResponse(res, 'Task not found', 404);
    }
    return successResponse(res, task, 'Task detail');
  } catch (error) {
    next(error);
  }
};

export const createTask = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const {
      title,
      detail,
      room,
      guest,
      department = 'Front Office',
      priority = 'Normal',
      due,
      assignee,
      source = 'Manager',
      conversationId,
    } = req.body;

    if (!title) {
      return errorResponse(res, 'Task title is required', 400);
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const id = `t-${Date.now()}`;

    const task = await prisma.task.create({
      data: {
        id,
        hotelId,
        title,
        detail,
        room,
        guest,
        department,
        priority,
        createdAt: timeStr,
        due,
        assignee,
        status: assignee ? 'Assigned' : 'New',
        source,
        conversationId,
        trail: {
          create: [
            {
              at: timeStr,
              text: `Task created via ${source}${assignee ? ` and assigned to ${assignee}` : ''}`,
              via: 'dashboard',
            },
          ],
        },
      },
      include: { trail: true },
    });

    // Record activity
    await prisma.activityItem.create({
      data: {
        id: `act-${Date.now()}`,
        hotelId,
        at: timeStr,
        kind: 'task',
        text: `New task for ${department}: "${title}"`,
        meta: room ? `Room ${room}` : undefined,
      },
    });

    return successResponse(res, task, 'Task created successfully', 201);
  } catch (error) {
    next(error);
  }
};

export const updateTaskStatus = async (req, res, next) => {
  try {
    const hotelId = req.user?.hotelId || 'hotel-mercier';
    const { id } = req.params;
    const { status, note, via = 'dashboard', assignee } = req.body;

    const existing = await prisma.task.findFirst({
      where: { id, hotelId },
      include: { trail: true },
    });

    if (!existing) {
      return errorResponse(res, 'Task not found', 404);
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const updated = await prisma.task.update({
      where: { id },
      data: {
        status: status || existing.status,
        assignee: assignee !== undefined ? assignee : existing.assignee,
        trail: {
          create: {
            at: timeStr,
            text: note || `Status updated to ${status || 'updated'}`,
            via,
          },
        },
      },
      include: { trail: true },
    });

    // Record activity
    await prisma.activityItem.create({
      data: {
        id: `act-${Date.now()}`,
        hotelId,
        at: timeStr,
        kind: 'task',
        text: `Task "${existing.title}" marked ${status}`,
        meta: via ? `via ${via}` : undefined,
      },
    });

    return successResponse(res, updated, 'Task status updated');
  } catch (error) {
    next(error);
  }
};
