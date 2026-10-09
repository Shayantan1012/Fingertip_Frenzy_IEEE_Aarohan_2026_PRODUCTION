# Deploy Fingertip Frenzy to one EC2 instance

Both the **React frontend and Express backend run on the SAME EC2 instance**, inside one versioned Docker image. Caddy runs beside it on that instance, terminates HTTPS and proxies both pages and `/api` to the application. There is no Vercel dependency for this deployment. MongoDB runs separately in Atlas; camera inference runs in participants' browsers.

You configure AWS, DNS, Atlas and GitHub. This repository supplies the Docker image, Compose services, CI/CD workflow, health checks, rollback script and SSH deployment helper. Nothing here creates an instance, changes AWS settings or deploys until you configure and run it.

```text
Browser -- HTTPS --> EC2 t3.medium
                     Caddy :443/:80
                          |
                     app :5000 (private Docker network)
                     React build + Express API
                          |
                     MongoDB Atlas replica set

GitHub Actions --> GHCR image digest
               --> verified SSH --> same EC2
```

## 1. Instance sizing and AWS configuration (you perform these steps)

Start with Ubuntu Server **24.04 LTS, x86_64**, **t3.medium (2 vCPUs, 4 GiB)** and **30 GiB encrypted gp3 EBS**. This is a reasonable starting configuration for the web/API workload with an external database, not a tested participant limit. Docker builds run on GitHub runners. Do not run the three retained original servers: their games have already been integrated into this app.

T3 instances are burstable; watch CPUUtilization, CPUCreditBalance, CPUSurplusCreditBalance/Charges, status checks, disk usage and container memory. Unlimited CPU mode can incur surplus credit charges. HTTP polling and database latency can limit throughput before RAM does. Load-test realistic concurrent teams and three-client Calculator polling before the event; use a larger instance or a sustained-CPU family if required. A single instance has downtime during updates and no high availability.

Configure:

1. A public subnet with Internet Gateway routing and an Elastic IP. Keep the instance's outbound Internet access available.
2. Security group inbound **TCP 80 and 443** from visitors. TCP 22 must also be reachable by the GitHub Actions runner; see the SSH network instructions in step 4. Do **not** expose 5000 or MongoDB 27017. If using IPv6, configure matching routes/rules and DNS; otherwise omit AAAA records.
3. No IAM instance role or SSM Agent is required by this pipeline. Outbound HTTPS must reach GHCR, certificate authorities and required package services. Atlas needs outbound connectivity to its database hosts/ports as documented by Atlas.
4. Require IMDSv2 and enable EC2 monitoring as desired. Use your own AWS account and region.
5. DNS A record, e.g. `games.example.com`, pointing to the Elastic IP. Remove stale AAAA records. **Use a domain and HTTPS**: production cookies and browser cameras require a secure origin. Caddy obtains and renews the certificate automatically once DNS and ports work.
6. Atlas database in a nearby AWS region, a dedicated database user with read/write privileges on `fingertip_frenzy` (including collection/index creation), and network access for your instance's Elastic IP `/32`. Use a replica set: registration and scoring require transactions. URL-encode special characters in the URI password. Size the Atlas tier for event load; a free tier is not a capacity guarantee.

## 2. Install Docker on the instance

Connect using your own SSH setup. These commands target Ubuntu 24.04. If Docker is already installed, check the official install instructions rather than replacing it blindly. Use Docker's maintained apt repository:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl python3 util-linux
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
sudo install -d -m 700 /opt/fingertip-frenzy/releases
```

Use a current Compose plugin (at least 2.24). Docker manages published ports itself; the AWS security group is the primary inbound boundary. Do not assume UFW alone blocks Docker-published ports.

## 3. Create server-only configuration

Create `/opt/fingertip-frenzy/.env` using `sudo nano /opt/fingertip-frenzy/.env`:

```dotenv
DOMAIN=games.example.com
ACME_EMAIL=your-real-email@example.com
MONGODB_URI='mongodb+srv://USER:URL_ENCODED_PASSWORD@CLUSTER/fingertip_frenzy?retryWrites=true&w=majority'
```

```bash
sudo chmod 600 /opt/fingertip-frenzy/.env
```

Use Compose dotenv syntax, with single quotes around the URI to preserve literal `$` characters. Do not shell-source this file. `APP_ORIGIN=https://DOMAIN`, `NODE_ENV=production` and the internal port are set by Compose. The exact domain is the only accepted origin; use that address consistently rather than mixing `www`, IP and preview URLs. Never put MongoDB credentials in frontend `VITE_` values, Docker build arguments, repository files or workflow variables. Existing frontend branding defaults remain compiled into the app.

### GHCR pull authentication

Images published by the workflow initially may be private. Before the first deployment, authenticate Docker **as root** on EC2 using a GitHub token permitted to read this package (`read:packages`, with any required organization SSO authorization). This is separate from the short-lived Actions publishing token:

