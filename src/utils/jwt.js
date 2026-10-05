import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

export const signToken = (payload) => {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
};

export const verifyToken = (token) => {
  return jwt.verify(token, config.jwtSecret);
};
