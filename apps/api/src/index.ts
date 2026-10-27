import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import { pool, audit, event } from './db.js';
dotenv.config();
const app = express();
app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://localhost:3000' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), ...(redisUrl.password ? { password: redisUrl.password } : {}) };
const queue = new Queue('coldreach-email', { connection });

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: true }); }
  catch { res.status(503).json({ ok: false, database: false }); }
});

app.get('/api/dashboard', async (_req, res) => {
  const q = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM contacts) contacts,
      (SELECT COUNT(*)::int FROM campaigns) campaigns,
      (SELECT COUNT(*)::int FROM email_events WHERE event_type IN ('email_accepted','dry_run')) sent,
      (SELECT COUNT(*)::int FROM email_events WHERE event_type='email_failed') failed,
      (SELECT COUNT(*)::int FROM replies) replies,
      (SELECT COUNT(*)::int FROM contacts WHERE status='unsubscribed') unsubscribed
  `);
  const recent = await pool.query('SELECT id,name,status,created_at FROM campaigns ORDER BY created_at DESC LIMIT 5');
  res.json({ stats: q.rows[0], recent: recent.rows });
});

app.get('/api/contacts', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const result = await pool.query(
    `SELECT c.*, EXISTS(SELECT 1 FROM suppression_list s WHERE lower(s.email)=lower(c.email)) AS suppressed
     FROM contacts c WHERE ($1='' OR c.email ILIKE $2 OR c.first_name ILIKE $2 OR c.company ILIKE $2)
     ORDER BY c.created_at DESC LIMIT 500`,
    [search, `%${search}%`]
  );
  res.json({ contacts: result.rows });
});

app.post('/api/contacts/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a CSV file.' });
  let rows: any[];
  try { rows = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true, bom: true }); }
  catch { return res.status(400).json({ error: 'Could not parse CSV. Check the header row.' }); }
  let imported = 0, duplicates = 0, invalid = 0;
  for (const row of rows) {
    const email = String(row.email || row.Email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { invalid++; continue; }
    try {
      const r = await pool.query(
        `INSERT INTO contacts(email,first_name,last_name,company,job_title,source)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(email) DO NOTHING RETURNING id`,
        [email, row.firstName || row.first_name || row.FirstName || '', row.lastName || row.last_name || row.LastName || '',
         row.company || row.Company || '', row.jobTitle || row.job_title || row.JobTitle || '', row.source || 'CSV import']
      );
      if (r.rowCount) imported++; else duplicates++;
    } catch { invalid++; }
  }
  await audit('contacts_imported', 'contact', undefined, { imported, duplicates, invalid });
  res.json({ imported, duplicates, invalid, totalRows: rows.length });
});

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(250),
  body: z.string().min(1).max(20000),
  // Select existing contacts, paste addresses manually, or use both.
  contactIds: z.array(z.string().uuid()).max(Number(process.env.MAX_CAMPAIGN_RECIPIENTS || 200)).default([]),
  manualEmails: z.string().max(50000).optional().default(''),
  scheduledAt: z.string().datetime().optional().nullable(),
  sendDelayMs: z.number().int().min(1000).max(3600000).default(Number(process.env.DEFAULT_SEND_DELAY_MS || 5000)),
  followupEnabled: z.boolean().default(false),
  followupDelayHours: z.number().int().min(24).max(720).default(72),
  followupSubject: z.string().max(250).optional().default(''),
  followupBody: z.string().max(20000).optional().default('')
});
app.get('/api/campaigns', async (_req, res) => {
  const result = await pool.query(`
    SELECT c.*, COUNT(cr.id)::int AS recipients,
      COUNT(cr.id) FILTER (WHERE cr.status='sent')::int AS sent_count,
      COUNT(cr.id) FILTER (WHERE cr.status='failed')::int AS failed_count,
      COUNT(cr.id) FILTER (WHERE cr.status='replied')::int AS replied_count
    FROM campaigns c LEFT JOIN campaign_recipients cr ON cr.campaign_id=c.id
    GROUP BY c.id ORDER BY c.created_at DESC`);
  res.json({ campaigns: result.rows });
});
app.post('/api/campaigns', async (req, res) => {
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid campaign.' });
  const d = parsed.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const emailCandidates = [...new Set(String(d.manualEmails || '').split(/[\s,;]+/).map(v => v.trim().toLowerCase()).filter(Boolean))];
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidManual = emailCandidates.filter(email => !emailPattern.test(email));
    const manualEmails = emailCandidates.filter(email => emailPattern.test(email));
    const maxRecipients = Number(process.env.MAX_CAMPAIGN_RECIPIENTS || 200);
    if (new Set([...d.contactIds, ...manualEmails]).size > maxRecipients) throw new Error(`A campaign can include at most ${maxRecipients} unique recipients.`);
    if (!d.contactIds.length && !manualEmails.length) throw new Error('Select existing contacts or paste at least one valid email address.');
    // Manual entries become normal contacts so suppression, history, and analytics still apply.
    for (const email of manualEmails) {
      await client.query(
        `INSERT INTO contacts(email,first_name,last_name,company,job_title,source) VALUES($1,'','','','','Manual campaign entry') ON CONFLICT(email) DO NOTHING`,
        [email]);
    }
    const contacts = await client.query(
      `SELECT c.id,c.status,c.email,EXISTS(SELECT 1 FROM suppression_list s WHERE lower(s.email)=lower(c.email)) suppressed
       FROM contacts c WHERE c.id=ANY($1::uuid[]) OR lower(c.email)=ANY($2::text[])`, [d.contactIds, manualEmails]);
    const foundIds = new Set(contacts.rows.map((c:any) => c.id));
    if (d.contactIds.some((id:string) => !foundIds.has(id))) throw new Error('One or more selected contacts were not found. Refresh the page and try again.');
    const eligible = contacts.rows.filter((c:any) => c.status === 'active' && !c.suppressed);
    if (!eligible.length) throw new Error('No eligible recipients: all selected addresses are suppressed or inactive.');
    const created = await client.query(
      `INSERT INTO campaigns(name,subject,body,scheduled_at,send_delay_ms,followup_enabled,followup_delay_hours,followup_subject,followup_body)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [d.name,d.subject,d.body,d.scheduledAt || null,d.sendDelayMs,d.followupEnabled,d.followupDelayHours,d.followupSubject,d.followupBody]);
    for (const c of eligible) await client.query(
      'INSERT INTO campaign_recipients(campaign_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [created.rows[0].id,c.id]);
    await client.query('COMMIT');
    await audit('campaign_created', 'campaign', created.rows[0].id, { eligibleRecipients: eligible.length });
    res.status(201).json({ campaign: created.rows[0], eligibleRecipients: eligible.length, invalidManualEmails: invalidManual.length, invalidManualExamples: invalidManual.slice(0, 5) });
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message || 'Could not create campaign.' });
  } finally { client.release(); }
});

