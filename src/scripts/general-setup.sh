# Note: This script can't be run in interactive session because apt will lock the stdin cause missing commands

# Lite

sudo apt update -y && sudo apt upgrade -y
sudo apt install -y build-essential clang cmake nasm
sudo apt install -y libc++-dev libc++abi-dev libjsoncpp-dev uuid-dev zlib1g-dev zip unzip screen

# Bob

sudo apt install -y jq libpq5 libpq-dev vim net-tools tmux cmake git libjsoncpp-dev build-essential cmake uuid-dev libhiredis-dev zlib1g-dev unzip
sudo curl -fsSL https://download.keydb.dev/open-source-dist/keyring.gpg | sudo gpg --pinentry-mode loopback --batch --yes --dearmor -o /usr/share/keyrings/keydb-archive-keyring.gpg
sudo echo "deb [signed-by=/usr/share/keyrings/keydb-archive-keyring.gpg] https://download.keydb.dev/open-source-dist jammy main" | sudo tee /etc/apt/sources.list.d/keydb.list
sudo apt update -y
sudo apt upgrade -y
sudo apt install keydb-tools -y
sudo mkdir -p /data/flash/db

# Disable firewall
sudo ufw disable || true
sudo systemctl stop firewalld || true
sudo iptables -F || true
sudo iptables -X || true
sudo iptables -t nat -F || true
sudo iptables -t nat -X || true
sudo iptables -t mangle -F || true
sudo iptables -t mangle -X || true
sudo iptables -P INPUT ACCEPT || true
sudo iptables -P FORWARD ACCEPT || true
sudo iptables -P OUTPUT ACCEPT || true
sudo nft flush ruleset || true
