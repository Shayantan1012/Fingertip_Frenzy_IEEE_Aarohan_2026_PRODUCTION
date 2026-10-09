# Simple EC2 deployment

**Frontend and backend run together on one EC2 instance.** Caddy provides HTTPS. MongoDB stays in Atlas.

The deployment files are just:

- `Dockerfile`: builds the frontend and runs the backend.
- `deploy/compose.yaml`: starts the app and Caddy.
- `deploy/Caddyfile`: HTTPS and reverse proxy.
- `.github/workflows/ci-cd.yml`: test, build, copy over SSH, start.

No IAM setup, container registry, custom Python scripts, release folders or automatic rollback.

## 1. Configure your EC2 instance

Use **Ubuntu 24.04, x86_64, t3.medium**, with about **30 GB disk**, an Elastic IP and a hostname pointing to it. You can use the free hostname option below without buying a domain. t3.medium is a starting point; test your expected event traffic before opening registration.

Open TCP **80 and 443** for visitors. TCP **22** must allow the GitHub runner to connect, not only your home IP. Standard GitHub runners have changing IPs; for a short event, a temporary public SSH rule with key-only login is the simplest option. Remove it after the event. Keep ports 5000 and 27017 closed.

In Atlas, allow your Elastic IP and create a database user with read/write and index-creation access to `fingertip_frenzy`. Use a replica set/Atlas cluster because the app uses transactions. Use a domain with HTTPS for camera access and production login cookies.

SSH to the instance as `ubuntu`. On a fresh Ubuntu installation:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo docker compose version
sudo mkdir -p /opt/fingertip-frenzy
sudo nano /opt/fingertip-frenzy/.env
```

If Docker is already installed, keep the existing installation and verify `sudo docker compose version` works. The packages above are supplied by [Ubuntu 24.04](https://packages.ubuntu.com/noble/docker-compose-v2).

Put these three values in the server's `.env`:

```dotenv
DOMAIN=games.example.com
ACME_EMAIL=your-email@example.com
MONGODB_URI='mongodb+srv://USER:URL_ENCODED_PASSWORD@CLUSTER/fingertip_frenzy?retryWrites=true&w=majority'
```

```bash
sudo chmod 600 /opt/fingertip-frenzy/.env
sudo -n true
```

Use your real hostname, email and Atlas URI. URL-encode special characters in the database password. Keep this file on EC2 only. The Ubuntu SSH user must have passwordless sudo for deployment.

### Without buying a domain

Set `DOMAIN` to your EC2 **public IPv4 followed by `.sslip.io`**. For example, if your real public IP were `13.201.10.20`, use:

```dotenv
DOMAIN=13.201.10.20.sslip.io
ACME_EMAIL=your-real-email@example.com
```

Keep your existing `MONGODB_URI` in the same file. Replace the example IP and email with your own. [sslip.io](https://sslip.io/) resolves this hostname to the embedded IP without an account or DNS setup, and supports obtaining HTTPS certificates through Caddy. Keep ports 80 and 443 publicly reachable. Use an Elastic IP so the hostname stays the same.

Open `https://YOUR_EC2_PUBLIC_IP.sslip.io` after deployment. Both frontend and backend still run on your EC2; sslip.io supplies DNS only. This option depends on the public sslip.io DNS service. Check login and camera access on the event network before the event. Plain `http://YOUR_EC2_PUBLIC_IP` cannot support the camera games because browsers require a [secure context for camera access](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

The pipeline reads **`/opt/fingertip-frenzy/.env` on EC2** explicitly. A local `backend/.env` or GitHub Secret with these names does not configure Compose on the server.

## 2. Add three GitHub Secrets

In your repository: **Settings ? Secrets and variables ? Actions ? New repository secret**.

