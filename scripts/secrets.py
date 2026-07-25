#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import termios
    import tty
except ImportError:
    termios = None
    tty = None

DOCS_URL = "https://github.com/internalsphere/internal-app-orchestrator#environment-variables"
TROUBLESHOOTING_URL = "https://github.com/internalsphere/internal-app-orchestrator/blob/main/docs/runbooks/troubleshooting.md"
INVENTORY_PATH = Path("secrets/inventory.yaml")
VALID_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
RECIPIENT_RE = re.compile(r"^age1[0-9a-z]+$")
SCOPES = ("shared", "preview", "production")
REMOTE_TARGETS = ("preview", "production")


def fail(message):
    raise SystemExit(message)


def validate_key(key):
    if not VALID_KEY_RE.match(key or ""):
        fail(f"Invalid secret key '{key}'. Keys must match {VALID_KEY_RE.pattern}.")


def secret_path(scope, key):
    validate_key(key)
    if scope not in SCOPES:
        fail(f"Unsupported scope '{scope}'. Expected one of: {', '.join(SCOPES)}.")
    return Path("secrets") / scope / f"{key}.sops.json"


def ensure_sops_config_exists():
    config_path = Path(".sops.yaml")
    if not config_path.exists():
        fail(
            "Unable to resolve SOPS age recipient from checked-in .sops.yaml.\n"
            "If .sops.yaml is missing or stale, re-run orchestrator baseline sync for this repo."
        )
    raw = config_path.read_text(encoding="utf-8", errors="replace")
    matches = re.findall(r"(?m)^\s*-\s*(age1[0-9a-z]+)\s*$", raw)
    if not matches:
        fail(
            "Unable to resolve SOPS age recipient from checked-in .sops.yaml.\n"
            "Expected .sops.yaml to contain a managed age recipient under creation_rules[].age."
        )
    for recipient in matches:
        recipient = recipient.strip()
        if not RECIPIENT_RE.match(recipient):
            fail("Checked-in .sops.yaml does not contain a valid public age recipient.")


def ensure_sops():
    if shutil.which("sops"):
        return
    fail(
        "sops is required for this operation but is not installed.\n"
        "Run: sh scripts/setup-repo.sh\n"
        f"Docs: {DOCS_URL}"
    )


