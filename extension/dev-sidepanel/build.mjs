// 生成 dev-sidepanel/index.html：复制 sidepanel.html，改相对路径，并在 sidepanel.js 前注入 mock chrome。
// 用法：node extension/dev-sidepanel/build.mjs，然后在 extension/ 下起静态服务打开 /dev-sidepanel/index.html
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "sidepanel.html"), "utf8")
  .replace('href="./tokens.css"', 'href="../tokens.css"')
  .replace('href="./sidepanel.css"', 'href="../sidepanel.css"')
  .replace('<script src="./limits.js"></script>', '<script src="../limits.js"></script>')
  .replace('<script src="./sites.js"></script>', '<script src="../sites.js"></script>')
  .replace(
    '<script type="module" src="./sidepanel.js"></script>',
    '<script src="./mock-chrome.js"></script>\n    <script type="module" src="../sidepanel.js"></script>'
  );
if (!html.includes("mock-chrome.js") || !html.includes("../tokens.css") || !html.includes("../sidepanel.css") || !html.includes("../sites.js") || !html.includes("../limits.js")) {
  throw new Error("sidepanel.html 结构变了，build.mjs 的替换没命中");
}
writeFileSync(join(here, "index.html"), html);
console.log("wrote dev-sidepanel/index.html");