```bash
sudo -i
read -rp 'GitHub username: ' GHCR_USER
read -rsp 'GHCR read token: ' GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
unset GHCR_TOKEN GHCR_USER
exit
```

Docker stores this credential in root's Docker config; treat root access and the EC2 disk as sensitive. Rotate the token before expiry. Alternatively, explicitly make the package public if publishing your source image is acceptable, then anonymous pulls need no token. Do not change visibility merely to fix a failed pull without considering your code's audience.

## 4. Configure GitHub SSH deployment

No IAM user, deployment role, OIDC provider, AWS access key or SSM setup is needed. GitHub connects directly to the instance with SSH and runs the existing Docker deployment script using passwordless sudo.

1. Confirm you can SSH to the Elastic IP as `ubuntu` using your EC2 private key. Confirm `sudo -n true` succeeds. The standard Ubuntu EC2 user normally has passwordless sudo.
2. In GitHub Settings ? Environments, create **`production`** and restrict deployment branches to **`main` only**.
3. Add these **environment secrets** under `production`:

| Secret | Value |
| --- | --- |
| `EC2_HOST` | Elastic IPv4 address or instance DNS hostname, without `https://` |
| `EC2_SSH_KEY` | Complete private SSH key text, including BEGIN/END lines (your EC2 .pem key works) |
| `EC2_KNOWN_HOSTS` | Verified SSH host-key line for exactly the hostname/IP in `EC2_HOST` |

4. Optional **environment variables**: `EC2_USER=ubuntu` and `EC2_SSH_PORT=22`. Those defaults apply if omitted.
5. Enable GitHub Actions/package publishing. The workflow uses the built-in `GITHUB_TOKEN` to publish to GHCR; root Docker on EC2 still needs the read authentication described above for private packages.
6. Protect `main` as appropriate. Pull requests test/build without deployment secrets. Actions are commit-pinned and Caddy is digest-pinned; maintain these pins and update the Caddy digest in Compose and workflow validation together.

Use a dedicated deployment SSH key if you prefer to keep your personal EC2 key out of GitHub. Generate it on your computer with `ssh-keygen -t ed25519 -f frenzy_deploy -C frenzy-github`, leave its passphrase empty for unattended deployment, and append **only its public .pub key** to the instance user's `~/.ssh/authorized_keys` through your existing authenticated SSH connection. Store the private file only in `EC2_SSH_KEY`; never commit either a .pem or private deployment key.

### Obtain the verified host-key line

From an existing trusted SSH connection to the instance, run this command, substituting the exact Elastic IP/hostname you put in `EC2_HOST`:

```bash
printf '%s ' 'YOUR_ELASTIC_IP'
cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub
```

The resulting single line looks like `YOUR_ELASTIC_IP ssh-ed25519 AAAAC3...`. Copy it into `EC2_KNOWN_HOSTS`. For a nondefault port, use `[YOUR_ELASTIC_IP]:PORT` in that line. The pipeline checks this host identity and fails if it changes; after rebuilding the instance, obtain and verify its new host key before updating the secret. It never disables host verification.

### Allow SSH from the Actions runner

Port 22 must be reachable **from the runner**, not only from your home IP. Standard GitHub-hosted runners have changing outbound IP addresses. For a simple short-event setup, you can temporarily allow TCP 22 from `0.0.0.0/0` with key-only SSH, password login and root SSH login disabled, then remove that rule and the deployment key after the event. If you have a runner with fixed outbound IP, restrict the SSH rule to that address instead. Keep 5000 and 27017 closed in either setup.

## 5. First deployment

Commit and push the prepared files to `main`, or run **Test, build and deploy EC2** manually from `main` after the workflow exists on GitHub. **This step starts an actual deployment.** Ensure steps 1–4 are complete first.

The workflow:

1. Installs locked dependencies on Node 22, runs lint/build/tests with an isolated MongoDB replica set, and validates deployment configuration.
2. Builds the `linux/amd64` production image and smoke-tests frontend routing, API liveness, arena CSP and missing assets.
3. Pushes the tested image to GHCR and records its immutable SHA-256 digest.
4. Uploads release files through verified SSH and runs the deployment with passwordless sudo. Application secrets stay on EC2; the temporary runner key files are removed after the SSH command.
5. Pulls the image, checks database connectivity/replica-set support and creates/verifies required unique/TTL indexes.
6. Recreates services, waits for database readiness and checks local HTTPS with the real hostname/certificate. DNS/inbound access from the Internet must also be tested by you.
7. Updates `/opt/fingertip-frenzy/current` only after success. Failed container/HTTPS checks attempt to restore the prior release. A first deployment has no previous release; failed preflight checks leave existing containers alone.

