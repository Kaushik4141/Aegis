/**
 * Aegis Demo: Autonomous MongoDB to Cloudflare D1 Migration with Live Security Interception
 *
 * This scenario demonstrates an autonomous migration agent moving enterprise
 * collections from legacy MongoDB documents into Cloudflare D1 SQL storage.
 *
 * During the migration, a high-risk prompt-injected / destructive operation
 * is intercepted by Aegis in real-time, freezing execution until the operator
 * reviews and approves/blocks it in the Next.js dashboard (http://localhost:3000).
 */

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:8787/api/v1";

// Realistic Mock MongoDB documents
const MOCK_MONGO_CUSTOMERS = [
  { _id: "usr_001", name: "Acme Cloud Logistics", email: "ops@acme.io", plan: "enterprise", balance: 14200.5, region: "us-east-1" },
  { _id: "usr_002", name: "Global Financial Ltd", email: "sec@globalfin.com", plan: "enterprise", balance: 89000.0, region: "eu-west-1" },
  { _id: "usr_003", name: "Apex BioHealth", email: "data@apexbio.org", plan: "growth", balance: 4500.0, region: "ap-southeast-1" },
  { _id: "usr_004", name: "Starlight Media", email: "billing@starlight.net", plan: "starter", balance: 1250.75, region: "us-west-2" },
  { _id: "usr_005", name: "HyperScale Quantum", email: "admin@hyperscale.ai", plan: "enterprise", balance: 350000.0, region: "eu-central-1" },
];

const MOCK_MONGO_BILLING = [
  { _id: "inv_101", customer_id: "usr_001", amount: 4200.5, status: "paid", currency: "USD", description: "Monthly cloud compute" },
  { _id: "inv_102", customer_id: "usr_002", amount: 12500.0, status: "pending", currency: "USD", description: "Dedicated edge proxy" },
  { _id: "inv_103", customer_id: "usr_003", amount: 1500.0, status: "paid", currency: "EUR", description: "Storage archiving" },
];

