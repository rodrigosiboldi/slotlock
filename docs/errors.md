# Errors

Every error is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem, served as
`application/problem+json`:

```json
{
  "type": "https://github.com/rodrigosiboldi/slotlock/blob/main/docs/errors.md#slot-unavailable",
  "title": "Slot unavailable",
  "status": 409,
  "detail": "Another booking holds this resource at that time.",
  "instance": "/v1/bookings",
  "requestId": "0199c3f1-7d8e-7f9a-8b0c-1d2e3f4a5b6c"
}
```

Branch on `type` (stable), show `detail` to people (may change), and quote `requestId` when asking
for help: it is also in the server's structured logs and in the `X-Request-Id` response header.

## Request problems

### validation-error

`400` — one or more fields are missing or malformed. `errors` lists each one as
`{ "path": "customer.email", "message": "Invalid email address" }`. Malformed JSON, an invalid
pagination cursor and a malformed `Idempotency-Key` are reported the same way.

### body-too-large

`422` — request bodies are limited to 64 KB.

### invalid-range

`422` — a date range is reversed, empty, or longer than 31 days (availability).

## Authentication

### unauthorized

`401` — no `Authorization: Bearer <key>` header, or the key is unknown or revoked.

### insufficient-scope

`403` — the key is valid but lacks a scope; `requiredScope` names it. Publishable keys only have
`catalog:read`, `availability:read` and `bookings:create`.

## Booking problems

### slot-unavailable

`409` — the slot is taken. With a `resourceId`, another booking holds that resource (buffers
included); without one, every resource offering the service is busy at that time. Postgres decides
this (exclusion constraint `bookings_no_overlap`), so it is final even under heavy concurrency:
fetch availability again and pick another slot.

### slot-not-bookable

`422` — the slot can't be booked regardless of other bookings. `reason` says why:

| reason                  | meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `outside_opening_hours` | the slot (start + duration) doesn't fit in the resource's opening hours |
| `off_grid`              | publishable keys must use the start times availability offers           |
| `too_soon`              | publishable keys must respect the service's minimum notice              |
| `too_far_ahead`         | publishable keys must stay within the service's booking window          |
| `time_off`              | the resource is blocked by time off                                     |

### booking-cancelled

`409` — the booking is already cancelled and can't be cancelled or moved again.

### service-not-offered

`422` — the resource doesn't offer the service, or no active resource does.

### service-inactive

`422` — the service has been deactivated.

### resource-inactive

`422` — the resource has been deactivated.

### unknown-resource

`422` — a service references resource ids that don't belong to your organization; they are in
`resourceIds`.

### time-off-conflict

`409` — time off would overlap confirmed bookings; their ids are in `bookingIds`. Cancel or move
them first.

## Retries

### idempotency-key-reused

`422` — the `Idempotency-Key` was already used for a different request (another path or body).
Use a new key for a new request.

### idempotency-key-in-progress

`409` — a request with the same key is still being processed. Wait for `Retry-After` and repeat it:
you'll get the stored result.

### rate-limited

`429` — too many requests. `Retry-After` says when to try again; `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset` are on every response.

## Webhooks

### invalid-webhook-url

`422` — webhook URLs must be absolute `https://` URLs on the public internet: no credentials,
no private, loopback or link-local addresses. Addresses are checked again at every delivery.

## Demo

### invalid-race-ticket

`422` — the demo's race ticket is malformed, expired, or used for a different court.

## Server

### not-found

`404` — no such resource, or no such route.

### not-ready

`503` — returned by `/readyz` when the database is unreachable or the migrations haven't run.

### internal-error

`500` — something failed on the server. Nothing is exposed beyond the `requestId`; the logs have
the details.
