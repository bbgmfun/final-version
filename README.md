# Hotel Booking System — SE 4458 Spring 2025/26

> **Student:** Begüm Bal  
> **Course:** SE 4458 — Software Architecture & Design of Modern Large Scale Systems

Microservice-based hotel booking platform deployed on Azure Container Apps.

---

## Live URLs

| | URL |
|---|---|
| Frontend | https://frontend.mangowater-b28dd996.swedencentral.azurecontainerapps.io |
| API Gateway | https://api-gateway.mangowater-b28dd996.swedencentral.azurecontainerapps.io/v1 |
| API Docs (Swagger) | https://frontend.mangowater-b28dd996.swedencentral.azurecontainerapps.io/swagger |

---

## Architecture

```
           Browser
              │
              ▼
       ┌─────────────┐
       │ API Gateway │
       └──┬──┬──┬──┬─┘
          │  │  │  │
     IAM  │  │  │  │ AI Agent
    Svc   │  │  │  │  Svc
          │  │  │  │
       Hotel │ Comments
        Svc  │   Svc
             │
    ┌────────┼────────┐
  Redis   RabbitMQ  MongoDB
             │
    Notification Svc
    (cron + consumer)
```

**Stack:** Node.js · Express · MongoDB (Cosmos DB) · Redis · RabbitMQ · Microsoft Entra ID · Azure Container Apps

---

## Services

| Service | Port | Responsibility |
|---|---|---|
| `api-gateway` | 8080 | Single public entry-point, routes `/v1/*` |
| `iam-service` | 4001 | Entra ID token verification, role resolution |
| `hotel-service` | 4002 | Admin, search, booking, reservations |
| `comments-service` | 4003 | Per-hotel comments + rating breakdown |
| `notification-service` | 4004 | Queue consumer + nightly capacity scan |
| `ai-agent-service` | 4005 | LLM tool-calling agent (search → book) |
| `frontend` | 80 | Vanilla SPA served by nginx |

---

## API Endpoints (`/v1`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | — | Gateway health |
| `GET` | `/auth/me` | Bearer | Profile + role |
| `GET` | `/search?destination=&start=&end=&guests=` | optional | 15% discount when logged in |
| `GET` | `/hotels/:id` | optional | Redis-cached |
| `PUT` | `/admin/hotels/:id` | admin | Upsert hotel |
| `POST` | `/admin/hotels/:id/rooms` | admin | Add inventory |
| `PUT` | `/admin/hotels/:id/rooms/:roomId` | admin | Edit inventory |
| `POST` | `/hotels/:id/book` | user | Atomic booking + queue publish |
| `GET` | `/reservations` | user | User's reservations |
| `GET` | `/hotels/:id/comments` | — | Paginated |
| `GET` | `/hotels/:id/comments/summary` | — | Per-category rating breakdown |
| `POST` | `/hotels/:id/comments` | user | Add comment |
| `GET` | `/notifications` | — | Sent notifications |
| `POST` | `/jobs/capacity-scan` | — | Manual trigger of nightly scan |
| `POST` | `/chat` | optional | AI agent |

---

## Local Run

```bash
cp .env.example .env
# Optional: set LLM_API_KEY=<groq key> in .env for full AI agent support
docker compose up --build
```

| | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API Gateway | http://localhost:8080/v1/health |
| RabbitMQ Console | http://localhost:15672 (guest/guest) |

Hotels are seeded automatically on first boot (Bodrum, Istanbul, Izmir, Rome).

---

## Non-functional Requirements

| Requirement | Implementation |
|---|---|
| Managed IAM | Microsoft Entra ID (MSAL.js + JWKS verification) |
| Separate NoSQL DB for comments | MongoDB collection owned by `comments-service` |
| Distributed cache | Redis (`ioredis`) with in-memory fallback |
| Message queue | RabbitMQ (`amqplib`) — `reservations` queue |
| API Gateway | Express + fetch-based proxy, all routes under `/v1` |
| Pagination | `?page=&pageSize=` on search, comments, notifications |
| Nightly scheduled task | `node-cron` inside `notification-service` |
| Dockerfile per service | Yes + `docker-compose.yml` for local orchestration |

---

## Deployment

One-shot Azure deployment (no local Docker required — images build in the cloud):

```bash
LLM_API_KEY="<groq-key>" ./deploy/azure-deploy.sh
```

Provisions: Cosmos DB · Azure Cache for Redis · RabbitMQ on ACI · ACR · Azure Container Apps.  
Safe to re-run — existing resources are reused.

---

## Repo Layout

```
hotel-booking-system/
├── api-gateway/
├── services/
│   ├── iam-service/
│   ├── hotel-service/
│   ├── comments-service/
│   ├── notification-service/
│   └── ai-agent-service/
├── frontend/
│   └── src/swagger/          ← OpenAPI 3.0 spec + Swagger UI
├── deploy/
│   └── azure-deploy.sh
├── docker-compose.yml
└── .env.example
```
