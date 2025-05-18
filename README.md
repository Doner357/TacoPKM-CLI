# TacoPKM CLI - Blockchain-Powered Package Manager Client

TacoPKM CLI is the command-line interface for [TacoPKM](https://github.com/Doner357/TacoPKM), a decentralized package manager proof-of-concept. It utilizes blockchain technology for library metadata and version control, and IPFS for distributed artifact storage. This tool allows users to register, publish, install, and manage software libraries in a transparent and resilient manner by interacting with a deployed `LibraryRegistry` smart contract.

## Table of Contents

- [Features](#features)
- [Architecture Reminder](#architecture-reminder)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Install Dependencies](#2-install-dependencies)
  - [3. Make the CLI Command Available](#3-make-the-cli-command-available)
  - [4. IPFS Node Setup](#4-ipfs-node-setup)
  - [5. CLI Wallet Setup](#5-cli-wallet-setup)
  - [6. Network Configuration](#6-network-configuration)
- [Using the CLI (`tpkm`)](#using-the-cli-tpkm)
  - [General Usage](#general-usage)
  - [Wallet Management](#wallet-management)
    - [`tpkm wallet create`](#tpkm-wallet-create)
    - [`tpkm wallet import <privateKey>`](#tpkm-wallet-import-privatekey)
    - [`tpkm wallet address`](#tpkm-wallet-address)
  - [Network Configuration Management](#network-configuration-management)
    - [`tpkm config add <name>`](#tpkm-config-add-name)
    - [`tpkm config list` (or `ls`)](#tpkm-config-list-or-ls)
    - [`tpkm config set-active <name>`](#tpkm-config-set-active-name)
    - [`tpkm config show [name]`](#tpkm-config-show-name)
    - [`tpkm config remove <name>` (or `rm`)](#tpkm-config-remove-name-or-rm)
  - [Library Operations](#library-operations)
    - [`tpkm init`](#tpkm-init)
    - [`tpkm register <name>`](#tpkm-register-name)
    - [`tpkm list`](#tpkm-list-1)
    - [`tpkm info <libraryIdentifier>`](#tpkm-info-libraryidentifier)
    - [`tpkm publish <directory>`](#tpkm-publish-directory)
    - [`tpkm install <libraryIdentifier>`](#tpkm-install-libraryidentifier)
    - [`tpkm deprecate <libraryIdentifier>`](#tpkm-deprecate-libraryidentifier)
    - [`tpkm authorize <libraryName> <userAddress>`](#tpkm-authorize-libraryname-useraddress)
    - [`tpkm revoke <libraryName> <userAddress>`](#tpkm-revoke-libraryname-useraddress)
    - [`tpkm delete <libraryName>`](#tpkm-delete-libraryname)
  - [Registry Administration (Use with Caution)](#registry-administration-use-with-caution)
    - [`tpkm abandon-registry`](#tpkm-abandon-registry)
- [Library Configuration File (`lib.config.json`)](#library-configuration-file-libconfigjson)
- [Development (Smart Contract)](#development-smart-contract)
- [License](#license)

## Features

* Decentralized library registration and versioning on an EVM-compatible blockchain.
* Library code artifact storage on IPFS.
* Support for public and private libraries with owner-managed access control.
* Comprehensive CLI (`tpkm`) for all core operations.
* Encrypted local keystore for secure wallet management and transaction signing.
* Basic dependency management: declaration in `lib.config.json`, storage on-chain, and recursive installation with version constraint satisfaction.
* Connects to user-configured EVM networks (e.g., local Ganache, public testnets like Sepolia) via RPC URLs.
* Uses a bundled ABI to interact with the `LibraryRegistry` smart contract.

## Architecture Reminder

TacoPKM CLI interacts with:
1.  A **`LibraryRegistry` Smart Contract:** Already deployed on an EVM blockchain. This contract holds library metadata.
2.  **IPFS:** For storing and retrieving library code archives.
The CLI itself does not include the smart contract code or Hardhat development environment.

## Prerequisites

Before using TacoPKM CLI, ensure you have the following installed:
* Node.js (v18+ or v20+ recommended) & npm
* IPFS Kubo (running as a daemon: `ipfs daemon`) OR IPFS Desktop.
* Git (for cloning this repository).
* Access to an Ethereum JSON-RPC endpoint for the network you intend to use (e.g., a local Ganache instance, or a public Sepolia node URL from Infura/Alchemy).
* An Ethereum wallet/account with some native currency (e.g., ETH for Ganache, SepoliaETH for Sepolia) to pay for transaction gas fees.

## Installation & Setup

### 1. Clone the Repository
```bash
git clone https://github.com/Doner357/TacoPKM-CLI.git
cd TacoPKM-CLI
```

### 2. Install Dependencies
Install the CLI's Node.js dependencies:
```bash
npm install
```

### 3. Make the CLI Command Available
To use the `tpkm` command globally from any directory during development or local use:
```bash
npm link
```
After this, you should be able to run `tpkm --version`.

### 4. IPFS Node Setup
Ensure your IPFS daemon is running and its API server is accessible. The CLI will default to `http://127.0.0.1:5001/api/v0`. If your IPFS node runs on a different API URL, you'll need to configure it:
* Create a `.env` file in the `tacopkm-cli` directory (where `index.js` is located).
* Add the following line, replacing with your IPFS API URL:
    ```dotenv
    # Tacopkm-CLI/.env
    IPFS_API_URL="http://your_ipfs_api_url:port/api/v0"
    ```
    If this file or variable is not present, the CLI will use `http://127.0.0.1:5001/api/v0`. You can also set `TPKM_WALLET_PASSWORD` here to bypass interactive password prompts (less secure).

### 5. CLI Wallet Setup
TacoPKM CLI uses an encrypted JSON keystore to manage the Ethereum wallet for signing transactions. This keystore is stored by default in `~/.tacopkm/keystore.json` (where `~` is your user home directory).

* **Create a new wallet:**
    ```bash
    tpkm wallet create
    ```
    Follow the prompts to set a strong password. The new wallet's public address will be displayed. **Save your password securely.**

* **Import an existing private key:**
    ```bash
    tpkm wallet import <your_existing_private_key_hex_string>
    ```
    You'll be prompted for a password to encrypt this imported key.

Ensure this wallet has funds on the blockchain network you intend to use.

### 6. Network Configuration
The CLI needs to know which blockchain network to connect to and the address of the deployed `LibraryRegistry` smart contract on that network. This is managed using `tpkm config` commands, which store profiles in `~/.tacopkm/networks.json`.

* **If you are the first user or setting up for a new network (e.g., your local Ganache):**
    You'll need the RPC URL of your network and the address where the `LibraryRegistry` contract is deployed.
    ```bash
    # Example for a local Ganache instance
    tpkm config add localhost --rpc http://127.0.0.1:7545 --contract <YOUR_LOCALHOST_CONTRACT_ADDRESS> --set-active

    # Example for a public Sepolia testnet instance
    # tpkm config add sepolia --rpc <YOUR_SEPOLIA_RPC_URL> --contract <YOUR_SEPOLIA_CONTRACT_ADDRESS>
    ```
* **Default Connection:** If no network is configured via `tpkm config`, the CLI will attempt to connect to a default public `LibraryRegistry` instance on the Sepolia network (RPC and Contract Address are hardcoded as fallbacks in the CLI). When this happens for the first time, it will save this default profile to your `~/.tacopkm/networks.json` and set it as active.

Use `tpkm config list` to see your configured networks and `tpkm config set-active <name>` to switch between them.

## Using the CLI (`tpkm`)

### General Usage
```bash
tpkm [command] [options]
tpkm --help # Shows all available commands
tpkm [command] --help # Shows help for a specific command
```
Commands requiring a transaction will prompt for your wallet password.

### Wallet Management

#### `tpkm wallet create`
Creates a new Ethereum wallet, encrypts it with a user-provided password, and stores it in `~/.tacopkm/keystore.json`.
```bash
tpkm wallet create
tpkm wallet create --password "yourSecretPassword" # For non-interactive use (less secure)
```

#### `tpkm wallet import <privateKey>`
Imports an existing private key, encrypts it with a user-provided password, and saves it to `~/.tacopkm/keystore.json`, overwriting any existing wallet.
```bash
tpkm wallet import 0x123abc...
tpkm wallet import 0x123abc... --password "yourSecretPassword"
```

#### `tpkm wallet address`
Displays the public address of the wallet currently stored in `~/.tacopkm/keystore.json`. Requires password decryption.
```bash
tpkm wallet address
```

### Network Configuration Management

#### `tpkm config add <name>`
Adds or updates a named network profile.
-   **Options:**
    -   `-r, --rpc <url>`: RPC URL for the network.
    -   `-c, --contract <address>`: Deployed `LibraryRegistry` contract address.
    -   `-s, --set-active`: Set this network as active after adding/updating.
-   **Example:**
    ```bash
    tpkm config add my_ganache --rpc http://127.0.0.1:8545 --contract 0x... --set-active
    tpkm config add sepolia_official --rpc https://sepolia.infura.io/v3/<YOUR_ID> --contract 0x...
    ```
    If RPC or contract address are not provided as options, you will be prompted.

#### `tpkm config list` (or `ls`)
Lists all saved network configurations and indicates the active one.
```bash
tpkm config list
```

#### `tpkm config set-active <name>`
Sets a specified network profile as the active one for subsequent `tpkm` commands.
```bash
tpkm config set-active sepolia_official
```

#### `tpkm config show [name]`
Displays details of a specific network profile. If `[name]` is omitted, shows the active profile.
```bash
tpkm config show sepolia_official
tpkm config show # Shows active network
```

#### `tpkm config remove <name>` (or `rm`)
Removes a saved network configuration profile. Prompts for confirmation.
```bash
tpkm config remove old_network
```

### Library Operations

#### `tpkm init`
Initializes a `lib.config.json` file in the current directory by prompting for necessary library details like name, version, description, and language.
```bash
tpkm init
```

#### `tpkm register <name>`
Registers a new library name on the currently active blockchain network. The calling wallet becomes the owner.
-   **Arguments:** `<name>` (unique library name)
-   **Options:**
    -   `-d, --description <text>`
    -   `-t, --tags <tags>` (comma-separated)
    -   `-l, --language <language>`
    -   `--private` (boolean flag)
-   **Example:**
    ```bash
    tpkm register my-cool-lib -d "A cool library" -l javascript --tags "utils,arrays"
    tpkm register my-secret-lib --private -l python
    ```

#### `tpkm list`
Lists all library names registered on the contract of the active network.
```bash
tpkm list
```
*(Note: This may be slow on networks with many libraries).*

#### `tpkm info <libraryIdentifier>`
Displays information about a library.
-   **Arguments:** `<libraryIdentifier>` (e.g., `my-cool-lib` or `my-cool-lib@1.0.0`)
-   **Options:** `--versions` (to list all versions if only name is provided)
-   **Examples:**
    ```bash
    tpkm info my-cool-lib
    tpkm info my-cool-lib --versions
    tpkm info my-cool-lib@1.2.3
    ```

#### `tpkm publish <directory>`
Packages the content of `<directory>`, uploads it to IPFS, and registers a new version for a library on the blockchain. Requires a `lib.config.json` in the directory. The caller must own the library.
-   **Arguments:** `<directory>` (path to library source)
-   **Options:** `-v, --version <version>` (overrides version in `lib.config.json`)
-   **Example:**
    ```bash
    tpkm publish ./path/to/my-lib-v1.1.0/ -v 1.1.0
    ```

#### `tpkm install <libraryIdentifier>`
Downloads a library version (and its dependencies) from IPFS and extracts it into `./tpkm_installed_libs/<libraryName>/<versionString>/`.
-   **Arguments:** `<libraryIdentifier>` (format: `libraryName@versionString`)
-   **Example:**
    ```bash
    tpkm install my-cool-lib@1.1.0
    ```

#### `tpkm deprecate <libraryIdentifier>`
Marks a specific library version as deprecated. Only the library owner can perform this.
-   **Arguments:** `<libraryIdentifier>` (`libraryName@versionString`)
-   **Example:**
    ```bash
    tpkm deprecate my-cool-lib@1.0.0
    ```

#### `tpkm authorize <libraryName> <userAddress>`
Grants another user (by Ethereum address) access to a private library you own.
-   **Arguments:** `<libraryName>`, `<userAddress>`
-   **Example:**
    ```bash
    tpkm authorize my-secret-lib 0xUserAddressToGrantAccess
    ```

#### `tpkm revoke <libraryName> <userAddress>`
Revokes a user's access to a private library you own.
-   **Arguments:** `<libraryName>`, `<userAddress>`
-   **Example:**
    ```bash
    tpkm revoke my-secret-lib 0xUserAddressWhoseAccessIsRevoked
    ```

#### `tpkm delete <libraryName>`
Deletes a registered library record from the blockchain. **This is only allowed if you are the owner AND no versions have ever been published for this library.** This is primarily for correcting registration errors.
-   **Arguments:** `<libraryName>`
-   **Example:**
    ```bash
    tpkm delete my-mistakenly-registered-lib
    ```

### Registry Administration (Use with Caution)

#### `tpkm abandon-registry`
**IRREVERSIBLE ACTION!** Transfers ownership of the `LibraryRegistry` smart contract (for the currently active network) to a specified burn address (default: `0x...dEaD`). This effectively makes all owner-only administrative functions of the contract permanently unusable.
-   **Options:**
    -   `--burn-address <address>`: The burn address to transfer ownership to.
    -   `--network <networkName>`: (Used for confirmation prompt text, the actual network is the active one).
-   **Example (use on a test network first!):**
    ```bash
    tpkm abandon-registry # Uses active network and default burn address
    ```
    This command requires multiple, explicit confirmations due to its severity.

## Library Configuration File (`lib.config.json`)

To publish a library, you need a `lib.config.json` file in its root directory. Use `tpkm init` to generate a template.

**Fields:**
-   `name` (string, required): The name of the library. Must match a name you registered with `tpkm register` and own.
-   `version` (string, required): The semantic version of this release (e.g., "1.0.0", "0.2.1-beta").
-   `description` (string, optional): A brief description.
-   `language` (string, optional): Primary programming language (e.g., "javascript", "c++").
-   `dependencies` (object, optional): An object where keys are names of other TacoPKM libraries and values are their semantic version constraints.
    ```json
    {
      "data-parser": "^1.0.0",
      "common-utils": "~0.5.2"
    }
    ```

**Example `lib.config.json`:**
```json
{
  "name": "my-awesome-lib",
  "version": "1.0.0",
  "description": "An awesome library that does X and Y.",
  "language": "typescript",
  "dependencies": {
    "my-utils-lib": "^2.1.0"
  }
}
```

## Development (Smart Contract)

This repository (`tacopkm-cli`) contains only the CLI tool. The `LibraryRegistry.sol` smart contract and its Hardhat development environment are expected to be in a separate repository.

If you are developing the smart contract:
* You will use `npx hardhat test` in that project to run contract tests.
* After making changes to the contract, recompile and redeploy it.
* Copy the new ABI from `artifacts/contracts/LibraryRegistry.sol/LibraryRegistry.json` into this CLI project's `abi/` directory.
* Update the `CONTRACT_ADDRESS` in your `TacoPKM-CLI/.env` (for local testing) or via `tpkm config add/set-active` for the relevant network.

## License

MIT