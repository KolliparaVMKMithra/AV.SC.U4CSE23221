const express = require("express");
const axios = require("axios");
const { Log } = require("../../../logging_middleware");
const { getToken } = require("../auth");

const router = express.Router();
const NOTIFICATION_API = "http://20.207.122.201/evaluation-service/notifications";

async function getAuthHeaders() {
  const token = await getToken();
  return { headers: { Authorization: `Bearer ${token}` } };
}

const TYPE_WEIGHT = { Placement: 3, Result: 2, Event: 1 };

function priorityScore(n) {
  return TYPE_WEIGHT[n.Type] * 1e12 + new Date(n.Timestamp).getTime();
}

function getTopN(notifications, n) {
  return [...notifications]
    .sort((a, b) => priorityScore(b) - priorityScore(a))
    .slice(0, n);
}

// GET /api/notifications
// GET /api/notifications?top=10
router.get("/", async (req, res) => {
  await Log("backend", "info", "route", "GET /api/notifications").catch(() => {});
  try {
    const headers = await getAuthHeaders();
    const response = await axios.get(NOTIFICATION_API, headers);
    const notifications = response.data.notifications;

    await Log("backend", "debug", "service", `Fetched ${notifications.length} notifications`).catch(() => {});

    const top = req.query.top ? parseInt(req.query.top, 10) : null;
    if (top && !isNaN(top) && top > 0) {
      await Log("backend", "info", "service", `Returning top ${top} priority notifications`).catch(() => {});
      const prioritised = getTopN(notifications, top);
      return res.json({ total: notifications.length, showing: prioritised.length, notifications: prioritised });
    }

    return res.json({ total: notifications.length, notifications });
  } catch (err) {
    await Log("backend", "error", "route", "GET /api/notifications failed").catch(() => {});
    return res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// GET /api/notifications/by-type/:type
router.get("/by-type/:type", async (req, res) => {
  const { type } = req.params;
  await Log("backend", "info", "route", `GET by-type/${type}`).catch(() => {});
  const validTypes = ["Placement", "Result", "Event"];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Type must be one of ${validTypes}` });
  }
  try {
    const headers = await getAuthHeaders();
    const response = await axios.get(NOTIFICATION_API, headers);
    const filtered = response.data.notifications.filter((n) => n.Type === type);
    await Log("backend", "debug", "service", `Filtered ${filtered.length} of type ${type}`).catch(() => {});
    return res.json({ type, count: filtered.length, notifications: filtered });
  } catch (err) {
    await Log("backend", "error", "handler", "by-type fetch failed").catch(() => {});
    return res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// GET /api/notifications/:id
router.get("/:id", async (req, res) => {
  await Log("backend", "info", "route", `GET notification by id`).catch(() => {});
  try {
    const headers = await getAuthHeaders();
    const response = await axios.get(NOTIFICATION_API, headers);
    const found = response.data.notifications.find((n) => n.ID === req.params.id);
    if (!found) {
      await Log("backend", "warn", "handler", "Notification not found").catch(() => {});
      return res.status(404).json({ error: "Notification not found" });
    }
    return res.json(found);
  } catch (err) {
    await Log("backend", "error", "handler", "GET by id failed").catch(() => {});
    return res.status(500).json({ error: "Failed to fetch notification" });
  }
});

// POST /api/notifications/mark-read
const readSet = new Set();
router.post("/mark-read", async (req, res) => {
  await Log("backend", "info", "route", "POST mark-read").catch(() => {});
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    await Log("backend", "warn", "handler", "mark-read invalid payload").catch(() => {});
    return res.status(400).json({ error: "ids must be a non-empty array" });
  }
  ids.forEach((id) => readSet.add(id));
  await Log("backend", "info", "service", `Marked ${ids.length} as read`).catch(() => {});
  return res.json({ message: "Marked as read", markedIds: ids });
});

module.exports = router;