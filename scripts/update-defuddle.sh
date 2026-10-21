#!/bin/sh
# Replaces extension/vendor/defuddle.js with Defuddle <version>'s dist/index.full.js from npm, and the version and MIT
# notice in THIRD_PARTY_NOTICES.md (the one place the vendored version is recorded).
#   scripts/update-defuddle.sh 0.19.5
set -eu
cd "$(dirname "$0")/.."
version="${1:-}"
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: $0 <version>   (an exact version such as 0.19.5, not latest)" >&2; exit 2 ;;
esac
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://registry.npmjs.org/defuddle/-/defuddle-$version.tgz" -o "$tmp/defuddle.tgz"
tar -xzf "$tmp/defuddle.tgz" -C "$tmp"
cp "$tmp/package/dist/index.full.js" extension/vendor/defuddle.js
python3 - "$version" "$tmp/package/LICENSE" <<'PYTHON'
import re
import sys
from pathlib import Path

version, license_path = sys.argv[1], Path(sys.argv[2])
notices = Path("THIRD_PARTY_NOTICES.md")
text = notices.read_text()
head = "## kepano/defuddle\n"
start = text.index(head)
end = text.find("\n## ", start + len(head))
end = len(text) if end < 0 else end + 1
section = re.sub(r"^Version: .*$", f"Version: {version}", text[start:end], count=1, flags=re.M)
if license_path.exists():
    section = re.sub(r"```\n.*?\n```", lambda _: f"```\n{license_path.read_text().strip()}\n```", section, count=1, flags=re.S)
notices.write_text(text[:start] + section + text[end:])
PYTHON
size="$(wc -c < extension/vendor/defuddle.js | tr -d ' ')"
sum="$(shasum -a 256 extension/vendor/defuddle.js | cut -d' ' -f1)"
echo "defuddle $version: extension/vendor/defuddle.js, $size bytes, sha256 $sum"
echo "Run the selftests and scripts/smoke.mjs before committing."