| Secret | Value |
| --- | --- |
| `EC2_HOST` | Your Elastic IP or hostname, without `https://` |
| `EC2_SSH_KEY` | Full contents of your EC2 private .pem key, including BEGIN/END lines |
| `EC2_KNOWN_HOSTS` | Verified host-key line from the command below |

From your existing trusted SSH connection to EC2, substitute the same IP/hostname as `EC2_HOST`:

```bash
printf '%s ' 'YOUR_ELASTIC_IP'
cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub
```

Copy that single line into `EC2_KNOWN_HOSTS`. SSH host verification stays enabled. No AWS credentials or registry token are required. The SSH port is 22 and username defaults to `ubuntu`; if needed, set the optional repository variable `EC2_USER`.

## 3. Deploy

Commit and push the files to `main`:

```bash
git add .
git commit -m "Simplify EC2 deployment"
git push origin main
```

The workflow tests the app, builds its Docker image on GitHub, copies it to EC2, verifies database access/indexes, and starts both containers. It also waits for the app's database health check, verifies the running image matches the requested Git commit, and publishes valid saved Detective drafts. Check the **Actions** tab for success or errors.

Then open `https://YOUR_DOMAIN`. DNS and ports 80/443 must be correct for Caddy to obtain the certificate. Test registration/login and all four games on real devices before the event.

Deployment briefly restarts the containers. Deploy before the event; avoid pushing updates during live play. There is no automatic rollback in this simplified setup. If an update fails, inspect the logs, correct the problem, and rerun the workflow.

## 4. Create the first admin once

On EC2:

```bash
sudo -i
cd /opt/fingertip-frenzy
read -rp 'Admin email: ' ADMIN_EMAIL
read -rsp 'Admin password (at least 16 characters): ' ADMIN_PASSWORD; echo
export ADMIN_EMAIL ADMIN_PASSWORD
docker compose run --rm --no-deps -e ADMIN_EMAIL -e ADMIN_PASSWORD app node scripts/bootstrap.mjs
unset ADMIN_EMAIL ADMIN_PASSWORD
exit
```

Log in at `/admin/login`, publish the Puzzle and Detective content, and confirm game settings. Keep teams at three members for Calculator. Bootstrap refuses if an admin already exists.

## Useful commands

Run on EC2:

```bash
cd /opt/fingertip-frenzy
sudo docker compose ps
sudo docker compose logs --tail=100 app caddy
sudo docker compose restart app
```

To apply a changed server `.env`:

```bash
sudo docker compose up -d --force-recreate --wait --wait-timeout 180
```

Use `docker stats` and `df -h` to check memory and disk. Logs rotate automatically; old Docker images can accumulate between updates. Never use `docker compose down -v` because it removes Caddy's certificate storage. Participant data stays in Atlas; configure its backups before the event.

If SSH times out, check port 22 and the host IP. If app health fails, check the Atlas URI, IP allowlist and database privileges. If HTTPS fails, check domain DNS and ports 80/443.

If deployment reports `DOMAIN` or `ACME_EMAIL` is missing, edit the server file with `sudo nano /opt/fingertip-frenzy/.env` and add the three values shown above, preserving your real MongoDB URI. After saving, validate without displaying secrets:

```bash
cd /opt/fingertip-frenzy
sudo docker compose --env-file /opt/fingertip-frenzy/.env config --quiet
```

Then rerun the failed GitHub Actions job. `DOMAIN` must be a hostname such as `games.your-domain.com` or `YOUR_EC2_PUBLIC_IP.sslip.io`, without a scheme, port or path; its DNS must point to EC2. You do not need to buy a domain.


To verify the deployed code on EC2, compare this image label with the successful Actions run's commit:

```bash
cd /opt/fingertip-frenzy
sudo docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(sudo docker compose ps -q app)"
```

The workflow prints `Running app commit: ...` after starting the verified image. A failed deployment may leave the older app running. Use a successful run for the latest commit, not a rerun of an older commit's workflow. Confirm the browser is using the hostname for this EC2 instance.
