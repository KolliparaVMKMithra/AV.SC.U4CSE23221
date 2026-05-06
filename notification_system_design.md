# Notification System Design

---

# Stage 1

## REST API Design

### Core Actions Supported
The notification platform supports the following core actions:

- Fetch all notifications for a logged-in student
- Fetch a single notification by ID
- Fetch notifications filtered by type (Placement / Result / Event)
- Mark one or more notifications as read
- Subscribe to real-time notifications

### Endpoints

#### 1. Get All Notifications
```
GET /api/notifications
Authorization: Bearer <token>

Response 200:
{
  "total": 12,
  "notifications": [
    {
      "ID": "d146095a-0d86-4a34-9e69-3900a14576bc",
      "Type": "Result",
      "Message": "mid-sem",
      "Timestamp": "2026-04-22 17:51:30",
      "isRead": false
    }
  ]
}
```

#### 2. Get Notification by ID
```
GET /api/notifications/:id
Authorization: Bearer <token>

Response 200:
{
  "ID": "d146095a-0d86-4a34-9e69-3900a14576bc",
  "Type": "Placement",
  "Message": "CSX Corporation hiring",
  "Timestamp": "2026-04-22 17:51:18",
  "isRead": false
}

Response 404:
{ "error": "Notification not found" }
```

#### 3. Get Notifications by Type
```
GET /api/notifications/by-type/:type
Authorization: Bearer <token>
# type: Placement | Result | Event

Response 200:
{
  "type": "Placement",
  "count": 3,
  "notifications": [...]
}
```

#### 4. Mark Notifications as Read
```
POST /api/notifications/mark-read
Authorization: Bearer <token>
Content-Type: application/json

Request:
{ "ids": ["id1", "id2"] }

Response 200:
{ "message": "Marked as read", "markedIds": ["id1", "id2"] }
```

#### 5. Priority Inbox (Top N)
```
GET /api/notifications?top=10
Authorization: Bearer <token>

Response 200:
{
  "total": 50,
  "showing": 10,
  "notifications": [ ...top 10 by priority... ]
}
```

### Real-Time Notification Mechanism — WebSockets (Socket.IO)

For real-time delivery, the server maintains a WebSocket connection per student session.

```
Client connects → server authenticates via token
Server emits 'notification' events as they arrive:
{
  "event": "notification",
  "data": {
    "ID": "...",
    "Type": "Placement",
    "Message": "Google hiring drive",
    "Timestamp": "2026-05-06 10:00:00"
  }
}
```

The server-side component polls the upstream API (or listens to a message queue in production) and pushes to connected clients. Students receive live updates without polling.

---

# Stage 2

## Persistent Storage — Database Choice

**Chosen: PostgreSQL (Relational)**

### Rationale
- Notifications have a fixed, predictable schema (ID, Type, Message, Timestamp, isRead, studentID)
- SQL is ideal for filtering by type, student, read status — all exact-match queries
- ACID guarantees ensure no notification is silently dropped on write failure
- Strong ecosystem (pg, Prisma, TypeORM) with excellent Node.js support

### DB Schema

```sql
CREATE TABLE students (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE NOT NULL,
  name       VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        INT REFERENCES students(id) ON DELETE CASCADE,
  type              notification_type NOT NULL,
  message           TEXT NOT NULL,
  is_read           BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMP DEFAULT NOW()
);

CREATE TYPE notification_type AS ENUM ('Placement', 'Result', 'Event');

CREATE INDEX idx_notifications_student_unread
  ON notifications (student_id, is_read, created_at DESC);

CREATE INDEX idx_notifications_type
  ON notifications (type);
```

### Queries for Stage 1 APIs

**Get all unread notifications for a student:**
```sql
SELECT id, type, message, is_read, created_at
FROM notifications
WHERE student_id = $1 AND is_read = FALSE
ORDER BY created_at DESC;
```

**Mark notifications as read:**
```sql
UPDATE notifications
SET is_read = TRUE
WHERE id = ANY($1::uuid[]) AND student_id = $2;
```

**Get by type:**
```sql
SELECT * FROM notifications
WHERE student_id = $1 AND type = $2
ORDER BY created_at DESC;
```

### Scaling Problems as Data Volume Grows

