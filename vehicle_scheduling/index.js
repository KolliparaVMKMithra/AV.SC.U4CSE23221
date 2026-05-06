require("dotenv").config();
const axios = require("axios");
const { Log, setToken } = require("../logging_middleware");

const BASE_URL = "http://20.207.122.201/evaluation-service";
const TOKEN = process.env.AFFORDMED_TOKEN;

setToken(TOKEN);

function getAuthHeaders() {
  return { headers: { Authorization: `Bearer ${TOKEN}` } };
}

function knapsack(items, capacity) {
  const n = items.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(capacity + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    const { Duration, Impact } = items[i - 1];
    for (let w = 0; w <= capacity; w++) {
      dp[i][w] = dp[i - 1][w];
      if (Duration <= w) {
        dp[i][w] = Math.max(dp[i][w], dp[i - 1][w - Duration] + Impact);
      }
    }
  }

  const selected = [];
  let w = capacity;
  for (let i = n; i >= 1; i--) {
    if (dp[i][w] !== dp[i - 1][w]) {
      selected.push(items[i - 1]);
      w -= items[i - 1].Duration;
    }
  }

  return {
    selectedTasks: selected,
    totalImpact: dp[n][capacity],
    totalDuration: selected.reduce((sum, t) => sum + t.Duration, 0),
  };
}

async function fetchDepots() {
  await Log("backend", "info", "service", "Fetching depots");
  try {
    const res = await axios.get(`${BASE_URL}/depots`, getAuthHeaders());
    await Log("backend", "info", "service", `Got ${res.data.depots.length} depots`);
    return res.data.depots;
  } catch (err) {
    await Log("backend", "fatal", "service", "Failed to fetch depots");
    throw err;
  }
}

async function fetchVehicles() {
  await Log("backend", "info", "service", "Fetching vehicles");
  try {
    const res = await axios.get(`${BASE_URL}/vehicles`, getAuthHeaders());
    await Log("backend", "info", "service", `Got ${res.data.vehicles.length} vehicles`);
    return res.data.vehicles;
  } catch (err) {
    await Log("backend", "fatal", "service", "Failed to fetch vehicles");
    throw err;
  }
}

async function main() {
  await Log("backend", "info", "service", "Scheduler started");

  const [depots, vehicles] = await Promise.all([fetchDepots(), fetchVehicles()]);

  for (const depot of depots) {
    const { ID, MechanicHours } = depot;
    await Log("backend", "debug", "service", `Depot ${ID} budget=${MechanicHours}h`);

    const result = knapsack(vehicles, MechanicHours);

    await Log("backend", "info", "service", `Depot ${ID} impact=${result.totalImpact}`);

    console.log(`\nDepot ${ID} | Budget: ${MechanicHours}h | Used: ${result.totalDuration}h | Total Impact: ${result.totalImpact} | Tasks: ${result.selectedTasks.length}`);
    console.table(
      result.selectedTasks.map((t) => ({
        TaskID: t.TaskID,
        Duration: t.Duration,
        Impact: t.Impact,
      }))
    );
  }

  await Log("backend", "info", "service", "Scheduler completed");
}

main().catch(async (err) => {
  await Log("backend", "fatal", "service", "Scheduler crashed").catch(() => {});
  console.error(err);
  process.exit(1);
});