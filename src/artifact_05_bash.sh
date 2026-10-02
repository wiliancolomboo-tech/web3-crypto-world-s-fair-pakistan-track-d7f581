# 1. Clone repository and install dependencies
git clone https://github.com/pakflow/pakflow-core.git
cd pakflow-core
npm install
anchor build

# 2. Configure Solana CLI to Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
solana airdrop 2

# 3. Deploy Anchor Program to Solana
anchor deploy --provider.cluster devnet

# 4. Initialize platform state
npx ts-node scripts/init-platform.ts --fee-bps 10