import "dotenv/config";
import express from "express";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { timingSafeEqual } from "node:crypto";

const required = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "BRIDGE_API_SECRET"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}
if (process.env.BRIDGE_API_SECRET.length < 32) {
  console.error("BRIDGE_API_SECRET must be at least 32 characters.");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// Starter cache only. This resets when the process restarts; add persistent storage later.
const players = new Map();
const servers = new Map();

function matchesSecret(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!matchesSecret(token, process.env.BRIDGE_API_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "okg-roblox-bridge", version: "0.1.0" });
});

app.post("/api/roblox/heartbeat", requireSecret, (req, res) => {
  const body = req.body;
  if (
    !body ||
    typeof body.jobId !== "string" ||
    body.jobId.length < 1 ||
    body.jobId.length > 128 ||
    !["public", "private", "admin"].includes(body.serverType) ||
    !Array.isArray(body.players) ||
    body.players.length > 100
  ) {
    return res.status(400).json({ error: "Invalid heartbeat payload" });
  }

  for (const player of body.players) {
    if (
      !player ||
      !Number.isSafeInteger(Number(player.userId)) ||
      Number(player.userId) <= 0 ||
      typeof player.username !== "string" ||
      player.username.length < 1 ||
      player.username.length > 32
    ) {
      return res.status(400).json({ error: "Invalid player entry" });
    }
  }

  const now = Date.now();
  for (const [userId, record] of players) {
    if (record.jobId === body.jobId) players.delete(userId);
  }

  servers.set(body.jobId, {
    jobId: body.jobId,
    serverType: body.serverType,
    playerCount: body.players.length,
    lastSeen: now,
  });

  for (const player of body.players) {
    const userId = String(player.userId);
    const prior = players.get(userId);
    players.set(userId, {
      userId,
      username: player.username,
      jobId: body.jobId,
      serverType: body.serverType,
      joinedAt: prior?.jobId === body.jobId ? prior.joinedAt : now,
      lastSeen: now,
    });
  }

  res.json({ ok: true, received: body.players.length });
});

app.get("/api/players/:userId", requireSecret, (req, res) => {
  const userId = req.params.userId;
  const record = players.get(userId);
  if (!record || Date.now() - record.lastSeen > 90_000) {
    return res.json({ online: false, userId });
  }

  res.json({
    online: true,
    userId: record.userId,
    username: record.username,
    serverId: record.jobId,
    serverType: record.serverType,
    playerCount: servers.get(record.jobId)?.playerCount ?? null,
    sessionSeconds: Math.max(0, Math.floor((Date.now() - record.joinedAt) / 1000)),
  });
});

const locateCommand = new SlashCommandBuilder()
  .setName("locate")
  .setDescription("Check whether a Roblox player is online")
  .addStringOption((option) =>
    option
      .setName("user")
      .setDescription("Roblox username or user ID")
      .setRequired(true)
      .setMaxLength(32),
  );

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
const commandRoute = process.env.DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID)
  : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);

client.once("ready", () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "locate") return;
  await interaction.deferReply();

  const query = interaction.options.getString("user", true).trim();
  let userId = /^\d+$/.test(query) ? query : null;

  if (!userId) {
    try {
      const lookup = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usernames: [query], excludeBannedUsers: true }),
        signal: AbortSignal.timeout(8000),
      });
      if (lookup.ok) {
        const result = await lookup.json();
        userId = result.data?.[0]?.id ? String(result.data[0].id) : null;
      }
    } catch {
      // Handled with the normal lookup-failed response below.
    }
  }

  if (!userId) {
    await interaction.editReply("I couldn't find that Roblox user. Check the username and try again.");
    return;
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:${process.env.PORT || 3000}/api/players/${encodeURIComponent(userId)}`,
      {
        headers: { authorization: `Bearer ${process.env.BRIDGE_API_SECRET}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    const data = await response.json();

    if (!data.online) {
      await interaction.editReply(`**${query}** is not currently reported in an online Roblox server.`);
      return;
    }

    const minutes = Math.floor(data.sessionSeconds / 60);
    const seconds = data.sessionSeconds % 60;
    await interaction.editReply(
      `**${data.username}** is online in Roblox.\n` +
      `• Server type: ${data.serverType}\n` +
      `• Players in server: ${data.playerCount ?? "unknown"}\n` +
      `• Current session: ${minutes}m ${seconds}s\n` +
      `• Server ID: \`${data.serverId}\``,
    );
  } catch {
    await interaction.editReply("The OKG Roblox bridge couldn't check player status right now.");
  }
});

async function start() {
  await rest.put(commandRoute, { body: [locateCommand.toJSON()] });
  console.log(process.env.DISCORD_GUILD_ID
    ? "Registered /locate in the configured test server."
    : "Registered /locate globally; propagation can take a little while.");

  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => {
    console.log(`OKG Roblox Bridge API listening on port ${port}`);
  });
  await client.login(process.env.DISCORD_TOKEN);
}

process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

start().catch((error) => {
  console.error("Failed to start OKG Roblox Bridge:", error);
  process.exit(1);
});
