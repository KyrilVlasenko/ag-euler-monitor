import { readFile } from "node:fs/promises";
import { auditPublicContent } from "./security.js";

const paths = process.argv.slice(2);
if (!paths.length) throw new Error("provide one or more public output paths to audit");
for (const path of paths) auditPublicContent(await readFile(path, "utf8"));
console.log(`[public audit] passed files=${paths.length}`);
