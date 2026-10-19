// Embeds src/runner.js into hooks/register.ts (the mod module has no fs).
// Function replacers are used so "$&"-style sequences inside the runner are never interpreted.
const fs = require("fs");
const NL = String.fromCharCode(10);
const runner = fs.readFileSync(__dirname + "/src/runner.js", "utf8");
const broker = fs.readFileSync(__dirname + "/src/broker.js", "utf8");
const tpl = fs.readFileSync(__dirname + "/src/register.tpl.ts", "utf8");
const rg = __dirname.split(String.fromCharCode(92)).join("/") + "/bin/rg.exe";
const out = tpl.replace("__BROKER__", () => JSON.stringify(broker)).replace("__RUNNER__", () => JSON.stringify(runner)).replace("__RG__", () => JSON.stringify(rg)).split("\r").join("") + NL;
fs.writeFileSync(__dirname + "/hooks/register.ts", out);
const m = /const DESC_PARTS = \[([\s\S]*?)\]\n/.exec(tpl);
if (m) console.log("DESC chars (approx): " + eval("[" + m[1] + "]").join(" ").length);
console.log("built hooks/register.ts (" + out.length + " bytes)");
