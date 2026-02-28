import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(repoRoot, "dashboard_worker_source.html");
const indexPath = path.join(repoRoot, "src", "index.js");
const EMBED_PATTERN = /const DASHBOARD_HTML_B64 = `[\s\S]*?`;/;

const sourceHtml = fs.readFileSync(sourcePath, "utf8");
const encoded = Buffer.from(sourceHtml, "utf8").toString("base64");
const indexContent = fs.readFileSync(indexPath, "utf8");

if (!EMBED_PATTERN.test(indexContent)) {
  throw new Error("Unable to find DASHBOARD_HTML_B64 block in src/index.js");
}

const nextIndexContent = indexContent.replace(
  EMBED_PATTERN,
  `const DASHBOARD_HTML_B64 = \`${encoded}\`;`,
);

if (nextIndexContent === indexContent) {
  console.log("Dashboard embed already in sync.");
  process.exit(0);
}

fs.writeFileSync(indexPath, nextIndexContent, "utf8");
console.log("Dashboard embed updated from dashboard_worker_source.html");
