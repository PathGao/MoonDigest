#!/usr/bin/env python3
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT / "extension"
MANIFEST_PATH = EXTENSION_DIR / "manifest.json"
README_PATH = ROOT / "README.md"
PACKAGE_NAME = "moondigest"


def load_manifest():
    with MANIFEST_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def check_readme_version(version: str):
    match = re.search(r"badge/version-([^-)]+)-", README_PATH.read_text(encoding="utf-8"))
    if not match:
        raise SystemExit("README.md has no version badge (badge/version-X.Y.Z-...)")
    if match.group(1) != version:
        raise SystemExit(f"README.md version badge says {match.group(1)} but manifest.json says {version}; update the badge")


def build_chrome(version: str, release_dir: Path):
    release_folder = release_dir / f"{PACKAGE_NAME}-v{version}-chrome"
    zip_path = release_dir / f"{PACKAGE_NAME}-v{version}-chrome.zip"

    if release_folder.exists():
        shutil.rmtree(release_folder)
    # Selftests and dev-only mocks stay out of the shipped package.
    shutil.copytree(EXTENSION_DIR, release_folder, ignore=shutil.ignore_patterns("*.selftest.js", "dev-sidepanel", "dev"))

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(release_folder.rglob("*")):
            if file_path.is_file():
                archive.write(file_path, file_path.relative_to(release_folder))

    return release_folder, zip_path


def main():
    manifest = load_manifest()
    version = str(manifest.get("version") or "").strip()
    if not version:
        raise SystemExit("manifest.json is missing a version")
    check_readme_version(version)

    release_dir = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "release"
    release_dir.mkdir(parents=True, exist_ok=True)
    folder, zip_path = build_chrome(version, release_dir)

    print(f"Built Chrome release package for v{version}:")
    print(f"- dir: {folder}")
    print(f"  zip: {zip_path}")


if __name__ == "__main__":
    main()
