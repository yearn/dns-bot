const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
require("dotenv").config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper to run commands and handle errors
function runCommand(command, errorMessage) {
  try {
    return execSync(command, { stdio: "inherit" });
  } catch (error) {
    console.error(`❌ ${errorMessage}`);
    console.error(error.message);
    process.exit(1);
  }
}

// Helper to prompt for input
function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Check if Wrangler is installed
function checkWrangler() {
  try {
    execSync("npx wrangler --version", { stdio: "ignore" });
    console.log("✅ Wrangler is installed");
  } catch (error) {
    console.error("❌ Installing Wrangler...");
    runCommand(
      "npm install --save-dev wrangler@4",
      "Failed to install Wrangler"
    );
  }
}

// Check if logged in to Cloudflare
function checkCloudflareLogin() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    console.log("✅ Using CLOUDFLARE_API_TOKEN from environment");
    return;
  }
  try {
    execSync("npx wrangler whoami", { stdio: "ignore" });
    console.log("✅ Logged in to Cloudflare");
  } catch (error) {
    console.error("❌ Not logged in to Cloudflare. Please login...");
    runCommand("npx wrangler login", "Failed to login to Cloudflare");
  }
}

// Check KV namespace is configured in wrangler.toml
async function setupKVNamespace() {
  const wranglerPath = path.join(__dirname, "../wrangler.toml");
  const wranglerContent = fs.readFileSync(wranglerPath, "utf8");
  const match = wranglerContent.match(/id\s*=\s*"([^"]*)"/);

  if (match && match[1]) {
    console.log("✅ KV namespace already configured in wrangler.toml");
    return;
  }

  // Temporarily remove kv_namespaces so wrangler doesn't choke on the empty id
  const stripped = wranglerContent.replace(
    /# KV Namespace configuration\nkv_namespaces = \[.*\]\n/s,
    ""
  );
  fs.writeFileSync(wranglerPath, stripped);

  console.log("Creating KV namespace...");
  let output;
  try {
    output = execSync('npx wrangler kv namespace create "DNS_KV"', {
      encoding: "utf8",
    });
  } catch (error) {
    // Restore original content on failure
    fs.writeFileSync(wranglerPath, wranglerContent);
    console.error("❌ Failed to create KV namespace");
    process.exit(1);
  }

  const idMatch = output.match(/id = "([^"]+)"/);
  if (!idMatch) {
    fs.writeFileSync(wranglerPath, wranglerContent);
    console.error("❌ Failed to parse KV namespace ID from output");
    process.exit(1);
  }

  // Restore with the real ID
  const newContent = wranglerContent.replace(
    /id\s*=\s*"[^"]*"/,
    `id = "${idMatch[1]}"`
  );
  fs.writeFileSync(wranglerPath, newContent);
  console.log("✅ KV namespace created and added to wrangler.toml");
}

// Check and set up Telegram secrets
async function setupTelegramSecrets() {
  // TELEGRAM_BOT_TOKEN
  let botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    console.log("ℹ️ Using TELEGRAM_BOT_TOKEN from environment");
    runCommand(
      `echo '${botToken}' | npx wrangler secret put TELEGRAM_BOT_TOKEN`,
      "Failed to set Telegram bot token from environment"
    );
  } else {
    try {
      execSync("npx wrangler secret get TELEGRAM_BOT_TOKEN", {
        stdio: "ignore",
      });
      console.log("✅ Telegram bot token is set");
    } catch (error) {
      const token = await prompt("Enter your Telegram bot token: ");
      runCommand(
        `echo '${token}' | npx wrangler secret put TELEGRAM_BOT_TOKEN`,
        "Failed to set Telegram bot token"
      );
    }
  }

  // TELEGRAM_CHAT_ID
  let chatId = process.env.TELEGRAM_CHAT_ID;
  if (chatId) {
    console.log("ℹ️ Using TELEGRAM_CHAT_ID from environment");
    runCommand(
      `echo '${chatId}' | npx wrangler secret put TELEGRAM_CHAT_ID`,
      "Failed to set Telegram chat ID from environment"
    );
  } else {
    try {
      execSync("npx wrangler secret get TELEGRAM_CHAT_ID", { stdio: "ignore" });
      console.log("✅ Telegram chat ID is set");
    } catch (error) {
      const chatIdPrompt = await prompt("Enter your Telegram chat ID: ");
      runCommand(
        `echo '${chatIdPrompt}' | npx wrangler secret put TELEGRAM_CHAT_ID`,
        "Failed to set Telegram chat ID"
      );
    }
  }

  // TELEGRAM_THREAD_ID (optional — for posting to a specific topic in a group chat)
  let threadId = process.env.TELEGRAM_THREAD_ID;
  if (threadId) {
    console.log("ℹ️ Using TELEGRAM_THREAD_ID from environment");
    runCommand(
      `echo '${threadId}' | npx wrangler secret put TELEGRAM_THREAD_ID`,
      "Failed to set Telegram thread ID from environment"
    );
  } else {
    console.log(
      "ℹ️ TELEGRAM_THREAD_ID not set (optional — only needed for group chat topics)"
    );
  }
}

// Set up MONITOR_DOMAINS from environment
async function setupMonitorDomains() {
  let domains = process.env.MONITOR_DOMAINS;
  if (domains) {
    console.log("ℹ️ Using MONITOR_DOMAINS from environment");
    runCommand(
      `echo '${domains}' | npx wrangler secret put MONITOR_DOMAINS`,
      "Failed to set MONITOR_DOMAINS"
    );
  } else {
    try {
      execSync("npx wrangler secret get MONITOR_DOMAINS", { stdio: "ignore" });
      console.log("✅ MONITOR_DOMAINS is set");
    } catch (error) {
      const domainsPrompt = await prompt(
        "Enter domains to monitor (comma-separated): "
      );
      runCommand(
        `echo '${domainsPrompt}' | npx wrangler secret put MONITOR_DOMAINS`,
        "Failed to set MONITOR_DOMAINS"
      );
    }
  }
}

// Main deployment process
async function deploy() {
  console.log("🚀 Starting deployment process...\n");

  // Check prerequisites
  checkWrangler();
  checkCloudflareLogin();

  // Set up configuration
  await setupKVNamespace();
  await setupTelegramSecrets();
  await setupMonitorDomains();

  // Deploy
  console.log("\n📦 Deploying...");
  runCommand("npx wrangler deploy", "Deployment failed");

  console.log("\n✅ Deployment completed successfully!");
  rl.close();
}

// Run deployment
deploy().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exit(1);
});