def encrypt_secret_file(path, value):
    ensure_sops()
    ensure_sops_config_exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".json") as handle:
        temp_path = Path(handle.name)
        json.dump({"value": value}, handle, indent=2)
        handle.write("\n")
    try:
        result = subprocess.run(
            [
                "sops",
                "--encrypt",
                "--input-type",
                "json",
                "--output-type",
                "json",
                "--filename-override",
                path.as_posix(),
                temp_path.as_posix(),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            fail(f"SOPS encryption failed for {path.as_posix()}:\n{result.stderr.strip()}")
        rendered = result.stdout
        if rendered and not rendered.endswith("\n"):
            rendered += "\n"
        path.write_text(rendered, encoding="utf-8")
    finally:
        temp_path.unlink(missing_ok=True)


def find_conflicting_occurrences(scope, key):
    if scope == "shared":
        scopes_to_check = ("preview", "production")
    elif scope in {"preview", "production"}:
        scopes_to_check = ("shared",)
    else:
        scopes_to_check = ()
    occurrences = []
    for other_scope in scopes_to_check:
        other_path = secret_path(other_scope, key)
        if other_path.exists():
            occurrences.append(other_path.as_posix())
    return occurrences


def ensure_no_cross_scope_conflict(scope, key):
    conflicts = find_conflicting_occurrences(scope, key)
    if conflicts:
        fail(
            f"Secret key '{key}' conflicts with:\n- " + "\n- ".join(conflicts) + "\n"
            "Shared and environment-specific declarations must not overlap."
        )


def read_secret_from_tty(args):
    if termios is None or tty is None:
        print(
            f"Paste value for {args.key}. Input may be visible; signal EOF when finished.",
            file=sys.stderr,
        )
        return sys.stdin.read()

    print(
        f"Paste value for {args.key}. Input is hidden; press Ctrl-D once when finished.",
        file=sys.stderr,
    )
    fd = sys.stdin.fileno()
    encoding = sys.stdin.encoding or "utf-8"
    original_attrs = termios.tcgetattr(fd)
    chunks = []

    try:
        tty.setraw(fd)
        while True:
            chunk = os.read(fd, 1024)
            if not chunk:
                break
            if b"\x03" in chunk:
                raise KeyboardInterrupt
            eof_index = chunk.find(b"\x04")
            if eof_index != -1:
                chunks.append(chunk[:eof_index])
                break
            chunks.append(chunk)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, original_attrs)
        print("", file=sys.stderr)

    return b"".join(chunks).replace(b"\r\n", b"\n").replace(b"\r", b"\n").decode(encoding)


def read_secret_value(args):
    if args.from_stdin:
        return sys.stdin.read()
    if not sys.stdin.isatty():
        return sys.stdin.read()
    try:
        return read_secret_from_tty(args)
    except (EOFError, KeyboardInterrupt):
        fail("Secret input cancelled.")


def parse_scalar(value):
    if value in {"null", "~"}:
        return None
    if value == "{}":
        return {}
    if value.startswith('"'):
        return json.loads(value)
    return value


def parse_inventory_yaml(path):
    if not path.exists():
        return {}
    root = {}
    stack = [(-1, root)]
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if indent % 2 != 0 or ":" not in stripped:
            fail(f"Unable to parse inventory file at {path.as_posix()}: unsupported line '{raw_line}'.")
        key, remainder = stripped.split(":", 1)
        key = key.strip()
        remainder = remainder.strip()
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if remainder == "":
            node = {}
            parent[key] = node
            stack.append((indent, node))
        else:
            parent[key] = parse_scalar(remainder)
    return root


def list_local(env_name):
    scopes = (env_name,) if env_name else SCOPES
    for current_scope in scopes:
        scope_dir = Path("secrets") / current_scope
        print(f"{current_scope}:")
        keys = []
        if scope_dir.exists():
            keys = sorted(
                path.name[: -len(".sops.json")]
                for path in scope_dir.glob("*.sops.json")
                if path.is_file()
            )
        if not keys:
            print("  (none)")
            continue
        for key in keys:
            print(f"  - {key} ({secret_path(current_scope, key).as_posix()})")


def list_remote(env_name):
    inventory = parse_inventory_yaml(INVENTORY_PATH)
    targets = inventory.get("targets") if isinstance(inventory, dict) else {}
    if not isinstance(targets, dict):
        targets = {}
    target_names = (env_name,) if env_name else REMOTE_TARGETS
    for current_target in target_names:
        print(f"{current_target}:")
        entries = targets.get(current_target, {})
        if not isinstance(entries, dict) or not entries:
            print("  (none)")
            continue
        for key in sorted(entries):
            details = entries[key]
            if not isinstance(details, dict):
                print(f"  - {key}")
                continue
            management = details.get("management", "unknown")
            if management == "app-managed":
                declared_in = details.get("declared_in")
                suffix = f" declared_in={declared_in}" if declared_in else ""
            elif management == "integration-managed":
                integration = details.get("integration")
                integration_type = details.get("type")
                resource = details.get("resource")
                suffix_parts = []
                if integration:
                    suffix_parts.append(f"integration={integration}")
                if integration_type:
                    suffix_parts.append(f"type={integration_type}")
                if resource:
                    suffix_parts.append(f"resource={resource}")
                suffix = f" {' '.join(suffix_parts)}" if suffix_parts else ""
            else:
                suffix = ""
            print(f"  - {key} [{management}]{suffix}")


def command_list(args):
    if args.scope == "remote":
        if args.env == "shared":
            fail("Remote inventory only supports preview or production environments.")
        list_remote(args.env)
        return
    list_local(args.env)


def command_add(args):
    path = secret_path(args.scope, args.key)
    if path.exists():
        fail(f"Secret already exists at {path.as_posix()}. Use update instead.")
    ensure_no_cross_scope_conflict(args.scope, args.key)
    encrypt_secret_file(path, read_secret_value(args))
    print(f"Created {path.as_posix()}")


def command_update(args):
    path = secret_path(args.scope, args.key)
    if not path.exists():
        fail(f"Secret does not exist at {path.as_posix()}. Use add instead.")
    ensure_no_cross_scope_conflict(args.scope, args.key)
    encrypt_secret_file(path, read_secret_value(args))
    print(f"Updated {path.as_posix()}")


def command_delete(args):
    path = secret_path(args.scope, args.key)
    if not path.exists():
        fail(f"Secret does not exist at {path.as_posix()}.")
    path.unlink()
    print(f"Deleted {path.as_posix()}")


def build_parser():
    parser = argparse.ArgumentParser(
        description="Manage orchestrator secrets in secrets/shared/, secrets/preview/, and secrets/production/."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="List declared secrets or remote inventory.")
    list_parser.add_argument("--scope", choices=("local", "remote"), default="local", help="List local declarations or remote inventory.")
    list_parser.add_argument("--env", choices=SCOPES, help="Filter one local scope or one remote environment.")
    list_parser.set_defaults(func=command_list)

    def add_value_args(subparser):
        subparser.add_argument("--scope", required=True, choices=SCOPES, help="Secret scope.")
        subparser.add_argument("--key", required=True, help="Secret key.")
        subparser.add_argument("--from-stdin", action="store_true", help="Read the secret value from stdin.")

    add_parser = subparsers.add_parser("add", help="Create a new encrypted secret file.")
    add_value_args(add_parser)
    add_parser.set_defaults(func=command_add)

    update_parser = subparsers.add_parser("update", help="Update an existing encrypted secret file.")
    add_value_args(update_parser)
    update_parser.set_defaults(func=command_update)

    delete_parser = subparsers.add_parser("delete", help="Delete an encrypted secret file.")
    delete_parser.add_argument("--scope", required=True, choices=SCOPES, help="Secret scope.")
    delete_parser.add_argument("--key", required=True, help="Secret key.")
    delete_parser.set_defaults(func=command_delete)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except FileNotFoundError as error:
        fail(f"File not found: {error.filename}")
    except subprocess.CalledProcessError as error:
        fail(error.stderr or error.output or str(error))


if __name__ == "__main__":
    main()
