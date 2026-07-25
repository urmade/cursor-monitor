#!/usr/bin/env python3
import argparse
import json
import re
import sys
import uuid
from pathlib import Path

APP_MANIFEST_PATH = Path("app-manifest.yml")
VALID_ALIAS_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
VALID_OWNER_EMAIL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._%+-]*@anysphere\.co$", re.IGNORECASE)
VALID_INTEGRATION_TYPES = ("supabase", "upstash-kv", "blob")


def fail(message):
    raise SystemExit(f"Invalid {APP_MANIFEST_PATH.as_posix()}: {message}")


def strip_comment(line):
    in_single = False
    in_double = False
    escaped = False
    output = []
    for char in line:
        if char == "\\" and in_double and not escaped:
            escaped = True
            output.append(char)
            continue
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single and not escaped:
            in_double = not in_double
        elif char == "#" and not in_single and not in_double:
            break
        escaped = False
        output.append(char)
    return "".join(output).rstrip()


def parse_scalar(raw_value, line_number):
    value = raw_value.strip()
    if not value:
        fail(f"line {line_number}: missing value")
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return value


def normalize_root_directory(value):
    raw = str(value or "").strip()
    if raw in {"", ".", "./"}:
        return "."
    while raw.startswith("./"):
        raw = raw[2:]
    return raw


def allowed_integration_types_text():
    return ", ".join(VALID_INTEGRATION_TYPES)


def parse_manifest():
    if not APP_MANIFEST_PATH.exists():
        fail("file is required")

    version = None
    owner = ""
    root_directory = "."
    integrations = {}
    section = None
    current_alias = None

    lines = APP_MANIFEST_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
    for line_number, raw_line in enumerate(lines, start=1):
        if "\t" in raw_line:
            fail(f"line {line_number}: tabs are not supported; use spaces")

        line = strip_comment(raw_line)
        if not line.strip():
            continue

        indent = len(line) - len(line.lstrip(" "))
        if indent not in {0, 2, 4}:
            fail(f"line {line_number}: unsupported indentation level {indent}")

        text = line.strip()

        if indent == 0:
            section = None
            current_alias = None

            if text.endswith(":"):
                key = text[:-1].strip()
                if key == "vercel":
                    section = "vercel"
                    continue
                if key == "integrations":
                    section = "integrations"
                    continue
                fail(f"line {line_number}: unsupported top-level section '{key}'")

            if ":" not in text:
                fail(f"line {line_number}: expected key: value")

            key, raw_value = text.split(":", 1)
            key = key.strip()
            value = parse_scalar(raw_value, line_number)
            if key == "version":
                if value != "1":
                    fail(f"line {line_number}: version must be 1")
                version = 1
                continue
            if key == "owner":
                value = value.strip()
                if not VALID_OWNER_EMAIL_RE.match(value):
                    fail(
                        f"line {line_number}: owner must be an @anysphere.co email address"
                    )
                owner = value.lower()
                continue
            fail(f"line {line_number}: unsupported top-level key '{key}'")

        if indent == 2:
            if section == "vercel":
                if ":" not in text:
                    fail(f"line {line_number}: expected vercel key: value")
                key, raw_value = text.split(":", 1)
                key = key.strip()
                if key != "root_directory":
                    fail(f"line {line_number}: unsupported vercel key '{key}'")
                root_directory = normalize_root_directory(parse_scalar(raw_value, line_number))
                continue

            if section == "integrations":
                if not text.endswith(":"):
                    fail(f"line {line_number}: expected integration alias section")
                alias = text[:-1].strip()
                if not VALID_ALIAS_RE.match(alias):
                    fail(
                        f"line {line_number}: invalid integration alias '{alias}' "
                        "(expected [A-Za-z][A-Za-z0-9_-]*)"
                    )
                if alias in integrations:
                    fail(f"line {line_number}: duplicate integration alias '{alias}'")
                integrations[alias] = {}
                current_alias = alias
                continue

            fail(f"line {line_number}: unexpected nested key outside a supported section")

        if indent == 4:
            if section != "integrations" or not current_alias:
                fail(f"line {line_number}: unexpected integration field")
            if ":" not in text:
                fail(f"line {line_number}: expected integration key: value")
            key, raw_value = text.split(":", 1)
            key = key.strip()
            if key != "type":
                fail(f"line {line_number}: unsupported integration key '{key}'")
            value = parse_scalar(raw_value, line_number)
            if value not in VALID_INTEGRATION_TYPES:
                fail(
                    f"line {line_number}: integration type must be one of: "
                    f"{allowed_integration_types_text()}"
                )
            integrations[current_alias]["type"] = value
            continue

    if version != 1:
        fail("version must be set to 1")
    if not owner:
        fail("owner is required")

    for alias, config in integrations.items():
        if config.get("type") not in VALID_INTEGRATION_TYPES:
            fail(
                f"integrations.{alias}.type must be one of: "
                f"{allowed_integration_types_text()}"
            )

    return {
        "owner": owner,
        "root_directory": root_directory,
        "integrations": integrations,
    }


def write_github_output(path, payload):
    with Path(path).open("a", encoding="utf-8") as handle:
        handle.write(f"owner={payload['owner']}\n")
        handle.write(f"root_directory={payload['root_directory']}\n")
        delimiter = f"__CURSOR_EOF__{uuid.uuid4().hex}"
        handle.write(f"integrations_json<<{delimiter}\n")
        handle.write(json.dumps(payload["integrations"], separators=(",", ":")))
        handle.write(f"\n{delimiter}\n")


def main():
    parser = argparse.ArgumentParser(description="Resolve app-owned delivery settings from app-manifest.yml.")
    parser.add_argument("--github-output", default="", help="Optional path to write GitHub Actions step outputs.")
    args = parser.parse_args()

    payload = parse_manifest()
    if args.github_output:
        write_github_output(args.github_output, payload)
        return 0

    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