app.get('/api/campaigns/:id/recipients', async (req, res) => {
  const r = await pool.query(`SELECT cr.*,c.email,c.first_name,c.last_name,c.company FROM campaign_recipients cr JOIN contacts c ON c.id=cr.contact_id WHERE cr.campaign_id=$1 ORDER BY cr.created_at`, [req.params.id]);
  res.json({ recipients: r.rows });
});

app.post('/api/campaigns/:id/launch', async (req, res) => {
  const campaign = await pool.query('SELECT * FROM campaigns WHERE id=$1', [req.params.id]);
  if (!campaign.rowCount) return res.status(404).json({ error: 'Campaign not found.' });
  const c = campaign.rows[0];
  if (['running','completed','cancelled'].includes(c.status)) return res.status(400).json({ error: `Campaign is ${c.status}.` });
  const recipients = await pool.query(
    `SELECT cr.id,cr.contact_id,ct.email FROM campaign_recipients cr JOIN contacts ct ON ct.id=cr.contact_id
     WHERE cr.campaign_id=$1 AND cr.status='queued' AND ct.status='active'
       AND NOT EXISTS(SELECT 1 FROM suppression_list s WHERE lower(s.email)=lower(ct.email))`,
    [c.id]);
  if (!recipients.rowCount) return res.status(400).json({ error: 'No eligible queued recipients.' });
  const scheduleTime = c.scheduled_at ? new Date(c.scheduled_at).getTime() : Date.now();
  if (scheduleTime < Date.now() - 60000) { /* launch now when schedule is in the past */ }
  await pool.query("UPDATE campaigns SET status=$1, approved_at=NOW(), updated_at=NOW() WHERE id=$2", [c.scheduled_at && scheduleTime > Date.now() ? 'scheduled' : 'running', c.id]);
  let delay = Math.max(0, scheduleTime - Date.now());
  for (const r of recipients.rows) {
    await queue.add('send-email', { campaignId: c.id, recipientId: r.id, followup: false }, {
      delay, removeOnComplete: 1000, removeOnFail: 1000,
      attempts: 3, backoff: { type: 'exponential', delay: 5000 },
      jobId: `initial-${r.id}`
    });
    delay += Math.max(1000, Number(c.send_delay_ms));
  }
  await audit('campaign_approved_and_queued', 'campaign', c.id, { recipients: recipients.rowCount });
  res.json({ ok: true, queued: recipients.rowCount, scheduledAt: c.scheduled_at });
});

