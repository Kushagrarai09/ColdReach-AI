import { Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' }); dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), ...(redisUrl.password ? { password: redisUrl.password } : {}) };
const dryRun = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false';
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 465, secure: true,
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
});
function render(s: string, c: any) {
  return s.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_m, key) => {
    const map: Record<string,string> = {
      firstName: c.first_name || '', lastName: c.last_name || '', company: c.company || '',
      jobTitle: c.job_title || '', email: c.email || ''
    };
    return map[key] ?? '';
  });
}
async function event(type: string, campaignId: string, contactId: string, recipientId: string, detail: unknown = {}) {
  await pool.query('INSERT INTO email_events(event_type,campaign_id,contact_id,recipient_id,detail) VALUES($1,$2,$3,$4,$5)', [type,campaignId,contactId,recipientId,JSON.stringify(detail)]);
}
const worker = new Worker('coldreach-email', async job => {
  const { campaignId, recipientId, followup } = job.data as { campaignId:string; recipientId:string; followup:boolean };
  const q = await pool.query(`
    SELECT cr.*, ca.subject,ca.body,ca.status campaign_status,ca.followup_enabled,ca.followup_delay_hours,ca.followup_subject,ca.followup_body,
           ct.email,ct.first_name,ct.last_name,ct.company,ct.job_title,ct.status contact_status,
           EXISTS(SELECT 1 FROM suppression_list s WHERE lower(s.email)=lower(ct.email)) suppressed
    FROM campaign_recipients cr JOIN campaigns ca ON ca.id=cr.campaign_id JOIN contacts ct ON ct.id=cr.contact_id
    WHERE cr.id=$1 AND cr.campaign_id=$2`, [recipientId,campaignId]);
  if (!q.rowCount) return;
  const r = q.rows[0];
  if (r.campaign_status === 'paused' || r.campaign_status === 'cancelled' || (r.campaign_status === 'completed' && !followup)) return;
  if (r.contact_status !== 'active' || r.suppressed || r.status === 'replied' || r.status === 'suppressed') {
    await pool.query("UPDATE campaign_recipients SET status='suppressed' WHERE id=$1 AND status='queued'", [recipientId]);
    await event('email_suppressed', campaignId, r.contact_id, recipientId, { reason: 'contact inactive, suppressed, or replied' });
    return;
  }
  if (followup) {
    if (!r.followup_enabled || r.status !== 'sent') return;
  } else if (r.status !== 'queued') return;

  const subject = render(followup ? r.followup_subject : r.subject, r);
  let body = render(followup ? r.followup_body : r.body, r);
  if (!subject || !body.trim()) throw new Error('Rendered subject/body is empty.');
  const unsubscribeUrl = `${process.env.PUBLIC_BASE_URL || 'http://localhost:4000'}/api/unsubscribe`;
  body += `\\n\\n---\\nTo stop future outreach, reply to this email with "unsubscribe" or contact the sender.`;
  let messageId = `dry-run-${recipientId}`;
  try {
    if (dryRun) {
      console.log(`[DRY RUN] To: ${r.email} | Subject: ${subject}`);
      await event('dry_run', campaignId, r.contact_id, recipientId, { to:r.email, subject });
    } else {
      if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) throw new Error('Gmail SMTP credentials are missing.');
      const sent = await transporter.sendMail({
        from: `"${process.env.FROM_NAME || 'ColdReach'}" <${process.env.GMAIL_USER}>`,
        to: r.email, subject, text: body,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}?email=${encodeURIComponent(r.email)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      });
      messageId = sent.messageId || messageId;
      await event('email_accepted', campaignId, r.contact_id, recipientId, { messageId });
    }
    if (followup) {
      await pool.query("UPDATE campaign_recipients SET followup_sent_at=NOW() WHERE id=$1", [recipientId]);
      await event('followup_sent', campaignId, r.contact_id, recipientId, { dryRun });
    } else {
      await pool.query("UPDATE campaign_recipients SET status='sent',sent_at=NOW(),provider_message_id=$2,last_error=NULL WHERE id=$1", [recipientId,messageId]);
      if (r.followup_enabled) {
        // Follow-up rechecks reply/suppression/campaign state immediately before sending.
        const { Queue } = await import('bullmq');
        const queue = new Queue('coldreach-email', { connection });
        await queue.add('send-email', { campaignId, recipientId, followup: true }, {
          delay: Math.max(24, Number(r.followup_delay_hours)) * 60 * 60 * 1000,
          jobId: `followup-${recipientId}`, attempts: 2, backoff: { type:'exponential', delay:5000 }, removeOnComplete:1000, removeOnFail:1000
        });
        await queue.close();
      }
    }
    const remaining = await pool.query("SELECT COUNT(*)::int n FROM campaign_recipients WHERE campaign_id=$1 AND status='queued'", [campaignId]);
    if (remaining.rows[0].n === 0) await pool.query("UPDATE campaigns SET status='completed',updated_at=NOW() WHERE id=$1 AND status='running'", [campaignId]);
  } catch (e:any) {
    await event('email_failed', campaignId, r.contact_id, recipientId, { message: e.message });
    await pool.query("UPDATE campaign_recipients SET status='failed',last_error=$2 WHERE id=$1", [recipientId,String(e.message).slice(0,1000)]);
    throw e;
  }
}, { connection, concurrency: 2 });
worker.on('completed', job => console.log(`Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed:`, err.message));
console.log(`ColdReach worker running. DRY_RUN=${dryRun}`);
process.on('SIGINT', async () => { await worker.close(); await pool.end(); process.exit(0); });
