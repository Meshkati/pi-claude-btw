// Fail if the npm tarball would ship anything beyond the extension and its docs,
// or would miss the extension itself.
import { execFileSync } from "node:child_process";

const allowed = new Set(["CHANGELOG.md", "LICENSE", "README.md", "extensions/btw.ts", "package.json"]);
const [{ files }] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
const shipped = files.map((file) => file.path).sort();
const unexpected = shipped.filter((path) => !allowed.has(path));

if (!shipped.includes("extensions/btw.ts") || unexpected.length > 0) {
	console.error(`Unexpected package contents: ${shipped.join(", ")}`);
	process.exit(1);
}
console.log(`Package contents: ${shipped.join(", ")}`);
