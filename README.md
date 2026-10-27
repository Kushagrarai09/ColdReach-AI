# ColdReach AI — Cold Email Automation (Level 2, no AI)

A local-first monorepo for contact import, reviewed campaigns, Gmail SMTP sending, scheduling, follow-ups, reply tracking hooks, suppression, and analytics.

## Stack
- `apps/web`: Next.js + TypeScript dashboard (semi-dark UI)
- `apps/api`: Express + TypeScript REST API, PostgreSQL, Zod, CSV import
- `apps/worker`: BullMQ worker for queued email delivery and follow-up jobs
- PostgreSQL + Redis via Docker Compose
- Gmail SMTP via Nodemailer (Google App Password; never put credentials in source code)

## Prerequisites
- Node.js 20+
- Docker Desktop
- A Gmail account with 2-Step Verification and an App Password, if you want to send real email.
- For safe initial testing, use `DRY_RUN=true` and a test contact you control.

## Start locally
1. Copy `.env.example` to `.env` in the repo root and fill in values.
2. Start infrastructure:
   ```bash
   docker compose up -d postgres redis
   ```
3. Install workspace dependencies:
   ```bash
   npm install
   ```
4. Initialize schema:
   ```bash
   npm run db:init
   ```
5. Start API, worker, and web in separate terminals:
   ```bash
   npm run dev:api
   npm run dev:worker
   npm run dev:web
   ```
6. Open http://localhost:3000. API defaults to http://localhost:4000.

## Gmail setup
1. Enable 2-Step Verification in the Google Account.
2. Create an App Password for this app.
3. Put the Gmail address in `GMAIL_USER` and the App Password in `GMAIL_APP_PASSWORD`.
4. Keep `DRY_RUN=true` until you have reviewed your configuration. Change it to `false` only when ready to send.
5. Use only appropriate, lawful outreach; contact only eligible recipients, respect opt-outs, and follow Gmail/provider limits.

This starter uses Gmail SMTP for outbound messages. Reply ingestion is intentionally implemented as an explicit integration point rather than pretending SMTP can read inbox replies. To enable automated reply detection, connect the Gmail API with OAuth and a properly configured Pub/Sub/watch flow, or implement IMAP access with explicit account authorization. Until then, use the Replies page to record replies manually; this still stops queued follow-ups.

## Main features
- Contact table, CSV import, duplicate detection and suppression status
- Campaign creation with `{{firstName}}`, `{{company}}`, `{{email}}` personalization
- Manual recipient entry in campaign builder: paste multiple email addresses separated by newlines, commas, or semicolons; addresses are deduplicated and added to contacts automatically
- Preview and manual approval before launch
- Campaign sending queue with configurable delay, retries, pause/resume
- Follow-up sequence scaffolding; jobs re-check campaign/contact eligibility before sending
- Replies page to record replies and stop future follow-ups
- Analytics for queued, sent/accepted, failed, bounced and replies
- Unsubscribe endpoint and suppression list
- Audit log events for important actions

## CSV format
Required: `email`. Optional: `firstName`, `lastName`, `company`, `jobTitle`, `source`.
Example:
```csv
email,firstName,lastName,company,jobTitle,source
person@example.com,Alex,Smith,Example Co,Engineering Manager,Google Doc export
```

## Important production hardening
This is a functional development MVP, not a production-reviewed bulk-mail product. Before production: add authenticated users/tenant isolation, CSRF/rate limiting, encrypted secrets, Gmail API OAuth and reply sync, verified unsubscribe identity, bounce/webhook ingestion, robust idempotency, migrations, monitoring, and legal review. Never use it to bypass provider limits or send unsolicited bulk spam.
