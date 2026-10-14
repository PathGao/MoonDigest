// 生成 dev-sidepanel/index.html：复制 sidepanel.html，把每个 ./x.js、./x.css 改成 ../x，并在 sidepanel.js 前注入 mock chrome。
// 用法：/usr/local/bin/node extension/dev-sidepanel/build.mjs，然后在 extension/ 下起静态服务打开 /dev-sidepanel/index.html
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "sidepanel.html"), "utf8")
  .replace(/(src|href)="\.\/([^"]+\.(?:js|css))"/g, '$1="../$2"')
  .replace(
    '<script type="module" src="../sidepanel.js"></script>',
    '<script src="./mock-chrome.js"></script>\n    <script type="module" src="../sidepanel.js"></script>'
  );
if (!html.includes("./mock-chrome.js")) throw new Error("sidepanel.html 结构变了，build.mjs 没注入 mock-chrome.js");
for (const [, path] of html.matchAll(/(?:src|href)="(\.{1,2}\/[^"]+\.(?:js|css))"/g)) {
  if (!existsSync(join(here, path))) throw new Error(`index.html 引用的 ${path} 不存在`);
}
// --check (build.selftest.js): fail when the committed index.html is not what this script writes now.
if (process.argv.includes("--check")) {
  if (readFileSync(join(here, "index.html"), "utf8") !== html) {
    throw new Error("dev-sidepanel/index.html 和 sidepanel.html 对不上，运行 /usr/local/bin/node extension/dev-sidepanel/build.mjs");
  }
} else {
  writeFileSync(join(here, "index.html"), html);
  console.log("wrote dev-sidepanel/index.html");
}
