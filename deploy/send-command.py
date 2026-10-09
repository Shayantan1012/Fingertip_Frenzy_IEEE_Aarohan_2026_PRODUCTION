"""Send reviewed release files over SSM; application secrets never enter Actions."""
import base64
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time


def aws(*args):
    return json.loads(subprocess.check_output(["aws", *args, "--output", "json"], text=True))


def main():
    instance = os.environ["EC2_INSTANCE_ID"]
    revision = os.environ["GITHUB_SHA"]
    image = os.environ["APP_IMAGE"]
    if not re.fullmatch(r"i-[a-f0-9]{8,17}", instance):
        raise ValueError("Invalid EC2 instance ID")
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Invalid commit")
    if not re.fullmatch(r"ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}", image):
        raise ValueError("Invalid image digest")
    # Unique attempts never overwrite a release that is mounted by Caddy.
    release = f"/opt/fingertip-frenzy/releases/{revision}-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    commands = ["set -eu", "umask 077", f"mkdir -p {shlex.quote(release)}"]
    payloads = {name: Path("deploy", name).read_bytes() for name in ("compose.yaml", "Caddyfile", "deploy.sh")}
    payloads["image.txt"] = (image + "\n").encode()
    for name, data in payloads.items():
        encoded = base64.b64encode(data).decode()
        commands.append(f"printf %s {shlex.quote(encoded)} | base64 --decode > {shlex.quote(release + '/' + name)}")
    commands.append(f"bash {shlex.quote(release + '/deploy.sh')}")
    parameters = json.dumps({"commands": commands, "executionTimeout": ["900"]})
    result = aws("ssm", "send-command", "--instance-ids", instance, "--document-name", "AWS-RunShellScript", "--timeout-seconds", "120", "--parameters", parameters)
    command_id = result["Command"]["CommandId"]
    print(f"SSM command: {command_id}", flush=True)
    for _ in range(210):
        time.sleep(5)
        try:
            result = aws("ssm", "get-command-invocation", "--command-id", command_id, "--instance-id", instance)
        except subprocess.CalledProcessError:
            continue  # SSM command invocation is eventually consistent.
        status = result["Status"]
        if status in {"Pending", "InProgress", "Delayed", "Cancelling"}:
            continue
        print(result.get("StandardOutputContent", ""))
        print(result.get("StandardErrorContent", ""))
        if status != "Success":
            raise SystemExit(f"Deployment failed: {status}")
        return
    raise SystemExit(f"Timed out waiting for SSM {command_id}; inspect it in AWS before retrying.")


if __name__ == "__main__":
    main()
