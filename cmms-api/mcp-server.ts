// MCP server that wraps the cmms-api REST endpoints into proper MCP tools.
//
// Two transport modes are supported, selected by MCP_TRANSPORT env var:
//   stdio (default)       - stdin/stdout, for local clients (e.g. Kilo)
//   http                  - Streamable HTTP on MCP_PORT (default 8788),
//                          for remote clients behind a tunnel
//
// Env vars (loaded from .env by Bun):
//   CMMS_API_URL          - base URL of the REST API (default http://127.0.0.1:8787)
//   CMMS_API_TOKEN_READ   - bearer token for read endpoints (required)
//   CMMS_API_TOKEN_WRITE  - bearer token for write endpoints (optional)
//   MCP_TRANSPORT         - "stdio" (default) or "http"
//   MCP_PORT              - HTTP port when MCP_TRANSPORT=http (default 8788)
//   MCP_HOST              - HTTP host when MCP_TRANSPORT=http (default 127.0.0.1)
//   MCP_BEARER_TOKEN      - if set, HTTP transport requires this bearer token
//                            in the Authorization header (recommended for tunnel)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// --- Config from environment ---

const BASE = process.env.CMMS_API_URL ?? "http://127.0.0.1:8787";
const READ_TOKEN = process.env.CMMS_API_TOKEN_READ ?? "";
const WRITE_TOKEN = process.env.CMMS_API_TOKEN_WRITE ?? "";
const TRANSPORT = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
const HTTP_PORT = Number(process.env.MCP_PORT ?? 8788);
const HTTP_HOST = process.env.MCP_HOST ?? "127.0.0.1";
const HTTP_BEARER = process.env.MCP_BEARER_TOKEN ?? "";

if (!READ_TOKEN) {
  console.error(
    "CMMS_API_TOKEN_READ is not set. The MCP server needs a read token to talk to cmms-api.",
  );
}

// --- HTTP helper ---

type FetchOpts = { method?: string; body?: unknown; token?: string };

