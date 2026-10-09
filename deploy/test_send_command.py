"""Verify SSM payload construction and failure propagation without AWS access."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import shlex
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sender", Path(__file__).with_name("send-command.py"))
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)


class SSMDeploymentTests(unittest.TestCase):
    environment = {
        "EC2_INSTANCE_ID": "i-0123456789abcdef0",
        "GITHUB_SHA": "a" * 40,
        "GITHUB_RUN_ID": "123",
        "GITHUB_RUN_ATTEMPT": "2",
        "APP_IMAGE": "ghcr.io/example/project@sha256:" + "b" * 64,
    }

    def test_success_uploads_only_release_files_and_immutable_reference(self):
        replies = [{"Command": {"CommandId": "command-1"}}, {"Status": "InProgress"}, {"Status": "Success"}]
        with patch.dict(os.environ, self.environment), patch.object(sender, "aws", side_effect=replies) as aws, patch.object(sender.time, "sleep"):
            sender.main()
        args = aws.call_args_list[0].args
        parameters = json.loads(args[args.index("--parameters") + 1])
        commands = parameters["commands"]
        self.assertEqual(parameters["executionTimeout"], ["900"])
        self.assertNotIn("MONGODB_URI", "\n".join(commands))
        self.assertNotIn(".env", "\n".join(commands))
        uploads = commands[3:-1]
        self.assertEqual(len(uploads), 4)
        for command, name in zip(uploads, ["compose.yaml", "Caddyfile", "deploy.sh", "image.txt"]):
            parts = shlex.split(command)
            payload = base64.b64decode(parts[2])
            expected = (self.environment["APP_IMAGE"] + "\n").encode() if name == "image.txt" else Path("deploy", name).read_bytes()
            self.assertEqual(payload, expected)
            self.assertTrue(parts[-1].endswith("-123-2/" + name))
        self.assertTrue(commands[-1].startswith("bash /opt/fingertip-frenzy/releases/"))

    def test_failed_remote_deployment_fails_the_workflow(self):
        with patch.dict(os.environ, self.environment), patch.object(sender, "aws", side_effect=[{"Command": {"CommandId": "command-2"}}, {"Status": "Failed"}]), patch.object(sender.time, "sleep"):
            with self.assertRaisesRegex(SystemExit, "Deployment failed: Failed"):
                sender.main()

    def test_mutable_or_injected_image_is_rejected_before_aws(self):
        for image in ["ghcr.io/example/project:latest", "x;touch /tmp/bad"]:
            with patch.dict(os.environ, {**self.environment, "APP_IMAGE": image}), patch.object(sender, "aws") as aws:
                with self.assertRaisesRegex(ValueError, "Invalid image digest"):
                    sender.main()
                aws.assert_not_called()


if __name__ == "__main__":
    unittest.main()
