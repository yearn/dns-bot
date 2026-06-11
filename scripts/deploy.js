const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// CI-only deploy script: runs from the GitHub Actions deploy workflow with
// all configuration passed via environment variables. It must never prompt —
// anything missing fails the run loudly instead.
//
// TELEGRAM_BOT_TOKEN is the only worker secret. The rest are plain-text vars
// (GitHub repo variables) passed to `wrangler deploy --var` so they're
// visible in the Cloudflare dashboard for debugging.

const REQUIRED_ENV = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "MONITOR_DOMAINS",
];

// Plain-text vars; TELEGRAM_THREAD_ID and HEARTBEAT_URL are optional
const TEXT_VARS = [
  "MONITOR_DOMAINS",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_THREAD_ID",
  "HEARTBEAT_URL",
];

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function checkRequiredEnv() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    fail(`Missing required environment variables: ${missing.join(", ")}`);
  }
  console.log("✅ All required environment variables are set");
}

function checkKVNamespace() {
  const wranglerPath = path.join(__dirname, "../wrangler.toml");
  const wranglerContent = fs.readFileSync(wranglerPath, "utf8");
  const match = wranglerContent.match(/id\s*=\s*"([^"]+)"/);
  if (!match) {
    fail("KV namespace id is not configured in wrangler.toml");
  }
  console.log("✅ KV namespace configured in wrangler.toml");
}

function setupBotTokenSecret() {
  console.log("🌀 Uploading TELEGRAM_BOT_TOKEN secret...");
  const result = spawnSync(
    "npx",
    ["wrangler", "secret", "put", "TELEGRAM_BOT_TOKEN"],
    {
      input: process.env.TELEGRAM_BOT_TOKEN,
      stdio: ["pipe", "inherit", "inherit"],
    }
  );
  if (result.status !== 0) {
    fail("Failed to set TELEGRAM_BOT_TOKEN");
  }
}

function deleteLegacySecrets() {
  // These used to be worker secrets and are now plain-text vars; a leftover
  // secret with the same name conflicts with the var binding on deploy.
  // Wrangler auto-confirms the delete prompt when running non-interactively,
  // and a failed delete just means the secret is already gone.
  for (const name of TEXT_VARS) {
    const result = spawnSync("npx", ["wrangler", "secret", "delete", name], {
      stdio: "pipe",
    });
    if (result.status === 0) {
      console.log(`✅ Deleted legacy secret ${name}`);
    } else {
      console.log(`ℹ️ No legacy secret ${name} to delete`);
    }
  }
}

function deploy() {
  const args = ["wrangler", "deploy"];
  for (const name of TEXT_VARS) {
    const value = process.env[name];
    if (value) {
      args.push("--var", `${name}:${value}`);
    }
  }

  console.log("\n📦 Deploying...");
  const result = spawnSync("npx", args, { stdio: "inherit" });
  if (result.status !== 0) {
    fail("Deployment failed");
  }
  console.log("\n✅ Deployment completed successfully!");
}

checkRequiredEnv();
checkKVNamespace();
setupBotTokenSecret();
deleteLegacySecrets();
deploy();
