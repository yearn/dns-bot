interface Env {
  DNS_KV: KVNamespace;
  MONITOR_DOMAINS: string; // Comma-separated list of domains
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_THREAD_ID?: string;
  HEARTBEAT_URL?: string; // Uptime Kuma push URL, pinged after each run
  // Expected IP ranges for domains on dynamic hosting, e.g.
  // "flexmeow.com=216.150.0.0/16;other.com=76.76.21.0/24,76.76.22.0/24".
  // IP changes that stay inside a domain's ranges update state silently
  // instead of alerting.
  ALLOWED_IP_RANGES?: string;
}

interface DNSResponse {
  Status: number;
  TC: boolean;
  RD: boolean;
  RA: boolean;
  AD: boolean;
  CD: boolean;
  Answer?: Array<{
    name: string;
    type: number;
    TTL: number;
    data: string;
  }>;
  Question?: Array<{
    name: string;
    type: number;
  }>;
  Comment?: string[];
}

async function sendTelegramMessage(env: Env, message: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      ...(env.TELEGRAM_THREAD_ID && {
        message_thread_id: Number(env.TELEGRAM_THREAD_ID),
      }),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to send Telegram message: ${response.status} ${response.statusText} - ${body}`
    );
  }
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255 || part !== String(n)) {
      return null;
    }
    value = value * 256 + n;
  }
  return value;
}

// Malformed CIDRs or non-IPv4 addresses never match, so bad config
// fails toward alerting rather than suppressing
function ipInCidr(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split("/");
  const ipInt = ipToInt(ip);
  const baseInt = ipToInt(base);
  const prefix = Number(prefixStr);
  if (
    ipInt === null ||
    baseInt === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

function allowedRangesFor(domain: string, env: Env): string[] {
  if (!env.ALLOWED_IP_RANGES) return [];
  for (const entry of env.ALLOWED_IP_RANGES.split(";")) {
    const [entryDomain, cidrList] = entry.split("=");
    // DNS names are case-insensitive, so a case mismatch between
    // ALLOWED_IP_RANGES and MONITOR_DOMAINS must not disable suppression
    if (entryDomain?.trim().toLowerCase() === domain.toLowerCase() && cidrList) {
      return cidrList
        .split(",")
        .map((cidr) => cidr.trim())
        .filter(Boolean);
    }
  }
  return [];
}

async function queryDNS(domain: string): Promise<DNSResponse> {
  const server = "https://cloudflare-dns.com/dns-query";
  const url = new URL(server);
  url.searchParams.append("name", domain);
  url.searchParams.append("type", "SOA"); // First query SOA record

  console.log(`Querying DNS server for SOA: ${url.toString()}`);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/dns-json",
    },
  });

  console.log(`Response status:`, response.status);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  console.log("Response headers:", JSON.stringify(responseHeaders, null, 2));

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DNS query failed: ${response.status} - ${errorText}`);
  }

  const soaData: DNSResponse = await response.json();
  console.log("SOA Response data:", JSON.stringify(soaData, null, 2));

  // Now query A records
  url.searchParams.set("type", "A");
  console.log(`Querying DNS server for A records: ${url.toString()}`);

  const aResponse = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/dns-json",
    },
  });

  if (!aResponse.ok) {
    const errorText = await aResponse.text();
    throw new Error(`DNS query failed: ${aResponse.status} - ${errorText}`);
  }

  const aData: DNSResponse = await aResponse.json();
  console.log("A Record Response data:", JSON.stringify(aData, null, 2));

  // Combine both responses
  return {
    ...aData,
    Answer: [...(aData.Answer || []), ...(soaData.Answer || [])],
  };
}

