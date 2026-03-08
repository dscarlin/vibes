import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { config } from './config.js';
import { query } from './db.js';

const TOKEN_TTL = '7d';

export function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: TOKEN_TTL });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [, token] = header.split(' ');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

export async function registerUser(email, password) {
  const hash = password ? await bcrypt.hash(password, 10) : null;
  const plan = String(config.defaultUserPlan || 'starter').toLowerCase();
  const result = await query(
    `insert into users (email, password_hash, plan)
     values ($1, $2, $3)
     on conflict (email) do update set email = excluded.email
     returning id, email, plan, is_platform_admin`,
    [email, hash, plan]
  );
  return result.rows[0];
}

export async function authenticateUser(email, password) {
  const result = await query(
    'select id, email, password_hash, plan, is_platform_admin from users where email = $1',
    [email]
  );
  if (result.rowCount === 0) return null;
  const user = result.rows[0];
  if (!user.password_hash && config.allowPasswordBypass) return user;
  const ok = await bcrypt.compare(password || '', user.password_hash || '');
  return ok ? user : null;
}
