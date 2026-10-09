"""Test SSH release construction and failure propagation without network access."""
import base64
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sender", Path(__file__).with_name("ssh-deploy.py"))
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)


class SSHDeploymentTests(unittest.TestCase):
    environment = {
        "EC2_HOST": "ec2.example.com", "EC2_USER": "ubuntu", "EC2_SSH_PORT": "22",
        "EC2_SSH_KEY": "test-private-key", "EC2_KNOWN_HOSTS": "test-host-key",
        "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2",
        "APP_IMAGE": "ghcr.io/example/project@sha256:" + "b" * 64,
    }

    def test_uploads_only_release_files_and_digest(self):
        commands = sender.release_script(self.environment).splitlines()
        self.assertNotIn("MONGODB_URI", "\n".join(commands))
        self.assertNotIn(".env", "\n".join(commands))
        self.assertEqual(len(commands[3:-1]), 4)
        for command, name in zip(commands[3:-1], ["compose.yaml", "Caddyfile", "deploy.sh", "image.txt"]):
            parts = shlex.split(command)
            expected = (self.environment["APP_IMAGE"] + "\n").encode() if name == "image.txt" else Path("deploy", name).read_bytes()
            self.assertEqual(base64.b64decode(parts[2]), expected)
            self.assertTrue(parts[-1].endswith("-123-2/" + name))

    def test_verifies_host_identity_and_cleans_credentials(self):
        with patch.dict(os.environ, self.environment), patch.object(sender.subprocess, "run") as run:
            sender.main()
        args = run.call_args.args[0]
        self.assertIn("StrictHostKeyChecking=yes", args)
        self.assertIn("BatchMode=yes", args)
        self.assertIn("ubuntu@ec2.example.com", args)
        self.assertEqual(args[-1], "sudo -n /bin/bash -se")
        self.assertTrue(run.call_args.kwargs["check"])
        self.assertFalse(Path(args[args.index("-i") + 1]).exists())
        self.assertNotIn("test-private-key", str(run.call_args))

    def test_remote_failure_fails_workflow(self):
        with patch.dict(os.environ, self.environment), patch.object(sender.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "ssh")):
            with self.assertRaises(subprocess.CalledProcessError):
                sender.main()

    def test_rejects_mutable_images_and_command_injection(self):
        for key, value in [("APP_IMAGE", "ghcr.io/example/project:latest"), ("EC2_HOST", "x;touch /tmp/bad"), ("EC2_USER", "-oProxyCommand=bad"), ("GITHUB_RUN_ID", "1;bad")]:
            with patch.dict(os.environ, {**self.environment, key: value}), patch.object(sender.subprocess, "run") as run:
                with self.assertRaises(ValueError):
                    sender.main()
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
