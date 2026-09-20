import path from 'node:path';
import { fileURLToPath } from 'node:url';

function numberEnv(name: string, fallback: number): number { const value = Number(process.env[name] ?? fallback); if (!Number.isFinite(value)) throw new Error(`${name} must be a number`); return value; }

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: numberEnv('PORT', 8080),
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(repoRoot, 'data')),
  cookieName: process.env.COOKIE_NAME ?? 'robot_station_session',
  sessionDays: numberEnv('SESSION_DAYS', 7),
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  adminPassword: process.env.ADMIN_PASSWORD,
  robotHost: process.env.ROBOT_HOST,
  robotPort: numberEnv('ROBOT_PORT', 9000),
  robotToken: process.env.ROBOT_TOKEN,
  webRoot: path.resolve(process.env.WEB_ROOT ?? path.join(repoRoot, 'apps/web/public')),
  isProduction: process.env.NODE_ENV === 'production',
};

export function readRobotConfig(): { host: string; port: number; token: string } | null {
  const host = config.robotHost?.trim();
  const token = config.robotToken?.trim();
  if (!host && !token) return null;
  if (!host || !token) throw new Error('ROBOT_HOST and ROBOT_TOKEN must be configured together');
  return { host, port: config.robotPort, token };
}
