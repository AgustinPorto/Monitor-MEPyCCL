import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(repoRoot, "dashboard_worker_source.html");
const indexPath = path.join(repoRoot, "src", "index.js");
const EMBED_PATTERN = /const DASHBOARD_HTML_B64 = `([\s\S]*?)`;/;

const sourceHtml = fs.readFileSync(sourcePath, "utf8");
const expected = Buffer.from(sourceHtml, "utf8").toString("base64");
const indexContent = fs.readFileSync(indexPath, "utf8");
const match = indexContent.match(EMBED_PATTERN);

if (!match) {
  console.error("check_dashboard_embed_sync: DASHBOARD_HTML_B64 block not found in src/index.js");
  process.exit(1);
}

const embedded = match[1].replace(/\s+/g, "");
if (embedded !== expected) {
  console.error("Dashboard embed is out of sync with dashboard_worker_source.html.");
  console.error("Run: npm run sync:dashboard");
  process.exit(1);
}

console.log("Dashboard embed is in sync.");
