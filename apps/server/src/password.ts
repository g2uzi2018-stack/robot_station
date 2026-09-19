import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('Password must contain at least 12 characters');
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, saltText, hashText] = encoded.split('$'); if (!saltText || !hashText) return false;
  const derived = await scrypt(password, Buffer.from(saltText, 'base64url'), KEY_LENGTH) as Buffer;
  const expected = Buffer.from(hashText, 'base64url'); return expected.length === derived.length && timingSafeEqual(expected, derived);
}