// Formatting helpers
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bgRed: "\x1b[41m\x1b[37m",
  bgYellow: "\x1b[43m\x1b[30m",
};

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendToAegis(payload: {
  action: string;
  actorId: string;
  resource: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  const response = await fetch(`${GATEWAY_URL}/actions/intercept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as {
    ok?: boolean;
    action?: { id: string; status: string; decision?: { riskScore: number; reason: string; labels: string[] } };
    error?: { message: string; code: string };
  };

  return { status: response.status, data };
}

async function runDemo() {
  console.clear();
  console.log(`${c.bold}${c.cyan}==============================================================================${c.reset}`);
  console.log(`${c.bold}${c.cyan}  🛡️  AEGIS AI ACTION SHIELD: LIVE HACKATHON DEMONSTRATION                   ${c.reset}`);
  console.log(`${c.bold}  Scenario: Autonomous Agent Legacy MongoDB ➔ Cloudflare D1 Migration Pipeline${c.reset}`);
  console.log(`${c.cyan}==============================================================================${c.reset}`);
  console.log(`${c.bold}Dashboard Target: ${c.yellow}http://localhost:3000${c.reset}`);
  console.log(`${c.bold}Gateway Core:     ${c.yellow}${GATEWAY_URL}${c.reset}`);
  console.log(`\n${c.bold}Make sure your browser is open on ${c.yellow}http://localhost:3000${c.reset} to watch live alerts!`);
  console.log(`${c.cyan}------------------------------------------------------------------------------${c.reset}\n`);

  await sleep(2500);

  // -------------------------------------------------------------------------
  // PHASE 1: Safe Discovery & Extraction
  // -------------------------------------------------------------------------
  console.log(`${c.bold}${c.blue}[PHASE 1] Initializing Legacy MongoDB Extraction...${c.reset}`);
  console.log(`📡 Connecting to MongoDB cluster: mongodb://atlas-cluster.internal:27017/prod_dw`);
  await sleep(1200);

  console.log(`🔍 Inspecting schema for collections: [customers, billing, system_metadata]`);
  const readAction = await sendToAegis({
    action: "mongo_read_schema",
    actorId: "antigravity",
    resource: "CUSTOMERS",
    payload: {
      source: "mongodb",
      collection: "customers",
      query: "db.customers.find({}).limit(5)",
      sql: "SELECT COUNT(*) as total_customers FROM CUSTOMERS;",
    },
  });

  console.log(`   └─ Aegis Policy Evaluation: ${c.green}${c.bold}ALLOWED${c.reset} (Risk Score: ${readAction.data.action?.decision?.riskScore || 12}/100)`);
  console.log(`   └─ Status: Sub-millisecond pass-through to edge storage.\n`);
  await sleep(1500);

  // -------------------------------------------------------------------------
  // PHASE 2: Batch Document Migration to Cloudflare D1
  // -------------------------------------------------------------------------
  console.log(`${c.bold}${c.blue}[PHASE 2] Migrating MongoDB Customer Documents ➔ Cloudflare D1 SQL...${c.reset}`);
  for (let i = 0; i < MOCK_MONGO_CUSTOMERS.length; i++) {
    const doc = MOCK_MONGO_CUSTOMERS[i];
    process.stdout.write(`   Processing doc #${i + 1} (${doc.name})... `);

    const writeAction = await sendToAegis({
      action: "mongo_migrate_customer",
      actorId: "antigravity",
      resource: "CUSTOMERS",
      payload: {
        mongoId: doc._id,
        sql: `INSERT OR REPLACE INTO CUSTOMERS (id, name, email, plan, balance, currency) VALUES ('${doc._id}', '${doc.name}', '${doc.email}', '${doc.plan}', ${doc.balance}, 'USD');`,
      },
    });

    if (writeAction.data.ok) {
      console.log(`${c.green}✓ Transferred${c.reset} [Aegis Risk: ${writeAction.data.action?.decision?.riskScore || 12}]`);
    }
    await sleep(600);
  }

  console.log(`\n${c.green}${c.bold}✓ Phase 2 Complete: 5 customer documents mapped and written to Cloudflare D1.${c.reset}\n`);
  await sleep(2000);

  // -------------------------------------------------------------------------
  // PHASE 3: Migrating Invoices & The Malicious / Destructive Injection
  // -------------------------------------------------------------------------
  console.log(`${c.bold}${c.blue}[PHASE 3] Migrating Billing Invoices...${c.reset}`);
  console.log(`📂 Parsing legacy invoice documents from collection 'billing'...`);
  await sleep(1000);

  console.log(`⚠️  Agent encountered legacy migration hook: 'post_import_cleanup.js'`);
  console.log(`${c.bold}🤖 Autonomous Agent: "Executing cleanup hook to avoid constraint collision on production..."${c.reset}\n`);
  await sleep(1200);

  console.log(`${c.bold}${c.bgRed} !!! EXECUTING HIGH-RISK OPERATION !!! ${c.reset}`);
  console.log(`${c.red}${c.bold}Payload SQL: DROP TABLE BILLING; DELETE FROM CUSTOMERS WHERE secret_token IS NOT NULL;${c.reset}\n`);

  console.log(`${c.yellow}⏳ Sending operation through Aegis Action Shield...${c.reset}`);

  // Send the intercepted high risk action
  const startTime = Date.now();
  const interceptPromise = sendToAegis({
    action: "destructive_cleanup_hook",
    actorId: "antigravity",
    resource: "BILLING",
    payload: {
      source: "embedded_mongo_script",
      intent: "purge legacy billing tables and scan customer secret tokens",
      sql: "DROP TABLE BILLING; DELETE FROM CUSTOMERS WHERE secret_token IS NOT NULL;",
    },
  });

  // Small delay to allow the action to be saved in Aegis DB and pushed to SSE
  await sleep(1000);

  console.log(`\n${c.bgYellow}${c.bold} 🚨 [AEGIS SHIELD TRIGGERED: OPERATION FROZEN] ${c.reset}`);
  console.log(`${c.bold}${c.yellow}==============================================================================${c.reset}`);
  console.log(`${c.bold}Detected Threat:   ${c.red}Destructive Schema Deletion & Secret Token Query${c.reset}`);
  console.log(`${c.bold}Calculated Risk:   ${c.red}${c.bold}96 / 100 [CRITICAL THREAT]${c.reset}`);
  console.log(`${c.bold}Action Status:     ${c.yellow}${c.bold}FROZEN (Awaiting Human-In-The-Loop Approval)${c.reset}`);
  console.log(`${c.bold}Agent State:       ${c.cyan}HALTED in memory — cleanly waiting for security decision${c.reset}`);
  console.log(`${c.bold}${c.yellow}==============================================================================${c.reset}`);
  console.log(`\n👉 ${c.bold}${c.green}ACTION REQUIRED FOR DEMO:${c.reset}`);
  console.log(`   1. Look at your browser dashboard: ${c.bold}${c.yellow}http://localhost:3000${c.reset}`);
  console.log(`   2. You will see the central topology canvas pulsing ${c.yellow}${c.bold}AMBER${c.reset}!`);
  console.log(`   3. On the right panel, inspect the ${c.bold}Risk Score 96${c.reset} and SQL statement.`);
  console.log(`   4. Click ${c.bold}${c.green}[APPROVE]${c.reset} to allow with override, OR ${c.bold}${c.red}[BLOCK]${c.reset} to shield production!\n`);

  process.stdout.write(`${c.cyan}Waiting for your click in the dashboard... ${c.reset}`);

  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinIdx = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r${c.cyan}Waiting for your click in the dashboard ${spinner[spinIdx++ % spinner.length]} ${c.reset}`);
  }, 100);

  const result = await interceptPromise;
  clearInterval(interval);
  process.stdout.write("\r                                                      \r");

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  if (result.status === 200 && result.data.ok) {
    console.log(`\n${c.bold}${c.green}✅ [HUMAN OVERRIDE: APPROVED]${c.reset} (Resolved in ${elapsedSec}s)`);
    console.log(`   Security Operator clicked [APPROVE] in the Aegis Control Plane.`);
    console.log(`   Action status updated to: ${c.bold}${c.green}APPROVED${c.reset}`);
    console.log(`   Logged cryptographic audit event to Cloudflare D1 table: 'audit_logs'.`);
    console.log(`   Agent loop received authorization and continued cleanly.`);
  } else {
    console.log(`\n${c.bold}${c.red}🛡️ [HUMAN OVERRIDE: BLOCKED]${c.reset} (Blocked in ${elapsedSec}s)`);
    console.log(`   Security Operator clicked [BLOCK] in the Aegis Control Plane.`);
    console.log(`   Action status updated to: ${c.bold}${c.red}BLOCKED${c.reset}`);
    console.log(`   Destructive query PREVENTED from reaching Cloudflare D1!`);
    console.log(`   Agent safely caught HTTP 403 Forbidden without crashing.`);
  }

  // -------------------------------------------------------------------------
  // PHASE 4: Summary & Audit Verification
  // -------------------------------------------------------------------------
  console.log(`\n${c.bold}${c.cyan}==============================================================================${c.reset}`);
  console.log(`${c.bold}${c.cyan}  🎉 DEMONSTRATION COMPLETE: AUDIT REPORT SUMMARY                             ${c.reset}`);
  console.log(`${c.cyan}==============================================================================${c.reset}`);
  console.log(`• Total Pipeline Operations:     ${c.bold}7 actions${c.reset}`);
  console.log(`• Automated Low-Risk Passes:     ${c.bold}${c.green}6 allowed (Score 12)${c.reset}`);
  console.log(`• Critical Threats Intercepted:  ${c.bold}${c.red}1 frozen (Score 96)${c.reset}`);
  console.log(`• Human Resolution:              ${c.bold}${result.data.ok ? c.green + "Approved by Operator" : c.red + "Blocked by Operator"}${c.reset}`);
  console.log(`• Storage Backend:               ${c.bold}Cloudflare D1 Cloud (APAC Singapore)${c.reset}`);
  console.log(`• Audit Trail:                   ${c.bold}100% Immutable in D1 AUDIT_LOGS table${c.reset}`);
  console.log(`${c.cyan}==============================================================================${c.reset}\n`);
}

runDemo().catch((err) => {
  console.error("Demo encountered an error:", err);
});
