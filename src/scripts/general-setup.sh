# Note: This script can't be run in interactive session because apt will lock the stdin cause missing commands

# Lite

sudo apt update -y && sudo apt upgrade -y
sudo apt install -y build-essential clang cmake nasm
sudo apt install -y libc++-dev libc++abi-dev libjsoncpp-dev uuid-dev zlib1g-dev zip unzip screen g++ libstdc++-12-dev

# Bob

sudo apt install -y jq libpq5 libpq-dev vim net-tools tmux cmake git libjsoncpp-dev build-essential cmake uuid-dev libhiredis-dev zlib1g-dev unzip
sudo apt install -y git gcc g++ make cmake autoconf automake libtool python3 libssl-dev
sudo curl -fsSL https://download.keydb.dev/open-source-dist/keyring.gpg | sudo gpg --pinentry-mode loopback --batch --yes --dearmor -o /usr/share/keyrings/keydb-archive-keyring.gpg
sudo echo "deb [signed-by=/usr/share/keyrings/keydb-archive-keyring.gpg] https://download.keydb.dev/open-source-dist jammy main" | sudo tee /etc/apt/sources.list.d/keydb.list
sudo apt update -y
sudo apt upgrade -y
sudo apt install keydb-tools -y
export KVROCK_DEB='https://github.com/RocksLabs/kvrocks-fpm/releases/download/2.14.0-1/kvrocks_2.14.0-1_amd64.deb'
sudo wget $KVROCK_DEB
sudo apt install -y ./$(basename $KVROCK_DEB)
sudo rm -rf "$(basename "$KVROCK_DEB")"*
sudo mkdir -p /data/flash/db
sudo mkdir -p /kvrocksDB/

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
