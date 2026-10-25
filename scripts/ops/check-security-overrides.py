#!/usr/bin/env python3
"""Try removing each security override in isolation, without changing the checkout."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def run(*args, cwd=ROOT):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


def main():
    config = run("pnpm", "config", "get", "overrides", "--json")
    config.check_returncode()
    overrides = (json.loads(config.stdout)
                 if config.stdout.strip() not in ("", "undefined", "null") else {})
    if not isinstance(overrides, dict):
        raise RuntimeError("Expected an overrides mapping from pnpm")
    workspace = (ROOT / "pnpm-workspace.yaml").read_text()
    # These project overrides use a top-level mapping with indented entries.
    block = r"^overrides:\s*\n(?:[ \t]+[^\n]*\n|\n)*"
    if overrides and not re.search(block, workspace, re.MULTILINE):
        raise RuntimeError("Unsupported overrides layout; update this checker")
    lines = ["### Temporary security overrides", ""]
    if not overrides:
        lines.append("No temporary overrides remain.")
    for selector, version in overrides.items():
        candidate = {key: value for key, value in overrides.items() if key != selector}
        # JSON flow mappings are valid YAML; preserve all other workspace settings.
        edited = re.sub(block, lambda _: "overrides: " + json.dumps(candidate) + "\n\n",
                        workspace, count=1, flags=re.MULTILINE)
        with tempfile.TemporaryDirectory(prefix="label-cache-overrides-") as directory:
            trial = Path(directory)
            for name in ("package.json", "pnpm-lock.yaml"):
                shutil.copyfile(ROOT / name, trial / name)
            (trial / "pnpm-workspace.yaml").write_text(edited)
            package = selector.rsplit("@", 1)[0]
            update = run("pnpm", "update", package, "--lockfile-only", "--ignore-scripts", cwd=trial)
            if update.returncode:
                raise RuntimeError(f"Unable to check {selector}: {update.stdout}\n{update.stderr}")
            audit = run("pnpm", "audit", "--json", cwd=trial)
            report = json.loads(audit.stdout)
            if "metadata" not in report or "vulnerabilities" not in report["metadata"]:
                raise RuntimeError(f"Audit failed for {selector}: {audit.stdout}\n{audit.stderr}")
            vulnerable = sum(report["metadata"]["vulnerabilities"].values())
            if audit.returncode not in (0, 1) or (audit.returncode != 0 and not vulnerable):
                raise RuntimeError(f"Unexpected audit result for {selector}: {audit.stdout}")
            affected = any(item.get("module_name") == package
                           for item in report.get("advisories", {}).values())
            status = ("still needed" if affected else
                      "trial blocked by other vulnerabilities" if vulnerable else
                      "can be removed after review")
            lines.append(f"- `{selector}: {version}` — {status}.")
    lines.extend(["", "Trials update only the selected dependency within existing constraints. "
                  "No repository files are changed. Remove eligible overrides in a PR and run CI."])
    summary = "\n".join(lines) + "\n"
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write(summary)


if __name__ == "__main__":
    main()