1. **Table size**: 50,000 students × 100 notifications each = 5M rows. Full scans become slow.
2. **Write amplification**: During placement season, thousands of inserts per second can bottleneck a single writer.
3. **Index bloat**: Indexes grow with data and can become slow to update under write load.

### Solutions
- **Composite indexes** on `(student_id, is_read, created_at)` — covers the most common query pattern
- **Partitioning** by `created_at` range (monthly partitions) — keeps hot data in small partitions
- **Read replicas** for SELECT-heavy student-facing reads
- **Archival**: move notifications older than 6 months to cold storage (S3/BigQuery)

---

# Stage 3

## Query Analysis

### Original slow query:
```sql
SELECT * FROM notifications
WHERE studentID = 1042 AND isRead = false
ORDER BY createdAt DESC;
```

### Is the query accurate?
**Yes**, the logic is correct — it returns unread notifications for a student sorted newest-first.

### Why is it slow?

At 5M rows, without an index on `(studentID, isRead, createdAt)`, PostgreSQL does a **full sequential scan** — reading all 5M rows to find matches. The `ORDER BY` then requires a sort operation on the filtered result set. Both are O(n) or worse.

### What to change

```sql
-- Add a composite index
CREATE INDEX idx_notifications_student_unread
  ON notifications (student_id, is_read, created_at DESC);

-- Rewrite query to use only needed columns (avoid SELECT *)
SELECT id, type, message, created_at
FROM notifications
WHERE student_id = 1042 AND is_read = false
ORDER BY created_at DESC;
```

**Computation cost after fix:** The index makes this an **O(log n)** B-tree lookup, then a sequential scan of only the matching rows for that student. Response drops from ~seconds to ~milliseconds.

### Should we add indexes on EVERY column?

**No. This is bad advice.** Here's why:
- Every index adds overhead on every INSERT, UPDATE, and DELETE
- With high write volume (placement season), indexing every column would severely degrade write throughput
- Most columns (message text, foreign keys rarely filtered) gain nothing from individual indexes
- Only index columns that appear in WHERE, ORDER BY, or JOIN clauses for high-frequency queries

### Query: Students who received a Placement notification in last 7 days

```sql
SELECT DISTINCT s.id, s.email, s.name
FROM students s
JOIN notifications n ON n.student_id = s.id
WHERE n.type = 'Placement'
  AND n.created_at >= NOW() - INTERVAL '7 days';
```

---

# Stage 4

## Performance — Caching Strategy

### Problem
Notifications fetched on every page load for every student → DB overwhelmed.

### Solution 1: Server-Side Cache (Redis) — Recommended

Cache the notification list per student with a short TTL.

```
On GET /api/notifications for student X:
  1. Check Redis key: notifications:student:{id}
  2. If HIT → return cached JSON (< 1ms)
  3. If MISS → query DB → store in Redis with TTL=60s → return result
```

**Tradeoffs:**
- PRO: Massively reduces DB load, near-instant responses
- PRO: Easy to implement, well-understood pattern
- CON: Students may see notifications up to 60s stale
- CON: Cache invalidation needed when new notification arrives (delete the key)
- CON: Redis is another infrastructure component to manage

### Solution 2: HTTP Cache-Control Headers

```
Cache-Control: max-age=30, stale-while-revalidate=60
```

**Tradeoffs:**
- PRO: Zero backend infrastructure needed
- PRO: Browser and CDN handle caching automatically
- CON: Different students share no cache benefit
- CON: Hard to invalidate when a new notification arrives

### Solution 3: Pagination + Lazy Loading

Instead of fetching all notifications on load, fetch only the first page (top 10).

**Tradeoffs:**
- PRO: Immediate reduction in data transferred
- PRO: DB queries bounded regardless of total notification count
- CON: Doesn't reduce query frequency, only payload size
- CON: More complex frontend state management

### Recommended Combined Strategy
Use **Redis** (TTL=30s) + **WebSocket push** to invalidate/update the cache when a new notification arrives. This gives both freshness and performance.

---

# Stage 5

## Bulk Notification — Analysis

