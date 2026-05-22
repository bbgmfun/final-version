# Entity-Relationship description

Each bounded context owns its own collection(s). Foreign-key references across
collections are enforced at the application layer, not at the database, so each
service stays independently deployable.

Authentication is delegated to **Microsoft Entra ID** — there is no password
column anywhere. `iam-service` keeps a lightweight `profiles` record keyed by
the Entra object id (`oid`) so the app can resolve an identity to a role.

```
┌──────────────────────────┐
│      profiles            │   (iam-service, Mongo)
├──────────────────────────┤
│  _id  (Entra oid) string │◄─────────────────────────────┐
│  email         string ★  │                              │
│  name          string    │                              │
│  role          enum      │  (derived from ADMIN_EMAILS)  │
│  hotelIds      [string]  │──────────┐                   │
│  firstSeenAt   datetime  │          │                   │
│  lastSeenAt    datetime  │          │                   │
└──────────────────────────┘          │                   │
                                       │                   │
                                       │ owns              │
                                       ▼                   │
                            ┌──────────────────────┐       │
                            │       hotels          │      │   (hotel-service, Mongo)
                            ├──────────────────────┤       │
                            │  _id (slug) string ★ │       │
                            │  name        string   │      │
                            │  city        string   │      │
                            │  country     string   │      │
                            │  description string   │      │
                            │  imageUrl    string   │      │
                            │  location    {lat,lng}│      │
                            │  amenities   [string] │      │
                            │  rating      number   │      │
                            └──────────┬────────────┘      │
                                       │ 1                 │
                                       │                   │
                                       │ N                 │
                            ┌──────────▼────────────┐      │
                            │   roominventories      │     │   (hotel-service, Mongo)
                            ├───────────────────────┤      │
                            │  hotelId    →hotels   │      │
                            │  roomType   enum      │      │
                            │  startDate  date      │      │
                            │  endDate    date      │      │
                            │  totalRooms  int      │      │
                            │  availableRooms int   │      │
                            │  pricePerNight  num   │      │
                            │  status     enum      │      │
                            └───────────────────────┘      │
                                                            │
                            ┌───────────────────────┐       │
                            │     reservations      │       │   (hotel-service, Mongo)
                            ├───────────────────────┤       │
                            │  hotelId    →hotels   │       │
                            │  userId   →profiles   │───────┘
                            │  userEmail  string    │
                            │  roomType   string    │
                            │  startDate  date      │
                            │  endDate    date      │
                            │  guests     int       │
                            │  totalPrice  number   │
                            │  status     enum      │
                            └───────────────────────┘

                            ┌───────────────────────┐
                            │       comments        │   (comments-service, NoSQL bucket)
                            ├───────────────────────┤
                            │  hotelId    →hotels   │
                            │  userId   →profiles   │
                            │  userName   string    │
                            │  body       text      │
                            │  overall    0..10     │
                            │  serviceRatings { Map }│
                            │  tripType   string    │
                            └───────────────────────┘

                            ┌───────────────────────┐
                            │     notifications     │   (notification-service, NoSQL bucket)
                            ├───────────────────────┤
                            │  to        string     │
                            │  channel   enum       │
                            │  subject   string     │
                            │  body      text       │
                            │  meta      object     │
                            │  sentAt    datetime   │
                            └───────────────────────┘
```

★ = unique index

## Why these shapes

* `roominventories` is a *segmented* table — one row per date-window per room
  type. This lets admins describe complex seasonal pricing ("July is 15 000 TL,
  August is 20 000 TL") without bloating the room document, and lets the search
  query do a single `startDate ≤ X AND endDate ≥ Y` index lookup.
* `comments.serviceRatings` is a `Map`, not a fixed set of columns, because the
  per-service rubric (Temizlik, Personel, …) may change over time without a
  schema migration.
* `reservations` keeps the user's email denormalised so the notification-service
  doesn't need to call IAM to format an email.
