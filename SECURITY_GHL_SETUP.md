# Booking Security + GoHighLevel Setup

This project now supports a hybrid GoHighLevel flow:
1) upsert contact from booking payload
2) trigger a GHL workflow (message template managed in GHL)
3) optional payment confirmation workflow after successful payment

It also includes anti-abuse controls:
- CAPTCHA verification (Cloudflare Turnstile)
- strict phone validation (E.164, CA/US allowlist)
- IP rate limit + IP cooldown + phone-level throttling

## 1. Environment Variables
Use `.env.example` as template and set these values in your hosting environment:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- `GHL_PRIVATE_TOKEN`
- `GHL_LOCATION_ID`
- `GHL_BOOKING_WORKFLOW_ID`
- `GHL_PAYMENT_WORKFLOW_ID` (optional)
- `TRUST_PROXY_HOPS=1` (or higher if multiple trusted proxies)
- `DATABASE_DIR=database` (default). For Render disk, use `/data/database`.
- `PUBLIC_BASE_URL=https://your-service-domain` (optional; leave empty to auto-detect host)
- Optional recovery: `ADMIN_BOOTSTRAP_USERNAME`, `ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_BOOTSTRAP_FORCE_RESET=true`

For payment providers:
- Stripe: `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`  
  Use `pk_test/sk_test` in test env (no real charge), `pk_live/sk_live` in production.
- PayPal: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox|live`

If GHL vars are not complete, booking still succeeds but notification is skipped.

## 2. GoHighLevel Workflow
Create a workflow in GHL that sends SMS and map message content there.
The server now sends booking context as contact custom fields with keys:

- `booking_room`
- `booking_party_size`
- `booking_date`
- `booking_time`
- `booking_duration`
- `booking_id`
- `booking_upsell_interest`

Use those fields inside your workflow message template.

## 3. AWS Production Notes
Recommended stack:
- CloudFront/ALB + AWS WAF rate-based rules
- app-level limits in this service (already implemented)

Make sure proxy headers are trusted correctly (`TRUST_PROXY_HOPS`) so IP-based limits use real client IP.
