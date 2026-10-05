import { errorResponse } from '../utils/response.js';

export const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return errorResponse(res, `Access denied: requires one of [${allowedRoles.join(', ')}] role`, 403);
    }
    next();
  };
};
