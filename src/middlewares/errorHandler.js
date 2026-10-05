import { errorResponse } from '../utils/response.js';

export const errorHandler = (err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return errorResponse(res, 'File too large. Maximum size allowed is 10 MB.', 413);
  }
  if (err.message && err.message.includes('Invalid file type')) {
    return errorResponse(res, err.message, 400);
  }
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  return errorResponse(res, message, status);
};
