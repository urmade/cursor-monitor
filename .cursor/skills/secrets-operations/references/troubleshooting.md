Use this when the main workflow fails and you need a quick fix path.

## Common issues

- `sops is required for this operation but is not installed.`
  - Run `sh scripts/setup-repo.sh`
- `Unable to resolve SOPS age recipient from checked-in .sops.yaml.`
  - Re-run orchestrator baseline sync so the managed `.sops.yaml` is restored
- `Tracked plaintext environment variable files (.env*) are not allowed`
  - Remove the tracked `.env*` file from git and re-create the value with `python3 scripts/secrets.py add ...` or `update ...`
- `Secret key '...' already exists in another scope`
  - Remove the duplicate so the key exists in only one declaration file

## See also

- `https://github.com/internalsphere/internal-app-orchestrator/blob/main/docs/runbooks/sops-secrets-pipeline.md`
- `https://github.com/internalsphere/internal-app-orchestrator/blob/main/docs/runbooks/troubleshooting.md`