// Returns true if the check completed and any needed alert was delivered
async function checkDomain(domain: string, env: Env): Promise<boolean> {
  try {
    const dnsData = await queryDNS(domain);

    // Check for "No Reachable Authority" case
    const noAuthority = dnsData.Comment?.some((comment) =>
      comment.includes("No Reachable Authority")
    );

    if (noAuthority) {
      // Get the previous state from KV
      const previousState = await env.DNS_KV.get(`dns:${domain}:state`);

      if (previousState !== "no_authority") {
        // State has changed to no authority
        const message =
          `⚠️ <b>DNS Authority Unreachable</b>\n\n` +
          `Domain: <code>${domain}</code>\n` +
          `Status: <code>No Reachable Authority</code>\n` +
          `Time: ${new Date().toISOString()}\n\n` +
          `<b>Technical Details:</b>\n` +
          `- DNS Status: <code>${dnsData.Status}</code>\n` +
          `- Comments: <code>${dnsData.Comment?.join(", ")}</code>\n` +
          `- Worker: <code>dns-bot</code>`;

        // Send the alert before committing state to KV so a failed send
        // retries on the next run instead of being lost
        await sendTelegramMessage(env, message);
        await env.DNS_KV.put(`dns:${domain}:state`, "no_authority");
        console.log(`DNS authority unreachable for ${domain}`);
      }
      return true;
    }

    // Get all A records
    const aRecords =
      dnsData.Answer?.filter((answer) => answer.type === 1) || [];

    // Get SOA record
    const soaRecord = dnsData.Answer?.find((answer) => answer.type === 6);
    const soaData = soaRecord?.data.split(" ") || [];
    const serial = soaData[2] || "unknown";

    // Get the previous state and IPs from KV
    const previousState = await env.DNS_KV.get(`dns:${domain}:state`);
    const previousIPs = await env.DNS_KV.get(`dns:${domain}:ips`);
    const previousSerial = await env.DNS_KV.get(`dns:${domain}:serial`);
    const previousIPsArray = previousIPs ? previousIPs.split(",") : [];
    const currentIPs = aRecords.map((record) => record.data);

    // Sort arrays for consistent comparison
    previousIPsArray.sort();
    currentIPs.sort();

    // If the IPs have changed
    if (JSON.stringify(previousIPsArray) !== JSON.stringify(currentIPs)) {
      // Hosts like Vercel rotate IPs within known pools; if every current
      // IP is inside the domain's allowed ranges, update state silently
      const allowedRanges = allowedRangesFor(domain, env);
      if (
        allowedRanges.length > 0 &&
        currentIPs.length > 0 &&
        currentIPs.every((ip) =>
          allowedRanges.some((cidr) => ipInCidr(ip, cidr))
        )
      ) {
        await env.DNS_KV.put(`dns:${domain}:state`, "resolved");
        await env.DNS_KV.put(`dns:${domain}:ips`, currentIPs.join(","));
        await env.DNS_KV.put(`dns:${domain}:serial`, serial);
        console.log(
          `IP rotation within allowed ranges for ${domain}: ` +
            `${previousIPs || "none"} -> ${currentIPs.join(", ")} ` +
            `(allowed: ${allowedRanges.join(", ")})`
        );
        return true;
      }

      const message =
        `🚨 <b>DNS Change Detected</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Previous IPs: <code>${previousIPs || "none"}</code>\n` +
        `New IPs: <code>${currentIPs.join(", ")}</code>\n` +
        `TTL: <code>${aRecords[0]?.TTL || "N/A"}</code>\n` +
        `Time: ${new Date().toISOString()}\n\n` +
        `<b>Technical Details:</b>\n` +
        `- DNS Status: <code>${dnsData.Status}</code>\n` +
        `- Record Type: <code>A</code>\n` +
        `- Number of Records: <code>${aRecords.length}</code>\n` +
        `- SOA Serial: <code>${serial}</code>\n` +
        `- Primary NS: <code>${soaData[0] || "unknown"}</code>\n` +
        `- Admin Email: <code>${soaData[1] || "unknown"}</code>`;

      // Send the alert before committing state to KV so a failed send
      // retries on the next run instead of being lost
      await sendTelegramMessage(env, message);
      await env.DNS_KV.put(`dns:${domain}:state`, "resolved");
      await env.DNS_KV.put(`dns:${domain}:ips`, currentIPs.join(","));
      await env.DNS_KV.put(`dns:${domain}:serial`, serial);

      console.log(`DNS change detected for ${domain}:`);
      console.log(`Previous IPs: ${previousIPs || "none"}`);
      console.log(`New IPs: ${currentIPs.join(", ")}`);
      console.log(`SOA Serial: ${serial}`);
      console.log(`Timestamp: ${new Date().toISOString()}`);
    } else if (serial !== previousSerial) {
      // Only notify on SOA changes if IPs haven't changed
      // This catches cases where other record types changed
      const message =
        `📝 <b>DNS Zone Updated</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Previous Serial: <code>${previousSerial || "unknown"}</code>\n` +
        `New Serial: <code>${serial}</code>\n` +
        `Time: ${new Date().toISOString()}\n\n` +
        `<b>Technical Details:</b>\n` +
        `- DNS Status: <code>${dnsData.Status}</code>\n` +
        `- Record Type: <code>SOA</code>\n` +
        `- Primary NS: <code>${soaData[0] || "unknown"}</code>\n` +
        `- Admin Email: <code>${soaData[1] || "unknown"}</code>\n` +
        `- Refresh: <code>${soaData[3] || "unknown"}</code>\n` +
        `- Retry: <code>${soaData[4] || "unknown"}</code>\n` +
        `- Expire: <code>${soaData[5] || "unknown"}</code>\n` +
        `- Min TTL: <code>${soaData[6] || "unknown"}</code>`;

      // Send the alert before committing state to KV so a failed send
      // retries on the next run instead of being lost
      await sendTelegramMessage(env, message);
      await env.DNS_KV.put(`dns:${domain}:serial`, serial);

      console.log(`SOA record updated for ${domain}:`);
      console.log(`Previous Serial: ${previousSerial || "unknown"}`);
      console.log(`New Serial: ${serial}`);
    } else {
      console.log(
        `No change detected for ${domain} (IPs: ${currentIPs.join(", ")})`
      );
    }
    return true;
  } catch (error: unknown) {
    // Log first: if the worker dies on an unhandled exception, none of the
    // invocation's logs are persisted, leaving no trace of the failure
    console.error(`Error monitoring DNS for ${domain}:`, error);

    const errorMessage =
      `❌ <b>Error Monitoring DNS</b>\n\n` +
      `Domain: <code>${domain}</code>\n` +
      `Error: <code>${
        error instanceof Error ? error.message : String(error)
      }</code>\n\n` +
      `<b>Technical Details:</b>\n` +
      `- Time: <code>${new Date().toISOString()}</code>\n` +
      `- Worker: <code>dns-bot</code>\n` +
      `- Domain: <code>${domain}</code>`;

    try {
      await sendTelegramMessage(env, errorMessage);
    } catch (telegramError: unknown) {
      // Don't rethrow: a failed Telegram send would crash the run and skip
      // the remaining domains
      console.error(
        `Failed to send error alert for ${domain}:`,
        telegramError
      );
    }
    return false;
  }
}

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    if (!env.MONITOR_DOMAINS) {
      console.error("MONITOR_DOMAINS environment variable is not set");
      return;
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      console.error(
        "Telegram configuration is missing. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"
      );
      return;
    }

    // Split the domains string into an array and trim whitespace
    const domains = env.MONITOR_DOMAINS.split(",").map((domain) =>
      domain.trim()
    );

    // Check each domain
    let allOk = true;
    for (const domain of domains) {
      const ok = await checkDomain(domain, env);
      allOk = allOk && ok;
    }

    // Only ping the heartbeat after a fully clean run: a missed beat tells
    // Uptime Kuma the bot is broken, whether it stopped running or failed
    // a check or alert
    if (env.HEARTBEAT_URL && allOk) {
      try {
        const response = await fetch(env.HEARTBEAT_URL);
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        console.log("Heartbeat sent");
      } catch (error: unknown) {
        console.error("Failed to send heartbeat:", error);
      }
    }
  },

  // Add fetch handler for HTTP requests
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return new Response(
      "DNS Monitor Worker is running. This worker is triggered by cron.",
      {
        headers: { "Content-Type": "text/plain" },
      }
    );
  },
};