### Original pseudocode:
```
function notify_all(student_ids, message):
    for student_id in student_ids:
        send_email(student_id, message)   # calls Email API
        save_to_db(student_id, message)   # DB insert
        push_to_app(student_id, message)  # WebSocket push
```

### Shortcomings

1. **Sequential processing**: With 50,000 students, this is purely serial. At 100ms per student (email + DB + push), total time = 83 minutes. Completely unacceptable.
2. **No error handling**: If `send_email` fails for student 200, the entire loop may crash. Students 201-50,000 get nothing.
3. **Atomicity problem**: DB save and email send are not atomic. A student could receive the email but the notification never saved to DB (or vice versa).
4. **Email API rate limits**: Sending 50,000 individual API calls will hit rate limits almost immediately.
5. **No retry logic**: Transient failures are treated as permanent.

### What happened: send_email failed for 200 students midway

The loop stopped at student 200. Students 201-50,000 received neither email nor DB record. The only recovery is to re-run from the last known good state, but there's no checkpoint.

### Should saving to DB and sending email happen together (atomically)?

**Not in a distributed transaction, but they should be coordinated.** True atomicity across DB + Email API is impossible (two-phase commit is impractical here). The correct pattern is:

1. **Save to DB first** (source of truth)
2. **Enqueue the email** (job queue, not direct API call)
3. **Email worker processes the queue** with retries

This way, even if the email service is down, the notification is already in the DB and the queue will retry the email when the service recovers.

### Redesigned Implementation

```
function notify_all(student_ids, message):
    // Step 1: Bulk insert all notifications to DB in one transaction
    db.bulk_insert([
        { student_id, message, type: "Placement", created_at: now() }
        for student_id in student_ids
    ])

    // Step 2: Enqueue email jobs (non-blocking, batched)
    for batch in chunks(student_ids, size=500):
        message_queue.publish("email_queue", {
            student_ids: batch,
            message: message,
            idempotency_key: uuid()
        })

    // Step 3: Push real-time via WebSocket (fan-out from queue)
    message_queue.publish("push_queue", {
        student_ids: student_ids,
        message: message
    })

// Email Worker (separate process, auto-retries):
function email_worker():
    while true:
        job = message_queue.consume("email_queue")
        try:
            email_api.send_batch(job.student_ids, job.message)
            job.ack()
        except RateLimitError:
            job.nack(delay=5s)  // retry after 5s
        except Exception as e:
            log_failure(job, e)
            job.nack(delay=30s)
```

**Key improvements:**
- DB insert is a single bulk transaction — O(1) regardless of student count
- Email is decoupled via queue (BullMQ / RabbitMQ / SQS) with automatic retries
- If send_email fails for 200 students, the queue retries just those 200 — no data loss
- Email and DB save are eventually consistent, not tightly coupled — this is the correct approach for distributed systems

---

# Stage 6

## Priority Inbox Implementation

### Approach: Max-Heap on Composite Priority Score

Priority is determined by a composite score:

```
score(notification) = TYPE_WEIGHT * 10^12 + unix_timestamp_ms
```

Where:
```
TYPE_WEIGHT: Placement=3, Result=2, Event=1
```

The timestamp component (in ms) breaks ties within the same type — newer notifications rank higher. The large multiplier (`10^12`) ensures type always dominates over recency.

### Algorithm

A **max-heap** is used to efficiently find top-N notifications without sorting all of them. Time complexity: **O(n log k)** where n = total notifications, k = top-N requested. This is optimal for streaming/dynamic data.

```javascript
// Score function
function priorityScore(notification) {
  const typeScore = { Placement: 3, Result: 2, Event: 1 }[notification.Type] || 0;
  const recencyScore = new Date(notification.Timestamp).getTime();
  return typeScore * 1e12 + recencyScore;
}
```

### Maintaining Top-10 as New Notifications Arrive

Since notifications stream in continuously, maintain a **fixed-size min-heap of size k**:

- For each new notification: if its score > heap.min() → pop the min, push the new one
- This keeps the heap always containing the top-k with O(log k) per insertion
- No need to re-sort the entire dataset on each new notification

This is the classic **sliding window top-k** pattern, used in streaming analytics systems.

### API

```
GET /api/notifications?top=10
```

Returns the top 10 notifications ranked by: Placement > Result > Event, then by recency within each type.
