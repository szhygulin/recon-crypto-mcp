# Recon MCP

**Manage your crypto portfolio with AI agents — through your Ledger hardware wallet.**

Recon MCP is a Model Context Protocol server that lets AI agents (Claude Code, Claude Desktop, Cursor) read your on-chain positions and prepare transactions that you sign on your Ledger device via WalletConnect. Your private keys never leave the hardware wallet, and every transaction is previewed in human-readable form before you approve it on the device.

Use it when you want to:

- Ask an agent "what are my DeFi positions across Ethereum, Arbitrum, and Polygon?" and get a unified portfolio view (wallet balances + Aave/Compound/Morpho lending + Uniswap V3 LP + Lido/EigenLayer staking).
- Get liquidation-risk alerts ("any position below health factor 1.5?") without manually checking dashboards.
- Swap or bridge tokens — the agent prepares the route via LiFi, you sign on Ledger.
- Supply/borrow/repay on lending protocols, stake ETH on Lido, deposit into EigenLayer strategies, send tokens — all through Ledger-signed transactions.
- Assess protocol security (contract verification, proxy admin keys, privileged roles) before interacting with it.

This is an **agent-driven portfolio management** tool, not a wallet replacement. The MCP never holds keys or broadcasts anything you haven't approved on your device.

## Features

- **Positions** — lending/borrowing (Aave, Compound, Morpho), LP positions, and health-factor alerts
- **Portfolio** — cross-chain balances, DeFi position aggregation, USD-denominated summaries
- **Staking** — Lido, EigenLayer, reward aggregation, yield estimation
- **Security** — contract verification, upgradeability checks, privileged-role enumeration, protocol risk scoring
- **Swaps** — LiFi-routed intra-chain and cross-chain quotes; intra-chain routes are also cross-checked against 1inch (when an API key is configured) with a `bestSource` hint and output-delta savings
- **Execution** — tx preparation for Aave, Compound, Morpho, Lido, EigenLayer, native/token sends, swaps; signing via Ledger Live (WalletConnect) for EVM chains
- **Utilities** — ENS forward/reverse resolution, token balances, transaction status

## Supported chains

EVM: Ethereum, Arbitrum, Polygon.

## Requirements

- Node.js >= 18.17
- An RPC provider (Infura, Alchemy, or custom) for the EVM chains
- Optional: Etherscan API key, 1inch Developer Portal API key (enables swap-quote comparison), WalletConnect Cloud project ID (required for Ledger signing)

## Install

```bash
npm install
npm run build
```

## Setup

Run the interactive setup to pick an RPC provider, validate the key, optionally pair Ledger Live, and write `~/.recon-mcp/config.json`:

```bash
npm run setup
```

Environment variables always override the config file at runtime.

## Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "recon-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/recon-mcp/dist/index.js"]
    }
  }
}
```

The setup script prints a ready-to-paste snippet.

## Environment variables

All are optional if the matching field is in `~/.recon-mcp/config.json`; env vars take precedence when both are set.

- `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `POLYGON_RPC_URL` — custom RPC endpoints
- `RPC_PROVIDER` (`infura` | `alchemy`) + `RPC_API_KEY` — alternative to custom URLs
- `ETHERSCAN_API_KEY` — contract verification lookups
- `ONEINCH_API_KEY` — enables 1inch quote comparison in `get_swap_quote`
- `WALLETCONNECT_PROJECT_ID` — required for Ledger Live signing
- `RPC_BATCH=1` — opt into JSON-RPC batching (off by default; many public endpoints mishandle batched POSTs)

## Development

```bash
npm run dev      # tsc --watch
npm test         # vitest run
npm run test:watch
```

## License

MIT
