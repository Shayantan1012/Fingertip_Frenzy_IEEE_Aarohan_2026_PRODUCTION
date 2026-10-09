"""Upload a release over verified SSH; no AWS API access or application secrets."""
import base64
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile


def release_script(environment):
    revision = environment["GITHUB_SHA"]
    image = environment["APP_IMAGE"]
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Invalid commit")
    if not re.fullmatch(r"ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}", image):
        raise ValueError("Invalid image digest")
    run = environment["GITHUB_RUN_ID"]
    attempt = environment["GITHUB_RUN_ATTEMPT"]
    if not run.isdecimal() or not attempt.isdecimal():
        raise ValueError("Invalid workflow run")
    release = f"/opt/fingertip-frenzy/releases/{revision}-{run}-{attempt}"
    commands = ["set -eu", "umask 077", f"mkdir -p {shlex.quote(release)}"]
    payloads = {name: Path("deploy", name).read_bytes() for name in ("compose.yaml", "Caddyfile", "deploy.sh")}
    payloads["image.txt"] = (image + "\n").encode()
    for name, data in payloads.items():
        encoded = base64.b64encode(data).decode()
        commands.append(f"printf %s {shlex.quote(encoded)} | base64 --decode > {shlex.quote(release + '/' + name)}")
    commands.append(f"bash {shlex.quote(release + '/deploy.sh')}")
    return "\n".join(commands) + "\n"


def main():
    host = os.environ["EC2_HOST"]
    user = os.environ.get("EC2_USER", "") or "ubuntu"
    port = os.environ.get("EC2_SSH_PORT", "") or "22"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", host):
        raise ValueError("EC2_HOST must be an IPv4 address or DNS hostname")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", user):
        raise ValueError("Invalid SSH username")
    if not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise ValueError("Invalid SSH port")
    script = release_script(os.environ)
    key = os.environ["EC2_SSH_KEY"].replace("\r\n", "\n").strip() + "\n"
    hosts = os.environ["EC2_KNOWN_HOSTS"].replace("\r\n", "\n").strip() + "\n"
    if not key.strip() or not hosts.strip():
        raise ValueError("SSH private key and verified known_hosts are required")
    with tempfile.TemporaryDirectory(prefix="frenzy-ssh-") as directory:
        private_key = Path(directory, "key")
        known_hosts = Path(directory, "known_hosts")
        private_key.write_text(key)
        private_key.chmod(0o600)
        known_hosts.write_text(hosts)
        known_hosts.chmod(0o600)
        command = [
            "ssh", "-T", "-i", str(private_key), "-p", port,
            "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes",
            "-o", f"UserKnownHostsFile={known_hosts}",
            "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=4",
            f"{user}@{host}", "sudo -n /bin/bash -se",
        ]
        subprocess.run(command, input=script, text=True, check=True, timeout=960)


if __name__ == "__main__":
    main()
