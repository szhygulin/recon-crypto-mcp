# Recon MCP

An MCP server that gives AI agents (Claude Code, Claude Desktop, Cursor) real-time intelligence about DeFi positions, protocol security, staking, and multi-chain portfolios — plus transaction signing through Ledger Live over WalletConnect.

## Features

- **Positions** — lending/borrowing (Aave, Compound, Morpho), LP positions, and health-factor alerts
- **Portfolio** — cross-chain balances, DeFi position aggregation, USD-denominated summaries
- **Staking** — Lido, EigenLayer, reward aggregation, yield estimation
- **Security** — contract verification, upgradeability checks, privileged-role enumeration, protocol risk scoring
- **Swaps** — LiFi-routed intra-chain and cross-chain quotes, with a 1inch cross-check
- **Execution** — tx preparation for Aave, Compound, Morpho, Lido, EigenLayer, native/token sends, swaps; signing via Ledger Live (WalletConnect)
- **Utilities** — ENS forward/reverse resolution, token balances, transaction status

## Supported chains

Ethereum, Polygon, Arbitrum, Base, Optimism.

## Requirements

- Node.js >= 18.17
- An RPC provider (Infura, Alchemy, or custom)
- Optional: Etherscan API key, WalletConnect Cloud project ID (required for Ledger signing)

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

## Development

```bash
npm run dev      # tsc --watch
npm test         # vitest run
npm run test:watch
```

## License

MIT
