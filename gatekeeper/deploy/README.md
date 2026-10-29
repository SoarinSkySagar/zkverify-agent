# Deploy on a free always-on VM

Target: **Oracle Cloud Always Free** (Ampere A1, arm64) or **Google Cloud e2-micro** (amd64),
with Caddy for HTTPS and a free DuckDNS hostname. The agent ends up at
`https://<DOMAIN>/agent`.

```
platform ──HTTPS──▶ Caddy :443 ──▶ agent :8080 (internal only) ──▶ /app/data (volume)
```

Never put secrets in the repo, the image, compose files or shell history. They live only
in `gatekeeper/.env` on the VM (mode 600).

## 1. Create the VM

**Oracle:** Compute → Instances → Create. Image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex**
(e.g. 1–2 OCPU, 6–12 GB). Add your SSH public key. If it says "out of capacity", retry
later or pick another availability domain.

**GCP:** Compute Engine → Create instance. **e2-micro** in `us-west1`, `us-central1` or
`us-east1` (always-free regions), Ubuntu 24.04, standard persistent disk ≤ 30 GB.

**DuckDNS:** sign in at duckdns.org, create a subdomain (e.g. `yourname`), and point it at
the VM's public IP. The updater below keeps it current.

## 2. Open ports 80/443 (SSH stays key-only, nothing else open)

**Oracle**, in two places:
1. VCN → Security List → Ingress rules: TCP 80 and TCP 443 from `0.0.0.0/0`.
2. On the VM. Oracle's Ubuntu images reject these ports in iptables by default:
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

**GCP:** VPC network → Firewall → allow TCP 80, 443 from `0.0.0.0/0` to the instance
(or tick "Allow HTTP/HTTPS traffic" on the VM).

Both: confirm `PasswordAuthentication no` in `/etc/ssh/sshd_config`.

**e2-micro only:** with 1 GB RAM, add swap:
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. Option A — Docker (recommended)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

git clone <your-repo-url> && cd <repo>/gatekeeper
cp .env.example .env && chmod 600 .env
nano .env        # set DOMAIN, DUCKDNS_DOMAIN, DUCKDNS_TOKEN (secret comes in step 4)
cd deploy && ln -s ../.env .env
```

The agent refuses to start without a real `AGENT_GAMES_HMAC_SECRET`, so do step 4 first,
then:

```bash
docker compose up -d --build
docker compose ps                      # agent should become "healthy"
docker compose logs -f caddy           # watch the certificate being issued
curl https://<DOMAIN>/healthz          # {"ok":true}
```

After editing `.env`: `docker compose up -d` (recreates only the containers whose config changed).

## 3. Option B — systemd + host Caddy (no Docker)

```bash
# Node 24 (NodeSource) and Caddy (official apt repo, see caddyserver.com/docs/install)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo apt-get install -y caddy

sudo useradd --system --home /opt/gatekeeper --shell /usr/sbin/nologin gatekeeper
sudo git clone <your-repo-url> /tmp/repo && sudo cp -r /tmp/repo/gatekeeper /opt/gatekeeper
cd /opt/gatekeeper && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo cp .env.example .env
# In .env: HOST=127.0.0.1, DATA_DIR=/var/lib/gatekeeper, plus the secret (step 4)
sudo chown -R root:gatekeeper /opt/gatekeeper && sudo chmod 640 /opt/gatekeeper/.env

sudo cp deploy/gatekeeper.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now gatekeeper

# Caddy reads DOMAIN / AGENT_PATH / UPSTREAM from its environment:
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl edit caddy     # add:  [Service]
                              #       Environment=DOMAIN=<DOMAIN> AGENT_PATH=/agent UPSTREAM=127.0.0.1:8080
sudo systemctl restart caddy

# DuckDNS every 5 minutes (token stays in a root-only file):
sudo install -m 700 deploy/duckdns-update.sh /usr/local/bin/duckdns-update
printf 'DUCKDNS_DOMAIN=yourname\nDUCKDNS_TOKEN=<token>\n' | sudo tee /etc/duckdns.env >/dev/null && sudo chmod 600 /etc/duckdns.env
echo '*/5 * * * * root . /etc/duckdns.env && export DUCKDNS_DOMAIN DUCKDNS_TOKEN && /usr/local/bin/duckdns-update >/dev/null' | sudo tee /etc/cron.d/duckdns
```

## 4. Register, rotate secret, preflight

1. Dashboard → register the endpoint as **`https://<DOMAIN>/agent`** (the full path, not the bare domain).
2. Dashboard → **Rotate Secret** → copy the one-time value into `AGENT_GAMES_HMAC_SECRET`
   in `.env` on the VM. Type or paste it straight into the editor; don't `echo` it.
3. Restart: `docker compose up -d` (A) or `sudo systemctl restart gatekeeper` (B).
4. Dashboard → run **preflight**. If it fails with a signature error, set
   `AGENT_GAMES_HMAC_KEY_ENCODING=hex`, restart, and retry.

## 5. Verify from your laptop

With the same secret in your local `gatekeeper/.env`:
```bash
AGENT_URL=https://<DOMAIN>/agent npm run replay
```
Every line must say `PASS`. Each line shows the round-trip time in ms. The deadline is 60 s,
so anything under ~5 s is comfortable. (These are signed `practice`-mode tasks with random
references. They go into the practice seen-set only and never touch competition state.)

Then run a few dashboard **practice** tasks and compare them with the evidence log
(`docker compose exec agent tail -n 3 /app/data/evidence.jsonl`).

## 6. Monitoring

UptimeRobot (free) → new HTTP(s) monitor → `https://<DOMAIN>/healthz`, 5-minute interval,
email alerts. A missed task costs −2, so act on alerts.

## 7. Back up the state (do not skip)

`state.jsonl` holds the proof-reuse memory (losing it risks −6 approvals of reused proofs).
`evidence.jsonl` is your dispute evidence (72 h window). Never delete them between rounds.

Daily copy, Option A (`crontab -e` as the docker user):
```
15 3 * * * cd $HOME/<repo>/gatekeeper/deploy && docker compose cp agent:/app/data $HOME/gk-backups/$(date +\%F) >/dev/null 2>&1
```
Option B (`sudo crontab -e`):
```
15 3 * * * cp -a /var/lib/gatekeeper /root/gk-backups-$(date +\%F)
```
Occasionally copy the backups off the VM as well (`scp`).

## Notes

- **Oracle idle reclaim:** Always Free instances that stay nearly idle for 7 days can be
  reclaimed, and this agent is idle most of the time. Upgrading the account to
  **Pay-As-You-Go** prevents this and still costs $0 within Always Free limits.
- **Updating:** `git pull && docker compose up -d --build` (A), or
  `git pull && npm ci && npm run build && npm prune --omit=dev && sudo systemctl restart gatekeeper` (B).
  The data volume or `/var/lib/gatekeeper` is kept.
- **Testnet stays the default.** Kurier submission is `KURIER_MODE=off` unless you enable it.
