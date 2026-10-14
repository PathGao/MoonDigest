// The committed dev-sidepanel/index.html is what build.mjs makes from sidepanel.html now, so the preview never drifts.
const { execFileSync } = require("child_process");
const path = require("path");

execFileSync(process.execPath, [path.join(__dirname, "build.mjs"), "--check"], { stdio: "inherit" });
console.log("dev-sidepanel build selftest ok");
