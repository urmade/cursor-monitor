#!/usr/bin/env python3
import re
import subprocess
import sys

DOTENV_RE = re.compile(r"(^|/)\.env(\..+)?$", re.IGNORECASE)
DOTENV_ALLOW_RE = re.compile(r"(^|/)\.env\.(example|sample|template)$", re.IGNORECASE)
DOCS_URL = "https://github.com/internalsphere/internal-app-orchestrator#environment-variables"
TROUBLESHOOTING_URL = "https://github.com/internalsphere/internal-app-orchestrator/blob/main/docs/runbooks/troubleshooting.md"


def run(command, cwd):
    return subprocess.check_output(command, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()


def list_tracked_dotenv_files(cwd):
    tracked = [line.strip() for line in run(["git", "ls-files"], cwd).splitlines() if line.strip()]
    return [path for path in tracked if DOTENV_RE.search(path) and not DOTENV_ALLOW_RE.search(path)]


def fail_with_guidance(*lines):
    for line in lines:
        print(line, file=sys.stderr)
    print("", file=sys.stderr)
    print("Use the secrets CLI for managed changes:", file=sys.stderr)
    print("- list:   python3 scripts/secrets.py list --scope preview", file=sys.stderr)
    print("- add:    python3 scripts/secrets.py add --scope preview --key MY_KEY", file=sys.stderr)
    print("- update: python3 scripts/secrets.py update --scope preview --key MY_KEY", file=sys.stderr)
    print("- delete: python3 scripts/secrets.py delete --scope preview --key MY_KEY", file=sys.stderr)
    print("", file=sys.stderr)
    print("Allowed tracked dotenv files:", file=sys.stderr)
    print("- .env.example", file=sys.stderr)
    print("- .env.sample", file=sys.stderr)
    print("- .env.template", file=sys.stderr)
    print("", file=sys.stderr)
    print("Run setup: sh scripts/setup-repo.sh", file=sys.stderr)
    print("IMPORTANT: Do not bypass hooks with --no-verify.", file=sys.stderr)
    print("Server-side checks (secrets-policy and secret scanning) will still fail and may trigger security monitoring.", file=sys.stderr)
    print(f"Docs: {DOCS_URL}", file=sys.stderr)
    print(f"Troubleshooting: {TROUBLESHOOTING_URL}", file=sys.stderr)
    return 1


def main():
    tracked_dotenv = list_tracked_dotenv_files(".")
    if not tracked_dotenv:
        return 0

    print("Tracked plaintext environment variable files (.env*) are not allowed:", file=sys.stderr)
    for path in tracked_dotenv:
        print(f"- {path}", file=sys.stderr)
    return fail_with_guidance(
        "Remove these files from the index or replace them with encrypted secrets under secrets/shared/, secrets/preview/, or secrets/production/."
    )


if __name__ == "__main__":
    sys.exit(main())