app.post('/api/campaigns/:id/pause', async (req, res) => {
  const r = await pool.query("UPDATE campaigns SET status='paused',updated_at=NOW() WHERE id=$1 AND status IN ('running','scheduled') RETURNING id", [req.params.id]);
  if (!r.rowCount) return res.status(400).json({ error: 'Campaign cannot be paused in its current state.' });
  await audit('campaign_paused', 'campaign', req.params.id);
  res.json({ ok: true });
});
app.post('/api/campaigns/:id/resume', async (req, res) => {
  const r = await pool.query("UPDATE campaigns SET status='running',updated_at=NOW() WHERE id=$1 AND status='paused' RETURNING id", [req.params.id]);
  if (!r.rowCount) return res.status(400).json({ error: 'Campaign is not paused.' });
  const jobs = await pool.query(`SELECT cr.id FROM campaign_recipients cr JOIN contacts ct ON ct.id=cr.contact_id WHERE cr.campaign_id=$1 AND cr.status='queued' AND ct.status='active' AND NOT EXISTS(SELECT 1 FROM suppression_list s WHERE lower(s.email)=lower(ct.email))`, [req.params.id]);
  const c = await pool.query('SELECT send_delay_ms FROM campaigns WHERE id=$1', [req.params.id]);
  let delay = 0;
  for (const row of jobs.rows) {
    await queue.add('send-email', { campaignId: req.params.id, recipientId: row.id, followup: false }, { delay, jobId: `resume-${row.id}-${Date.now()}`, attempts: 3, backoff: { type:'exponential', delay:5000 }, removeOnComplete:1000, removeOnFail:1000 });
    delay += Math.max(1000, Number(c.rows[0]?.send_delay_ms || 5000));
  }
  await audit('campaign_resumed', 'campaign', req.params.id, { queued: jobs.rowCount });
  res.json({ ok: true, queued: jobs.rowCount });
});

app.get('/api/replies', async (_req, res) => {
  const r = await pool.query(`SELECT rp.*,ct.email,ct.first_name,ct.last_name,ca.name AS campaign_name FROM replies rp JOIN contacts ct ON ct.id=rp.contact_id LEFT JOIN campaigns ca ON ca.id=rp.campaign_id ORDER BY rp.received_at DESC LIMIT 500`);
  res.json({ replies: r.rows });
});
app.post('/api/replies', async (req, res) => {
  const schema = z.object({ email: z.string().email(), campaignId: z.string().uuid().optional(), subject: z.string().max(250).optional(), snippet: z.string().max(2000).optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Provide a valid email and optional campaign ID.' });
  const d = parsed.data;
  const contact = await pool.query('SELECT id FROM contacts WHERE lower(email)=lower($1)', [d.email]);
  if (!contact.rowCount) return res.status(404).json({ error: 'Contact not found.' });
  const r = await pool.query('INSERT INTO replies(contact_id,campaign_id,subject,snippet,source) VALUES($1,$2,$3,$4,$5) RETURNING *', [contact.rows[0].id,d.campaignId || null,d.subject || '',d.snippet || '', 'manual']);
  await pool.query("UPDATE campaign_recipients SET status='replied',replied_at=NOW() WHERE contact_id=$1 AND ($2::uuid IS NULL OR campaign_id=$2)", [contact.rows[0].id,d.campaignId || null]);
  await event('reply_received', d.campaignId, contact.rows[0].id, undefined, { source: 'manual' });
  await audit('reply_recorded', 'reply', r.rows[0].id, { email: d.email });
  res.status(201).json({ reply: r.rows[0] });
});

app.get('/api/analytics', async (_req, res) => {
  const totals = await pool.query(`SELECT event_type,COUNT(*)::int count FROM email_events GROUP BY event_type ORDER BY event_type`);
  const perCampaign = await pool.query(`SELECT c.id,c.name,c.status,COUNT(cr.id)::int recipients,COUNT(cr.id) FILTER(WHERE cr.status='sent')::int sent,COUNT(cr.id) FILTER(WHERE cr.status='failed')::int failed,COUNT(cr.id) FILTER(WHERE cr.status='replied')::int replied FROM campaigns c LEFT JOIN campaign_recipients cr ON cr.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`);
  res.json({ events: totals.rows, campaigns: perCampaign.rows });
});

app.get('/api/suppression', async (_req, res) => {
  const r = await pool.query('SELECT * FROM suppression_list ORDER BY created_at DESC LIMIT 1000');
  res.json({ suppressed: r.rows });
});
app.post('/api/unsubscribe', async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).send('Invalid email address.');
  const email = parsed.data.email.trim().toLowerCase();
  await pool.query('INSERT INTO suppression_list(email,reason) VALUES($1,$2) ON CONFLICT(email) DO NOTHING', [email,'unsubscribe']);
  await pool.query("UPDATE contacts SET status='unsubscribed',updated_at=NOW() WHERE lower(email)=lower($1)", [email]);
  await pool.query("UPDATE campaign_recipients cr SET status='suppressed' FROM contacts c WHERE cr.contact_id=c.id AND lower(c.email)=lower($1) AND cr.status='queued'", [email]);
  await audit('contact_unsubscribed', 'contact', email);
  res.status(200).send('You have been unsubscribed. No further campaign emails will be sent.');
});

app.get('/api/activity', async (_req, res) => {
  const r = await pool.query('SELECT * FROM email_events ORDER BY created_at DESC LIMIT 100');
  res.json({ events: r.rows });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`ColdReach API listening on http://localhost:${port}`));
