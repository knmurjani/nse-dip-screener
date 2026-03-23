# NSE Dip Screener — AWS Deployment Guide

## What You'll Get
- A live URL (http://your-ip) you can share with anyone
- Auto-refreshes at **3:15 PM IST** (signals ready before market close at 3:30 PM)
- Also refreshes at **9:15 AM IST** (fresh view at market open)
- Skips weekends automatically
- Auto-restarts if the server crashes or EC2 reboots
- Costs ~$0 (free tier) or ~$3.50/month (t3.micro)

---

## Step 1: Launch an EC2 Instance

1. Go to [AWS Console → EC2](https://console.aws.amazon.com/ec2/)
2. Click **Launch Instance**
3. Configure:
   - **Name:** `dip-screener`
   - **AMI:** Ubuntu 24.04 LTS (free tier eligible)
   - **Instance type:** `t3.micro` (free tier) or `t3.small` for faster scans
   - **Key pair:** Create new → download the `.pem` file
   - **Network/Security Group:** Allow these inbound rules:
     - SSH (port 22) — your IP
     - HTTP (port 80) — anywhere (0.0.0.0/0)
   - **Storage:** 8 GB (default is fine)
4. Click **Launch Instance**
5. Note down the **Public IPv4 address** (e.g., `13.233.45.67`)

---

## Step 2: SSH into EC2 and Run Setup

```bash
# Replace with your values
chmod 400 ~/Downloads/your-key.pem
ssh -i ~/Downloads/your-key.pem ubuntu@<EC2-PUBLIC-IP>
```

Once connected, run the setup script:

```bash
# Download and run setup (installs Node 22, PM2, Nginx)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
sudo npm install -g pm2

# Configure Nginx
sudo tee /etc/nginx/sites-available/dip-screener > /dev/null <<'EOF'
server {
    listen 80;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/dip-screener /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
```

---

## Step 3: Upload and Start the App

**Option A — From your local machine (recommended):**

```bash
# From the dip-screener project folder on your machine:
./deploy.sh <EC2-PUBLIC-IP> ~/Downloads/your-key.pem
```

**Option B — Manual upload:**

```bash
# From your local machine, upload files:
scp -i ~/Downloads/your-key.pem -r ./ ubuntu@<EC2-IP>:~/dip-screener/

# Then SSH in and build:
ssh -i ~/Downloads/your-key.pem ubuntu@<EC2-IP>
cd ~/dip-screener
npm ci
npm run build
NODE_ENV=production pm2 start dist/index.cjs --name dip-screener
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

---

## Step 4: Verify

1. Open `http://<EC2-PUBLIC-IP>` in your browser
2. Wait ~30 seconds for initial data load
3. You should see 190 stocks in the universe and signals if any exist
4. Share this URL with your friends!

---

## Daily Schedule

| Time (IST) | What Happens |
|---|---|
| **9:15 AM** | Fresh data load at market open |
| **3:15 PM** | Signals generated 15 min before close — place limit orders by 3:30 PM |

Weekends are skipped automatically.

---

## Useful PM2 Commands

```bash
pm2 status              # Check if app is running
pm2 logs dip-screener   # View real-time logs
pm2 restart dip-screener # Restart the app
pm2 monit               # Live CPU/memory monitor
```

---

## Optional: Custom Domain + HTTPS

If you want `screener.yourdomain.com` instead of a raw IP:

1. Point your domain's A record to the EC2 IP
2. Install Certbot for free HTTPS:
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d screener.yourdomain.com
   ```

---

## Optional: Docker Deployment

If you prefer Docker:

```bash
# On EC2:
sudo apt install docker.io
sudo docker build -t dip-screener .
sudo docker run -d --name dip-screener -p 5000:5000 --restart always dip-screener
```
