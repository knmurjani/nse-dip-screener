#!/bin/bash
# ============================================
# Deploy NSE Dip Screener to AWS EC2
# Usage: ./deploy.sh <ec2-public-ip> <path-to-pem-key>
# Example: ./deploy.sh 13.233.45.67 ~/my-key.pem
# ============================================

EC2_IP=$1
PEM_KEY=$2

if [ -z "$EC2_IP" ] || [ -z "$PEM_KEY" ]; then
  echo "Usage: ./deploy.sh <ec2-public-ip> <path-to-pem-key>"
  echo "Example: ./deploy.sh 13.233.45.67 ~/my-key.pem"
  exit 1
fi

EC2_USER="ubuntu"
REMOTE_DIR="~/dip-screener"

echo "=== Deploying to $EC2_IP ==="

# Sync project files (excluding node_modules, dist, etc.)
echo "[1/4] Uploading files..."
rsync -avz --progress \
  -e "ssh -i $PEM_KEY -o StrictHostKeyChecking=no" \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='data.db' \
  --exclude='.git' \
  ./ ${EC2_USER}@${EC2_IP}:${REMOTE_DIR}/

# Build and restart on server
echo "[2/4] Installing dependencies..."
ssh -i "$PEM_KEY" ${EC2_USER}@${EC2_IP} "cd ${REMOTE_DIR} && npm ci"

echo "[3/4] Building..."
ssh -i "$PEM_KEY" ${EC2_USER}@${EC2_IP} "cd ${REMOTE_DIR} && npm run build"

echo "[4/4] Restarting app..."
ssh -i "$PEM_KEY" ${EC2_USER}@${EC2_IP} "cd ${REMOTE_DIR} && pm2 delete dip-screener 2>/dev/null; NODE_ENV=production pm2 start dist/index.cjs --name dip-screener && pm2 save"

echo ""
echo "=== Deployed! ==="
echo "Access at: http://${EC2_IP}"
echo ""
