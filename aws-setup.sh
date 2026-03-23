#!/bin/bash
# ============================================
# NSE Dip Screener — AWS EC2 Setup Script
# Run this on a fresh Ubuntu 22.04+ EC2 instance
# ============================================

set -e

echo "=== NSE Dip Screener — AWS Setup ==="

# 1. Update system
echo "[1/6] Updating system..."
sudo apt-get update -y && sudo apt-get upgrade -y

# 2. Install Node.js 22
echo "[2/6] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"

# 3. Install PM2 (process manager — keeps app alive, auto-restarts)
echo "[3/6] Installing PM2..."
sudo npm install -g pm2

# 4. Install nginx (reverse proxy for port 80)
echo "[4/6] Installing Nginx..."
sudo apt-get install -y nginx

# 5. Configure Nginx reverse proxy
echo "[5/6] Configuring Nginx..."
sudo tee /etc/nginx/sites-available/dip-screener > /dev/null <<'EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/dip-screener /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx

# 6. Setup app directory
echo "[6/6] Setting up app..."
mkdir -p ~/dip-screener
cd ~/dip-screener

echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Upload your project files to ~/dip-screener/"
echo "     (Use the deploy.sh script or scp)"
echo ""
echo "  2. Then run:"
echo "     cd ~/dip-screener"
echo "     npm ci"
echo "     npm run build"
echo "     pm2 start dist/index.cjs --name dip-screener"
echo "     pm2 save"
echo "     pm2 startup  # auto-start on reboot"
echo ""
echo "  3. Access at: http://<your-ec2-public-ip>"
echo "============================================"
