# Architecture

This mirrors the deployment diagram in the assignment PDF and reflects what
is actually implemented in the repository.

```
                              ┌───────────────┐
                              │   AI Agent    │
                              │   Service     │
                              └───────┬───────┘
                                      │ HTTP
   ┌───────────────┐           ┌──────▼──────┐               ┌──────────────┐
   │ Admin Client  │──manage──►│             │               │  Hotel       │
   │ (browser)     │           │             │── search/book─►│  Service     │
   └───────────────┘           │ API Gateway │               │              │
                               │   (/v1/*)   │               └──────┬───────┘
   ┌───────────────┐           │             │                      │  publishes
   │ Client        │── search ►│             │                      ▼
   │ (browser)     │── book   ►│             │              ┌──────────────┐
   └──────┬────────┘           │             │              │   Queue      │
          │ sign in (MSAL)     │             │              │  (RabbitMQ)  │
          ▼                    │             │              └──────┬───────┘
   ┌──────────────┐           │             │                      │
   │  Microsoft   │◄──────────│             │                      │ drains
   │  Entra ID    │            │             │                      ▼
   └──────────────┘            │             │              ┌──────────────┐
                               │             │              │ Notification │
                               │             │              │   Service    │
                               │             │              │ (nightly +   │
                               │             │              │  consumer)   │
                               └──────┬──────┘              └──────────────┘
                                      │
                                      │ comments
                                      ▼
                               ┌──────────────┐
                               │  Comments    │
                               │   Service    │
                               └──────┬───────┘
                                      │
                              ┌───────▼───────┐
                              │  NoSQL DB     │
                              │  (Mongo)      │
                              └───────────────┘

                              ┌───────────────┐
                              │ Hotel Cache   │
                              │  (Redis)      │
                              └───────────────┘
                                      ▲
                                      │ get/set hotel-detail JSON
                                      │
                                      Hotel Service
```

## Bounded contexts & ownership

| Context | Service | Storage | Notes |
| --- | --- | --- | --- |
| Identity | **Microsoft Entra ID** + `iam-service` | `profiles` collection | Entra issues the tokens (RS256). Every service verifies them locally against the tenant JWKS keys — no chatty `/verify` calls per request. `iam-service` only maps an Entra identity to our app role and keeps a profile record. |
| Inventory & booking | `hotel-service` | `hotels`, `roominventories`, `reservations` | Owns the booking transaction. Publishes `reservation.confirmed` events. Caches hotel-detail responses in Redis. |
| Comments | `comments-service` | `comments` (NoSQL) | Independent collection, separately deployable. |
| Notifications | `notification-service` | `notifications` (NoSQL) | Cron + queue consumer. |
| Conversational orchestrator | `ai-agent-service` | – | Stateless; only calls other services. |
| Edge | `api-gateway` | – | Single public entrypoint; versioned routes; pagination supported on every collection endpoint. |

## Why each piece is required

* **API Gateway** — single public URL → smaller attack surface, simpler CORS, easy to swap services.
* **Distributed cache (Redis)** — hotel-detail reads dominate, writes are rare. Cache TTL 5 min, prefix invalidation on admin write.
* **Queue (RabbitMQ)** — decouples booking from outbound notifications. A slow email sender can never block a booking response.
* **NoSQL for comments** — write-heavy, schema-flexible workload (per-service ratings are a dictionary). Not a great fit for an RDBMS.
* **Separate IAM** — required by the spec; also lets us put the auth provider behind an enterprise SSO later without touching the booking domain.
* **Scheduler inside notification-service** — keeps the scheduled tasks co-located with the side-effect they trigger. For "fully external" scheduling, point Azure Logic App / Cloud Scheduler at `POST /v1/jobs/capacity-scan`.
