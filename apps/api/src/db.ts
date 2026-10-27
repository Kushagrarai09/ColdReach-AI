import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
dotenv.config();
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export async function audit(action: string, entityType: string, entityId?: string, detail: unknown = {}) {
  await pool.query('INSERT INTO audit_logs(action,entity_type,entity_id,detail) VALUES($1,$2,$3,$4)', [action, entityType, entityId ?? null, JSON.stringify(detail)]);
}
export async function event(type: string, campaignId?: string, contactId?: string, recipientId?: string, detail: unknown = {}) {
  await pool.query('INSERT INTO email_events(event_type,campaign_id,contact_id,recipient_id,detail) VALUES($1,$2,$3,$4,$5)', [type, campaignId ?? null, contactId ?? null, recipientId ?? null, JSON.stringify(detail)]);
}
