/**
 * Agent → dashboard pairing (dashboard spec §4), kept from the retired stdio
 * server for offer_agent_link: the Worker makes the one-time code, offers it,
 * and hands the human a dashboard link to redeem signed in.
 */
import { randomBytes } from 'node:crypto';
import { setDb } from '../../shared/db-target';

export const DEFAULT_DASHBOARD_URL = 'http://localhost:5174';

/** 32 random bytes as base64url: 43 characters, inside the module's ^[A-Za-z0-9_-]{32,128}$ */
export function newLinkCode(): string {
  return randomBytes(32).toString('base64url');
}

/** The dashboard's /link page. db unless default: the code lives in one database. */
export function dashboardLinkUrl(dashboardUrl: string, dbName: string, code: string): string {
  const url = new URL(`${dashboardUrl.replace(/\/+$/, '')}/link`);
  url.searchParams.set('code', code);
  return setDb(url, dbName).toString();
}