async function call<T = any>(path: string, opts: FetchOpts = {}): Promise<T> {
  const token = opts.token ?? READ_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

// --- MCP Server factory (one McpServer instance per session) ---

function createServer(): McpServer {
  const s = new McpServer({
    name: "cmms-api",
    version: "0.1.0",
  });
  registerTools(s);
  return s;
}

function registerTools(server: McpServer) {

// 1. search_existing_tickets — read-only lookup, duplicate detection
server.registerTool(
  "search_existing_tickets",
  {
    title: "Search Existing Tickets",
    description: [
      "Search for existing maintenance tickets by free text or filters.",
      "",
      "WHEN TO USE:",
      "- Detect duplicates before creating a new ticket",
      "- Find a specific ticket by customer name, device, or keyword",
      "- Check if a customer already has an open ticket",
      "- Look up details of past work on a specific device or issue",
      "- Search within note text (use notes_contains for targeted note search)",
      "- Filter by issue category (kategoria) or severity (sulyossag)",
      "",
      "DO NOT USE for counting, ranking, aggregation, analytics,",
      "or questions like 'which client has the most tickets?',",
      "'which device breaks most?', 'how many tickets per month?'.",
      "For those, use get_ticket_stats instead.",
      "",
      "IMPORTANT: Use the 'device' parameter (not 'q') to filter by device type/model.",
      "The 'device' parameter matches against device raw text and model field.",
      "The 'q' parameter searches the entire ticket (customer, devices, notes, etc.).",
      "",
      "Available filters: q, customer, device, status, date_from, date_to,",
      "notes_contains (searches within note body text),",
      "kategoria (issue category), sulyossag (severity level).",
      "",
      "Use fields to reduce response size dramatically, e.g.:",
      '  fields=["sorszam", "status", "customer.name", "problem_kategoria"]',
    ].join("\n"),
    inputSchema: {
      q: z
        .string()
        .optional()
        .describe("Free text search (AND-of-tokens, diacritic-folded, case-insensitive)"),
      customer: z.string().optional().describe("Substring match on customer name"),
      device: z.string().optional().describe("Substring match on device raw or model"),
      status: z.enum(["open", "closed"]).optional().describe("Filter by job status"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound on reported_at_iso"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound on reported_at_iso"),
      notes_contains: z.string().optional().describe("Substring match on note text body (diacritic-folded)"),
      kategoria: z.string().optional().describe("Substring match on issue category (problem_kategoria)"),
      sulyossag: z.string().optional().describe("Exact match on severity (alacsony/kozepes/magas/kritikus)"),
      controller: z.string().optional().describe("Substring match on device controller (vezerlo)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results per page (default 20, max 100)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
      fields: z.array(z.string()).optional().describe("Limit returned fields per job to reduce response size"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/jobs/search", { method: "POST", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 2. create_ticket — create a complete ticket from validated fields
server.registerTool(
  "create_ticket",
  {
    title: "Create Ticket",
    description: [
      "Create a maintenance ticket with all known fields at once.",
      "",
      "Only customer_name is required. Fill the rest from the conversation",
      "with the worker. Do NOT call this until you have gathered the",
      "information the worker can provide.",
      "",
      "The model owns the conversation flow. This tool is a dumb create.",
      "Returns the full JobCard with key and sorszam.",
      "",
      "Categorization fields help fast aggregation:",
      "- problem_kategoria: primary issue category",
      "- sulyossag: severity level (alacsony/kozepes/magas/kritikus)",
    ].join("\n"),
    inputSchema: {
      customer_name: z.string().describe("Customer or site name (required)"),
      customer_zip: z.string().optional().describe("Postal code"),
      customer_address: z.string().optional().describe("Address"),
      customer_phone: z.string().optional().describe("Phone number"),
      customer_email: z.string().optional().describe("Email address"),
      devices: z.array(z.string()).optional().describe("Device identifiers (one per device, e.g. 'NCT2000', 'TMV-400(10297)')"),
      reported: z.string().optional().describe("Problem description / BEJELENTETT HIBA"),
      work: z.string().optional().describe("Completed work / ELVÉGZETT MUNKA"),
      technician: z.string().optional().describe("Assigned technician / DOLGOZÓ"),
      reporter: z.string().optional().describe("Who reported the fault / BEJELENTŐ"),
      fault_receiver: z.string().optional().describe("Who received the report / HIBAFELVEVŐ"),
      payment: z.enum(["fiz", "gar"]).optional().describe("Payment status: fiz=paid, gar=warranty"),
      remote_access: z.string().optional().describe("Remote access info / TÁVOLIGÉPELÉRÉS"),
      status: z.enum(["open", "closed"]).optional().describe("Initial status (default open)"),
      problem_kategoria: z.string().optional().describe("Issue category (e.g. 'Szoftver hiba', 'Hardver hiba', 'Mechanikai hiba')"),
      problem_alkategoria: z.string().optional().describe("Issue subcategory for more granular classification"),
      sulyossag: z.enum(["alacsony", "kozepes", "magas", "kritikus"]).optional().describe("Severity level"),
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call("/v1/tickets/create", { method: "POST", token: WRITE_TOKEN, body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 3. modify_ticket — update fields on an existing ticket
server.registerTool(
  "modify_ticket",
  {
    title: "Modify Ticket",
    description: [
      "Update one or more fields on an existing ticket by sorszam.",
      "Use this to correct typos or fill in details the user missed.",
      "Only the fields you provide are changed — omitted fields stay as-is.",
      "Returns the updated JobCard.",
      "",
      "Can update categorization fields:",
      "- problem_kategoria: primary issue category",
      "- problem_alkategoria: subcategory",
      "- sulyossag: severity (alacsony/kozepes/magas/kritikus)",
    ].join("\n"),
    inputSchema: {
      sorszam: z.string().describe("Ticket sorszam (e.g. B26072216)"),
      customer_name: z.string().optional().describe("Corrected customer or site name"),
      customer_zip: z.string().optional().describe("Corrected postal code"),
      customer_address: z.string().optional().describe("Corrected address"),
      customer_phone: z.string().optional().describe("Corrected phone number"),
      customer_email: z.string().optional().describe("Corrected email address"),
      devices: z.array(z.string()).optional().describe("Corrected device list (replaces existing)"),
      reported: z.string().optional().describe("Append a note to the problem description"),
      work: z.string().optional().describe("Append a note to the completed work"),
      technician: z.string().optional().describe("Corrected technician assignment"),
      reporter: z.string().optional().describe("Corrected reporter name"),
      fault_receiver: z.string().optional().describe("Corrected fault receiver"),
      payment: z.enum(["fiz", "gar"]).optional().describe("Corrected payment status"),
      remote_access: z.string().optional().describe("Corrected remote access info"),
      status: z.enum(["open", "closed"]).optional().describe("Corrected status"),
      problem_kategoria: z.string().optional().describe("Corrected issue category (e.g. 'Szoftver hiba', 'Hardver hiba')"),
      problem_alkategoria: z.string().optional().describe("Corrected subcategory"),
      sulyossag: z.enum(["alacsony", "kozepes", "magas", "kritikus"]).optional().describe("Corrected severity level"),
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call("/v1/tickets/modify", { method: "POST", token: WRITE_TOKEN, body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 4. remove_ticket — PERMANENTLY DELETE a ticket (DANGEROUS)
server.registerTool(
  "remove_ticket",
  {
    title: "Remove Ticket",
    description: "PERMANENTLY AND IRREVERSIBLY DELETES a ticket. This cannot be undone. Prefer close_ticket instead.",
    inputSchema: {
      key: z.number().int().describe("Integer job KEY of the ticket to permanently delete"),
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call(`/v1/tickets/${args.key}`, { method: "DELETE", token: WRITE_TOKEN });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 5. get_ticket_stats — aggregate tickets by dimension for analytics
server.registerTool(
  "get_ticket_stats",
  {
    title: "Get Ticket Stats",
    description: [
      "ALWAYS USE THIS TOOL for any counting, ranking, aggregation,",
      "analytics, or statistical question. This tool returns pre-counted",
      "and sorted results — do NOT try to count or rank manually.",
      "",
      "USE FOR questions like:",
      "- 'Which client has the most tickets?' → group_by: customer",
      "- 'Which device/model needs the most repairs?' → group_by: device",
      "- 'Which technician handles the most tickets?' → group_by: technician",
      "- 'How many tickets are open vs closed?' → group_by: status",
      "- 'Ticket volume by month?' → group_by: month",
      "- 'Most common issue category?' → group_by: kategoria",
      "- 'How many critical severity tickets?' → group_by: sulyossag",
      "- 'Which machine type breaks most?' → group_by: machine_type",
      "- 'Which controller has most issues?' → group_by: controller",
      "- 'Most common issue for a customer?' → group_by: device + customer filter",
      "- Any question with 'most', 'least', 'how many', 'which ... has the most'",
      "",
      "NEVER use search_existing_tickets for counting — that tool returns",
      "raw ticket objects and does NOT aggregate. Use this tool instead.",
      "",
      "Optional filters narrow the dataset before aggregation.",
      "Returns sorted [{ name, count }] descending by count.",
    ].join("\n"),
    inputSchema: {
      group_by: z.enum(["customer", "device", "technician", "status", "month", "kategoria", "sulyossag", "machine_type", "controller"]).describe("Dimension to aggregate by"),
      q: z.string().optional().describe("Free text filter (AND-of-tokens, diacritic-folded)"),
      customer: z.string().optional().describe("Substring filter on customer name"),
      device: z.string().optional().describe("Substring filter on device raw or model"),
      status: z.enum(["open", "closed"]).optional().describe("Filter by job status"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound on reported_at_iso"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound on reported_at_iso"),
      kategoria: z.string().optional().describe("Substring filter on issue category"),
      sulyossag: z.string().optional().describe("Filter by severity level"),
      controller: z.string().optional().describe("Substring filter on device controller (vezerlo)"),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 50, max 500)"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/jobs/stats", { method: "POST", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 6. close_ticket — mark a ticket as resolved with solution
server.registerTool(
  "close_ticket",
  {
    title: "Close Ticket",
    description: [
      "Close a maintenance ticket by its integer key.",
      "Optionally provide the solution text — it will be recorded in ELVÉGZETT MUNKA.",
      "Returns the updated JobCard with status 'closed'.",
    ].join("\n"),
    inputSchema: {
      key: z.number().int().describe("Integer job KEY to close"),
      text: z.string().optional().describe("Solution description — what was done to fix the issue"),
      author: z.string().optional().describe("Who performed the fix (optional)"),
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const body: Record<string, unknown> = {};
      if (args.text) body.text = args.text;
      if (args.author) body.author = args.author;
      const data = await call(`/v1/tickets/${args.key}/close`, { method: "POST", token: WRITE_TOKEN, body });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 7. get_categories — list all available issue categories
server.registerTool(
  "get_categories",
  {
    title: "Get Categories",
    description: [
      "List all available issue categories for classifying tickets.",
      "Use this when you need to know what categories exist,",
      "or before assigning a category to a ticket.",
      "Returns [{ id, nev, nev_ascii, leiras }].",
    ].join("\n"),
    inputSchema: {},
  },
  async (_args) => {
    try {
      const data = await call("/v1/categories");
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 8. get_tags — list all tags
server.registerTool(
  "get_tags",
  {
    title: "Get Tags",
    description: [
      "List all available tags that can be attached to tickets.",
      "Tags are flexible labels for fine-grained classification.",
      "Returns [{ id, nev }].",
    ].join("\n"),
    inputSchema: {},
  },
  async (_args) => {
    try {
      const data = await call("/v1/tags");
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 9. add_ticket_tag — add a tag to a ticket
server.registerTool(
  "add_ticket_tag",
  {
    title: "Add Ticket Tag",
    description: [
      "Add a tag to a ticket by its integer key.",
      "The tag is created automatically if it doesn't exist.",
      "Returns the updated tag list for the ticket.",
    ].join("\n"),
    inputSchema: {
      key: z.number().int().describe("Integer job KEY"),
      nev: z.string().describe("Tag name (created if new)"),
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call(`/v1/tickets/${args.key}/tags`, {
        method: "POST",
        token: WRITE_TOKEN,
        body: { nev: args.nev },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 10. set_ticket_category — set the primary category on a ticket
server.registerTool(
  "set_ticket_category",
  {
    title: "Set Ticket Category",
    description: [
      "Set the primary issue category on a ticket.",
      "Use modify_ticket to also update severity and subcategory.",
      "Use get_categories to see available category names.",
      "Returns the updated JobCard.",
    ].join("\n"),
    inputSchema: {
      sorszam: z.string().describe("Ticket sorszam (e.g. B26072216)"),
      problem_kategoria: z.string().describe("Category name (e.g. 'Szoftver hiba')"),
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call("/v1/tickets/modify", {
        method: "POST",
        token: WRITE_TOKEN,
        body: { sorszam: args.sorszam, problem_kategoria: args.problem_kategoria },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 11. set_ticket_severity — set severity on a ticket
server.registerTool(
  "set_ticket_severity",
  {
    title: "Set Ticket Severity",
    description: [
      "Set the severity level on a ticket.",
      "Use modify_ticket to also update category and other fields.",
      "Returns the updated JobCard.",
    ].join("\n"),
    inputSchema: {
      sorszam: z.string().describe("Ticket sorszam (e.g. B26072216)"),
      sulyossag: z.enum(["alacsony", "kozepes", "magas", "kritikus"]).describe("Severity level"),
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call("/v1/tickets/modify", {
        method: "POST",
        token: WRITE_TOKEN,
        body: { sorszam: args.sorszam, sulyossag: args.sulyossag },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 12. search_by_category — fast category-based search
server.registerTool(
  "search_by_category",
  {
    title: "Search by Category",
    description: [
      "Fast search for tickets by issue category and optional filters.",
      "Much faster than free-text search for category-based queries.",
      "",
      "USE FOR questions like:",
      "- 'Show me all software issues' → kategoria: 'Szoftver hiba'",
      "- 'How many hardware failures for TMV-400?' → kategoria + device",
      "- 'Which customers have most network issues?' → use get_ticket_stats",
      "  with group_by: customer + kategoria filter instead",
      "",
      "Returns ticket objects matching the category filter.",
    ].join("\n"),
    inputSchema: {
      kategoria: z.string().describe("Issue category to search for (e.g. 'Szoftver hiba')"),
      status: z.enum(["open", "closed"]).optional().describe("Filter by job status"),
      device: z.string().optional().describe("Substring filter on device"),
      customer: z.string().optional().describe("Substring filter on customer"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      fields: z.array(z.string()).optional().describe("Limit returned fields"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/jobs/search", {
        method: "POST",
        body: { ...args, q: undefined },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 13. find_recurring_problems — find clusters of tickets that share a root-cause signature
server.registerTool(
  "find_recurring_problems",
  {
    title: "Find Recurring Problems",
    description: [
      "Find RECURRING PROBLEMS — groups of 2+ tickets sharing the same root-cause signature.",
      "",
      "USE THIS for questions like:",
      "- 'Which job did we have to go out to most?'",
      "- 'What problem kept coming back?'",
      "- 'Which issue recurred the most this year?'",
      "- 'Did we ever fix that TMV-400 issue at MAGYARMET?'",
      "",
      "DO NOT USE for raw ticket counts (use get_ticket_stats with group_by: customer).",
      "A cluster is identified by a signature tuple of (customer?, machine?, controller?,",
      "software?, hardware?, kategoria?, alkategoria?). The 'scope' parameter controls",
      "how strict the grouping is:",
      "- 'narrow': all 7 fields must match across tickets",
      "- 'broad' (default): only machine, controller, kategoria must match",
      "- 'broadest': only controller and kategoria must match",
      "",
      "Choose scope based on the user's wording:",
      "- 'this machine' / 'this controller' / 'this customer' → narrow",
      "- 'this model' / 'this type' / 'any' → broad",
      "- 'across all' / 'anywhere' → broadest",
      "",
      "Each cluster returned has a 'handoffs' array that shows technician transitions",
      "(e.g. when tech A tried but tech B later fixed it). The 'last_seen' date tells",
      "you whether the problem is still ongoing.",
    ].join("\n"),
    inputSchema: {
      customer: z.string().optional().describe("Filter to a specific customer (narrow scope)"),
      machine: z.string().optional().describe("Filter to a specific machine type (e.g. 'TMV-400')"),
      controller: z.string().optional().describe("Filter to a specific controller (e.g. 'NCT104')"),
      software: z.string().optional().describe("Filter to a specific software version (e.g. 'SW-1.039')"),
      hardware: z.string().optional().describe("Filter to a specific hardware variant (e.g. 'HW:int')"),
      kategoria: z.string().optional().describe("Filter to a specific problem category (e.g. 'Vezérlő hiba')"),
      alkategoria: z.string().optional().describe("Filter to a specific subcategory"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound on reported_at_iso"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound on reported_at_iso"),
      scope: z.enum(["narrow", "broad", "broadest"]).optional().describe("Signature strictness (default 'broad')"),
      min_visits: z.number().int().min(2).optional().describe("Minimum visits per cluster (default 2)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max clusters to return (default 20)"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/jobs/recurring-problems", { method: "POST", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 14. get_problem_cluster — fetch full ticket list for one recurring problem
server.registerTool(
  "get_problem_cluster",
  {
    title: "Get Problem Cluster",
    description: [
      "Get the full ordered ticket list for a single recurring-problem cluster.",
      "",
      "USE THIS after find_recurring_problems when the LLM wants to drill into",
      "one specific cluster (e.g. to see the full timeline of visits, the complete",
      "technician handoff history, or to check whether the issue was finally resolved).",
      "",
      "Returns the cluster summary (visit_count, technicians, first_seen, last_seen,",
      "handoffs[]) plus the full ordered ticket list.",
    ].join("\n"),
    inputSchema: {
      customer: z.string().optional().describe("Customer name (narrow scope)"),
      machine: z.string().optional().describe("Machine type (e.g. 'TMV-400')"),
      controller: z.string().optional().describe("Controller (e.g. 'NCT104')"),
      software: z.string().optional().describe("Software version"),
      hardware: z.string().optional().describe("Hardware variant"),
      kategoria: z.string().optional().describe("Problem category"),
      alkategoria: z.string().optional().describe("Problem subcategory"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound"),
      scope: z.enum(["narrow", "broad", "broadest"]).optional().describe("Signature strictness (default 'broad')"),
      limit: z.number().int().min(1).max(500).optional().describe("Max tickets to return (default 50)"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/jobs/recurring-problems/cluster", { method: "POST", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// --- Integrated CMMS data (CSV imports) ---
//
// The integration covers 19 Hungarian Excel CSV exports loaded into the
// cmms_specialized.db: serviz_belso, szev_igeny, telephely_munka,
// telephely_ais_motor, nem_javitjuk, statisztika. Each table has a
// corresponding FTS5 virtual table for fast free-text search.

// 13. search_serviz_belso — search the internal service-ticket archive
// (Szervizlap belső 2008-2020 + 2020- + 2020-taksony).
server.registerTool(
  "search_serviz_belso",
  {
    title: "Search Internal Service Tickets (Szervizlap belső)",
    description: [
      "Search the internal workshop service-ticket archive (2008-now).",
      "",
      "This is SEPARATE from search_existing_tickets (which searches the",
      "main /v1/data CMMS table). This tool searches the integrated CSV",
      "exports of the internal szervizlap system.",
      "",
      "WHEN TO USE:",
      "- 'Did we see this kind of failure internally before?'",
      "- 'What faults did we log for a customer in 2018?'",
      "- 'Show internal service tickets on TMV-400'",
      "",
      "The q parameter does a fast FTS5 search across j_szam, cegnev, eszkoz,",
      "gyariszam, hibajelenseg, vegzett_munka, megjegyzes, dolgozo.",
      "Use the filter parameters for precise lookups (date range, j_szam, etc).",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free text (FTS5: j_szam, customer, device, fault, work, notes, technician)"),
      j_szam: z.string().optional().describe("Substring match on J-sorszam (e.g. 'J00001')"),
      cegnev: z.string().optional().describe("Substring match on customer name (diacritic-folded)"),
      eszkoz: z.string().optional().describe("Substring match on device type (diacritic-folded)"),
      dolgozo: z.string().optional().describe("Substring match on technician name"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound on date"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound on date"),
      source_period: z.string().optional().describe("Source file tag (e.g. '2008-2020', '2020-taksony')"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50, max 200)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/integration/serviz/search", { method: "GET", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 14. get_serviz_ticket — fetch an internal service ticket by j_szam
server.registerTool(
  "get_serviz_ticket",
  {
    title: "Get Internal Service Ticket by J-sorszam",
    description: [
      "Fetch a single internal service ticket (Szervizlap belső) by J-sorszam.",
      "May return multiple rows if the same j_szam appears in different",
      "source files (e.g. J00001 in 2008-2020 and J00001 in 2020-).",
    ].join("\n"),
    inputSchema: {
      j: z.string().describe("J-sorszam, e.g. 'J00001'"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/integration/serviz/by-j-szam", { method: "GET", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 15. search_szev_igeny — search internal material/service requests (2019-now)
server.registerTool(
  "search_szev_igeny",
  {
    title: "Search SZÉV Igény (Internal Material Requests)",
    description: [
      "Search the SZÉV (internal procurement / service) requisition log",
      "from 2019 to current. Covers bearings, parts, external services.",
      "",
      "WHEN TO USE:",
      "- 'What bearings did we order for customer X in 2024?'",
      "- 'Find requisitions on TMV-400'",
      "- 'Show me 2025 SZÉV from MVM Paksi'",
      "",
      "q does FTS5 across szev_szam, megrendelo, geptipus, munkaszam, igeny,",
      "megjegyzes, felelos.",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free text (FTS5: ticket, customer, machine, material, notes, owner)"),
      megrendelo: z.string().optional().describe("Substring match on customer name (diacritic-folded)"),
      geptipus: z.string().optional().describe("Substring match on machine type"),
      munkaszam: z.string().optional().describe("Substring match on munkaszam"),
      felelos: z.string().optional().describe("Substring match on responsible person"),
      year: z.number().int().optional().describe("Filter by year (2019-2026)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50, max 200)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/integration/szev/search", { method: "GET", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 16. search_telephely_munka — search in-house workshop jobs (2018-now)
server.registerTool(
  "search_telephely_munka",
  {
    title: "Search Telephelyi Munkák (In-House Workshop Jobs)",
    description: [
      "Search the in-house workshop job log. Covers parts brought back to",
      "the depot (Telephely) for repair/rebuild, plus on-site (TH) repairs.",
      "",
      "WHEN TO USE:",
      "- 'Did we ever rebuild this kind of build element before?'",
      "- 'Find all telephely jobs for M14066'",
      "- 'What 2020 in-house work had any 'szögfej' (angular head) involvement?'",
      "",
      "q does FTS5 across munkaszam, megrendelo, geptipus, gepepitoelem,",
      "hibajelenseg, elvegzett_munka, parts, technician.",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free text (FTS5: ticket, customer, machine, build element, fault, work, parts)"),
      megrendelo: z.string().optional().describe("Substring match on customer (diacritic-folded)"),
      geptipus: z.string().optional().describe("Substring match on machine type (diacritic-folded)"),
      munkaszam: z.string().optional().describe("Substring match on munkaszam"),
      year: z.number().int().optional().describe("Filter by year (2018, 2019, 2020, etc.)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50, max 200)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/integration/telephely/search", { method: "GET", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 17. search_ais_motor_inventory — list the bad-AiS-motor stock
server.registerTool(
  "search_ais_motor_inventory",
  {
    title: "Search Bad-AiS-Motor Inventory",
    description: [
      "List the contents of the bad AiS motor inventory (Telephelyi munkák",
      "- AiS100). 50+ motors of various types (AiS100, AiS132, Baumüller,",
      "Solpower) are tracked with their original machine, failure mode,",
      "remaining parts, and planned disposition.",
      "",
      "WHEN TO USE:",
      "- 'Do we have a spare AiS100 from machine M16119?'",
      "- 'List all zárlatos (shorted) motors in stock'",
      "- 'What motors were returned from customer X?'",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free text (FTS5: type, serial, original machine, fault, parts)"),
      tipus: z.string().optional().describe("Exact match on motor type (e.g. 'AiS100', 'AiS132')"),
      gep: z.string().optional().describe("Substring match on original machine ID (diacritic-folded)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50, max 200)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/integration/ais/search", { method: "GET", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// 18. get_integration_stats — aggregates across the integration tables
server.registerTool(
  "get_integration_stats",
  {
    title: "Integration Stats",
    description: [
      "Aggregate counts across the integrated CMMS data:",
      "- SZÉV requisitions by year",
      "- Serviz tickets by source period (2008-2020, 2020-taksony, 2020-)",
      "- Top 15 motor types in the bad-AiS inventory",
      "",
      "Use this for 'how many X in year Y?' questions over the integrated data.",
    ].join("\n"),
    inputSchema: {},
  },
  async () => {
    try {
      const data = await call("/v1/integration/stats", { method: "GET" });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

}

// --- Start: stdio transport ---

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("cmms-api MCP server running on stdio");
}

// --- Start: HTTP transport (Streamable HTTP for remote/tunnel clients) ---

async function startHttp() {
  // One transport per session (stateful). MCP clients send initialize,
  // we mint a session ID, and handle subsequent requests on the same
  // transport until DELETE. Each session needs its own McpServer instance
  // because McpServer.connect() can only be called once per server.
  type Session = {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
  };
  const sessions = new Map<string, Session>();

  function newSession(): WebStandardStreamableHTTPServerTransport {
    const server = createServer();
    const t = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport: t, server });
        console.error(`[mcp] session open: ${sid}`);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        console.error(`[mcp] session closed: ${sid}`);
      },
    });
    t.onclose = () => {
      if (t.sessionId) sessions.delete(t.sessionId);
    };
    server.connect(t).catch((e) => {
      console.error(`[mcp] server.connect error:`, e);
    });
    return t;
  }

  const handler = async (req: Request): Promise<Response> => {
    // Optional bearer auth (recommended when exposed via a tunnel).
    if (HTTP_BEARER) {
      const auth = req.headers.get("authorization") ?? "";
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (!m || m[1] !== HTTP_BEARER) {
        return new Response(
          JSON.stringify({ error: { code: "unauthorized", message: "Missing or invalid bearer token" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
    }

    const url = new URL(req.url);
    if (url.pathname !== "/mcp") {
      return new Response("not found", { status: 404 });
    }

    // Look up existing session, or mint a new one for initialize.
    const sid = req.headers.get("mcp-session-id") ?? undefined;
    let transport: WebStandardStreamableHTTPServerTransport;
    if (sid) {
      const existing = sessions.get(sid);
      if (!existing) {
        return new Response(
          JSON.stringify({ error: { code: "session_not_found", message: `session ${sid} not found` } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      transport = existing.transport;
    } else {
      transport = newSession();
    }

    return transport.handleRequest(req);
  };

  const httpServer = Bun.serve({
    port: HTTP_PORT,
    hostname: HTTP_HOST,
    fetch: handler,
    // MCP Streamable HTTP uses long-lived SSE connections.
    // The default 10s idle timeout kills them prematurely.
    // Bun max is 255; use it to keep SSE alive through cloudflared.
    idleTimeout: 255,
  });

  console.error(
    `cmms-api MCP server running on http://${HTTP_HOST}:${httpServer.port}/mcp`,
  );
  if (HTTP_BEARER) {
    console.error(`[mcp] bearer auth enabled (token: ${HTTP_BEARER.slice(0, 8)}...)`);
  } else {
    console.error(`[mcp] WARNING: no bearer auth — only safe behind a trusted network or tunnel`);
  }
}

// --- Dispatch ---

if (TRANSPORT === "http") {
  await startHttp();
} else {
  await startStdio();
}