Release files live in `/opt/fingertip-frenzy/releases/<commit>-<run>-<attempt>`. Caddy certificates use named Docker volumes and survive container recreation. Images, releases and certificates survive reboots; Docker restart policies bring the services back. The pipeline serializes main deployments and the host uses a deployment lock.

## 6. Provision the first administrator

After a successful first deployment, run on EC2:

```bash
sudo -i
cd /opt/fingertip-frenzy/current
export APP_IMAGE=$(cat image.txt)
read -rp 'Admin email: ' ADMIN_EMAIL
read -rsp 'Admin password (16–128 characters): ' ADMIN_PASSWORD; echo
export ADMIN_EMAIL ADMIN_PASSWORD
docker compose --env-file /opt/fingertip-frenzy/.env run --rm --no-deps \
  -e ADMIN_EMAIL -e ADMIN_PASSWORD app node scripts/bootstrap.mjs
unset ADMIN_EMAIL ADMIN_PASSWORD
exit
```

Bootstrap refuses if an administrator already exists. The password is hashed in MongoDB, not persisted in `.env`; do not store it in a command line or the repository. Log in at `https://games.example.com/admin/login`, publish actual Puzzle and Detective content, check game settings and keep teams at **three members** (Calculator requires exactly three).

## 7. Validate the live event site

From your own computer (substitute your domain):

```bash
curl -f https://games.example.com/api/health/live
curl -f https://games.example.com/api/health/ready
curl -I https://games.example.com/login
```

Open registration, login, dashboard and admin pages. Verify secure login cookies, unauthorized admin rejection, team-only scores and all four round transitions. Use **three real devices** for Calculator; test camera permissions, gestures, hand loss, disconnection/reconnection and shared state. Test Memory through all stages on desktop and mobile. The browsers also need access to MediaPipe CDN/model URLs; opening EC2 ports alone does not provide those assets.

## 8. Operations, rollback and troubleshooting

Run operational commands from a root session:

```bash
sudo -i
cd /opt/fingertip-frenzy/current
export APP_IMAGE=$(cat image.txt)
docker compose --env-file /opt/fingertip-frenzy/.env ps
docker compose --env-file /opt/fingertip-frenzy/.env logs --tail=100 app caddy
docker stats --no-stream
df -h
exit
```

Restore the previously successful release:

```bash
sudo bash /opt/fingertip-frenzy/previous/deploy.sh
```

The script resolves that symlink, validates the previous digest, and performs the same health checks. Rollback restores application containers, not database contents. This pipeline runs only additive index verification, never data migrations or production test seeding. Review future incompatible database changes separately before releasing them.

If the SSH connection or workflow times out, inspect the EC2 containers and deployment lock before retrying; a disconnected remote command may still be finishing.

Configuration changes: edit the server `.env`, then rerun the current deployment script (`sudo bash /opt/fingertip-frenzy/current/deploy.sh`). A bad shared environment or database outage can also prevent rollback; fix the environment or restore database service first.

Common failures:

| Symptom | Check |
| --- | --- |
| SSH connection times out | Elastic IP, SSH port and security group access from the Actions runner |
| SSH permission or host-key failure | Correct Ubuntu username/private key, authorized_keys, passwordless sudo and verified EC2_KNOWN_HOSTS |
| GHCR unauthorized | Root Docker login, package read permissions, expired token, package organization SSO |
| Database preflight or health fails | Atlas IP allowlist, URI/password encoding, privileges, replica set and outbound connectivity |
| HTTPS/certificate fails | DNS A/AAAA, Elastic IP, ports 80/443, Caddy logs, certificate authority rate limits |
| Login POST returns 403 | Browser origin must equal `https://DOMAIN`; don't use a different hostname or the instance IP |
| Camera doesn't work | HTTPS, device permissions, browser support and CDN access; test permitted real hardware |

Logs rotate at 10 MB × 3 per service. Old Docker images and release directories accumulate; monitor disk space and clean old, unused releases/images deliberately, keeping current and previous images for rollback. Do not run `docker compose down -v`: it removes certificate volumes. Configure Atlas backups and test restore procedures before the event. No container stores authoritative participant data on EC2.

## References

Local verification on 9 October 2026: production build and lint passed; the Linux/Node 22 Docker test image passed **62/62** application tests using an isolated MongoDB replica set. The production image ran as the unprivileged `node` user with a read-only filesystem; frontend navigation, API liveness, missing-asset responses, arena CSP, native Sharp loading, operational script dependencies and graceful shutdown were checked. After switching transport to SSH, four Python SSH tests and four mocked shell deployment/rollback scenarios passed. Compose configuration and Caddy validation passed. No AWS command, GitHub workflow execution, registry push or EC2 deployment was performed; real HTTPS issuance, instance/network configuration, event load and physical cameras remain deployment checks.

- [AWS T3 specifications](https://docs.aws.amazon.com/en_en/AWSEC2/latest/UserGuide/burstable-t3.html) and [CPU credit behavior](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html)
- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
