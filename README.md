# TacoPKM CLI - Blockchain-Powered Package Manager Client

TacoPKM CLI is the command-line interface for [TacoPKM](https://github.com/Doner357/TacoPKM/tree/license-fee), a decentralized package manager proof-of-concept. It utilizes blockchain technology for library metadata and version control, and IPFS for distributed artifact storage. This tool allows users to register, publish, install, and manage software libraries in a transparent and resilient manner by interacting with a deployed `LibraryRegistry` smart contract.

**CLI Version: 0.1.0**

## Table of Contents

- [Features](#features)
- [Architecture Reminder](#architecture-reminder)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Install Dependencies](#2-install-dependencies)
  - [3. Make the CLI Command Available](#3-make-the-cli-command-available)
  - [4. IPFS Node Setup](#4-ipfs-node-setup)
  - [5. Environment Variables (Optional but Recommended)](#5-environment-variables-optional-but-recommended)
  - [6. CLI Wallet Setup](#6-cli-wallet-setup)
  - [7. Network Configuration](#7-network-configuration)
- [Using the CLI (`tpkm`)](#using-the-cli-tpkm)
  - [General Usage](#general-usage)
  - [Wallet Management](#wallet-management)
    - [`tpkm wallet create`](#tpkm-wallet-create)
    - [`tpkm wallet import <privateKey>`](#tpkm-wallet-import-privatekey)
    - [`tpkm wallet address`](#tpkm-wallet-address)
    - [`tpkm wallet balance`](#tpkm-wallet-balance)
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
    - [`tpkm set-license <libraryName>`](#tpkm-set-license-libraryname)
    - [`tpkm purchase-license <libraryName>`](#tpkm-purchase-license-libraryname)
    - [`tpkm delete <libraryName>`](#tpkm-delete-libraryname)
  - [Registry Administration (Use with Extreme Caution)](#registry-administration-use-with-extreme-caution)
    - [`tpkm abandon-registry`](#tpkm-abandon-registry)
- [Library Configuration File (`lib.config.json`)](#library-configuration-file-libconfigjson)
- [Development (Smart Contract)](#development-smart-contract)
- [License](#license)

## Features

* Decentralized library registration and versioning on an EVM-compatible blockchain.
* Library code artifact storage on IPFS.
* Support for public and private libraries with owner-managed access control (direct authorization).
* Support for public libraries with purchasable licenses (fee-based access).
* Comprehensive CLI (`tpkm`) for all core operations.
* Encrypted local keystore for secure wallet management and transaction signing.
* Basic dependency management: declaration in `lib.config.json`, storage on-chain, and recursive installation with semantic version constraint satisfaction.
* Connects to user-configured EVM networks (e.g., local Ganache, public testnets like Sepolia) via RPC URLs.
* Uses a bundled ABI to interact with the `LibraryRegistry` smart contract.
* User-friendly interactive prompts and informative terminal output.

## Architecture Reminder

TacoPKM CLI interacts with:
1.  A **`LibraryRegistry` Smart Contract:** Already deployed on an EVM blockchain. This contract holds library metadata, ownership, access control, and version information.
2.  **IPFS:** For storing and retrieving library code archives (.tar.gz).
The CLI itself does not include the smart contract code or Hardhat development environment.

## Prerequisites

Before using TacoPKM CLI, ensure you have the following installed:
* Node.js (v18+ or v20+ recommended) & npm
* IPFS Kubo (running as a daemon: `ipfs daemon`) OR IPFS Desktop. The IPFS API server must be accessible.
* Git (for cloning this repository).
* Access to an Ethereum JSON-RPC endpoint for the network you intend to use (e.g., a local Ganache instance, or a public Sepolia node URL from Infura/Alchemy).
* An Ethereum wallet/account with some native currency (e.g., ETH for Ganache, SepoliaETH for Sepolia) to pay for transaction gas fees.

## Installation & Setup

### 1. Clone the Repository
```bash
git clone --branch license-fee --single-branch https://github.com/Doner357/TacoPKM-CLI.git
cd TacoPKM-CLI
````

### 2\. Install Dependencies

Install the CLI's Node.js dependencies:

```bash
npm install
```

### 3\. Make the CLI Command Available

To use the `tpkm` command globally from any directory during development or local use:

```bash
npm link
```

After this, you should be able to run `tpkm --version`.

### 4\. IPFS Node Setup

Ensure your IPFS daemon is running and its API server is accessible. The CLI will default to `http://127.0.0.1:5001/api/v0` for the IPFS API.

### 5\. Environment Variables (Optional but Recommended)

For a smoother experience, especially if your IPFS node or desired network configuration differs from defaults, or to avoid repeated password entry:

  * Create a `.env` file in the `cli/` directory (i.e., `TacoPKM-CLI/cli/.env`).

  * Add relevant lines:

    ```dotenv
    # TacoPKM-CLI/cli/.env

    # Overrides the default IPFS API URL
    IPFS_API_URL="http://your_ipfs_api_url:port/api/v0"

    # Can be used as a fallback if no active network is set via 'tpkm config'
    RPC_URL="http://your_ethereum_rpc_url:port"
    CONTRACT_ADDRESS="0xYourLibraryRegistryContractAddress"

    # To bypass interactive password prompts for wallet operations (less secure)
    # TPKM_WALLET_PASSWORD="yourWalletPassword"
    ```

    **Priority for Network Config:**

    1.  Active profile in `~/.tacopkm/networks.json` (managed by `tpkm config`).
    2.  `RPC_URL` and `CONTRACT_ADDRESS` from `cli/.env`.
    3.  If neither is found, network-dependent commands will fail with guidance.

    **Priority for IPFS API URL:**

    1.  `IPFS_API_URL` from `cli/.env`.
    2.  Default: `http://127.0.0.1:5001/api/v0`.

### 6\. CLI Wallet Setup

TacoPKM CLI uses an encrypted JSON keystore to manage the Ethereum wallet for signing transactions. This keystore is stored by default in `~/.tacopkm/keystore.json` (where `~` is your user home directory).

  * **Create a new wallet:**

    ```bash
    tpkm wallet create
    ```

    Follow the prompts to set a strong password. The new wallet's public address will be displayed. **Save your password securely and consider backing up the `keystore.json` file.**

  * **Import an existing private key:**

    ```bash
    tpkm wallet import <your_existing_private_key_hex_string>
    ```

    You'll be prompted for a password to encrypt this imported key. This will overwrite any existing keystore.

Ensure this wallet has funds on the blockchain network you intend to use.

### 7\. Network Configuration

The CLI needs to know which blockchain network to connect to and the address of the deployed `LibraryRegistry` smart contract on that network. This is managed using `tpkm config` commands, which store profiles in `~/.tacopkm/networks.json`.

  * **To configure a network:**
    You'll need the RPC URL of your network and the address where the `LibraryRegistry` contract is deployed.
    ```bash
    # Example for a local Ganache instance
    tpkm config add localhost --rpc [http://127.0.0.1:7545](http://127.0.0.1:7545) --contract <YOUR_LOCALHOST_CONTRACT_ADDRESS> --set-active

    # Example for a public Sepolia testnet instance
    # tpkm config add sepolia --rpc <YOUR_SEPOLIA_RPC_URL> --contract <YOUR_SEPOLIA_CONTRACT_ADDRESS>
    ```
  * If no network configuration is found (neither in `~/.tacopkm/networks.json` nor via `.env` variables), commands requiring network interaction will fail and guide you to use `tpkm config add`.

Use `tpkm config list` to see your configured networks and `tpkm config set-active <name>` to switch between them.

## Using the CLI (`tpkm`)

### General Usage

```bash
tpkm [command] [options]
tpkm --help # Shows all available commands
tpkm [command] --help # Shows help for a specific command
```

Commands requiring a transaction will prompt for your wallet password unless `TPKM_WALLET_PASSWORD` is set in `cli/.env`.

### Wallet Management

#### `tpkm wallet create`

Creates a new Ethereum wallet, encrypts it with a user-provided password (prompts if not given via `--password`), and stores it in `~/.tacopkm/keystore.json`. Prompts for overwrite if a keystore already exists.

  - **Options:**
      - `-p, --password <password>`: Password to encrypt the new wallet (for non-interactive use, less secure).

<!-- end list -->

```bash
tpkm wallet create
tpkm wallet create --password "yourSecretPassword"
```

#### `tpkm wallet import <privateKey>`

Imports an existing private key, encrypts it with a user-provided password (prompts if not given via `--password`), and saves it to `~/.tacopkm/keystore.json`, overwriting any existing wallet after confirmation.

  - **Arguments:** `<privateKey>` (hex string, `0x` prefix optional)
  - **Options:**
      - `-p, --password <password>`: Password to encrypt the imported wallet.

<!-- end list -->

```bash
tpkm wallet import 0x123abc...
tpkm wallet import 0x123abc... --password "yourSecretPassword"
```

#### `tpkm wallet address`

Displays the public address of the wallet currently stored in `~/.tacopkm/keystore.json`. Requires password decryption.

```bash
tpkm wallet address
```

#### `tpkm wallet balance`

Displays the ETH balance of the currently configured wallet on the active network. This command reads the public address from the keystore (without needing decryption for the address itself) and then queries the network.

```bash
tpkm wallet balance
```

### Network Configuration Management

Network profiles are stored in `~/.tacopkm/networks.json`.

#### `tpkm config add <name>`

Adds or updates a named network profile.

  - **Arguments:** `<name>` (profile name, e.g., "localhost", "sepolia\_dev")
  - **Options:**
      - `-r, --rpc <url>`: RPC URL for the Ethereum network.
      - `-c, --contract <address>`: Deployed `LibraryRegistry` smart contract address.
      - `-s, --set-active`: Set this network profile as the active one immediately after adding/updating.
  - **Example:**
    ```bash
    tpkm config add my_ganache --rpc [http://127.0.0.1:8545](http://127.0.0.1:8545) --contract 0x... --set-active
    tpkm config add sepolia_infura --rpc [https://sepolia.infura.io/v3/](https://sepolia.infura.io/v3/)<YOUR_ID> --contract 0x...
    ```
    If RPC or contract address are not provided as options, you will be prompted.

#### `tpkm config list` (or `ls`)

Lists all saved network configurations and indicates the active one.

```bash
tpkm config list
```

#### `tpkm config set-active <name>`

Sets a specified network profile as the active one for subsequent `tpkm` commands.

  - **Arguments:** `<name>` (name of the profile to activate)

<!-- end list -->

```bash
tpkm config set-active sepolia_infura
```

#### `tpkm config show [name]`

Displays details of a specific network profile. If `[name]` is omitted, shows the active profile.

  - **Arguments:** `[name]` (optional profile name)

<!-- end list -->

```bash
tpkm config show sepolia_infura
tpkm config show # Shows active network details
```

#### `tpkm config remove <name>` (or `rm`)

Removes a saved network configuration profile. Prompts for confirmation.

  - **Arguments:** `<name>` (name of the profile to remove)

<!-- end list -->

```bash
tpkm config remove old_network
```

### Library Operations

#### `tpkm init`

Initializes a `lib.config.json` file in the current directory by prompting for necessary library details like name, version, description, and language. Prompts for overwrite if the file already exists.

```bash
tpkm init
```

#### `tpkm register <name>`

Registers a new library name on the TPKM smart contract registry of the active network. The calling wallet becomes the owner.

  - **Arguments:** `<name>` (unique library name; lowercase letters, numbers, hyphens, underscores, dots, \<=214 chars)
  - **Options:**
      - `-d, --description <text>`: Brief description of the library. (Default: "")
      - `-t, --tags <tags>`: Comma-separated tags for discoverability. (Default: "")
      - `-l, --language <language>`: Primary programming language. (Default: "")
      - `--private`: Register the library as private. (Default: false, i.e., public)
  - **Example:**
    ```bash
    tpkm register my-cool-lib -d "A cool library" -l javascript --tags "utils,arrays"
    tpkm register my-secret-project --private -l python
    ```

#### `tpkm list`

Lists all library names registered in the TPKM registry on the active network.

```bash
tpkm list
```

*(Note: This may be slow on networks with a very large number of registered libraries if the contract's `getAllLibraryNames()` function is inefficient).*

#### `tpkm info <libraryIdentifier>`

Fetches and displays information about a registered library or a specific version of it.

  - **Arguments:** `<libraryIdentifier>` (format: `"libraryName"` or `"libraryName@versionString"`)
  - **Options:**
      - `--versions`: List all published versions for the library (if only name is provided).
  - **Output includes:** Owner, description, language, tags, visibility (public/private), license status (fee, requirement), your wallet's access/license status, list of versions (if requested or no specific version given), and details for a specific version (IPFS hash, publisher, publish date, deprecation status, dependencies).
  - **Examples:**
    ```bash
    tpkm info my-cool-lib
    tpkm info my-cool-lib --versions
    tpkm info my-cool-lib@1.2.3
    ```

#### `tpkm publish <directory>`

Packages the library code from the specified directory (must contain `lib.config.json`), uploads the archive to IPFS, and then calls the smart contract to publish a new version record. Requires ownership of the library record.

  - **Arguments:** `<directory>` (path to the library's source directory)
  - **Options:**
      - `-v, --version <version>`: Version string (e.g., "1.0.0"). Overrides the version specified in `lib.config.json`.
  - **Details:**
      * Reads `name`, `version` (unless overridden), and `dependencies` from `lib.config.json`.
      * Verifies caller's ownership of the library name.
      * Creates a temporary `.tar.gz` archive.
      * Uploads archive to IPFS.
      * Submits transaction to `publishVersion` on the smart contract.
      * Cleans up the temporary archive.
  - **Example:**
    ```bash
    tpkm publish ./path/to/my-lib-project/
    tpkm publish . -v 1.1.0 # Publish from current directory, overriding version
    ```

#### `tpkm install <libraryIdentifier>`

Downloads a specific library version (and its dependencies recursively) from IPFS.

  - **Arguments:** `<libraryIdentifier>` (format: `"libraryName"` for latest stable, or `"libraryName@versionString"` for a specific version, e.g., "my-lib@1.0.0").
  - **Details:**
      * If only `libraryName` is provided, it attempts to resolve and install the latest stable version.
      * Resolves versions based on semantic versioning constraints.
      * Checks for version conflicts.
      * Performs access checks for the installer's wallet address against private/licensed libraries.
      * Extracts downloaded archives into `./tpkm_installed_libs/<libraryName>/<versionString>/` in the current working directory.
  - **Example:**
    ```bash
    tpkm install my-cool-lib@1.1.0
    tpkm install another-lib # Installs latest stable version of another-lib
    ```

#### `tpkm deprecate <libraryIdentifier>`

Marks a specific version of a library as deprecated in the smart contract registry. Requires library ownership. Prompts for confirmation.

  - **Arguments:** `<libraryIdentifier>` (format: `"libraryName@versionString"`)
  - **Example:**
    ```bash
    tpkm deprecate my-cool-lib@1.0.0
    ```

#### `tpkm authorize <libraryName> <userAddress>`

Grants a specific user address permission to access (e.g., download, view info of) a private library owned by the caller. Requires library ownership.

  - **Arguments:**
      - `<libraryName>`: The name of the private library.
      - `<userAddress>`: The Ethereum address of the user to grant access.
  - **Example:**
    ```bash
    tpkm authorize my-secret-project 0xUserAddressToGrantAccess
    ```

#### `tpkm revoke <libraryName> <userAddress>`

Revokes a previously granted access permission for a specific user address from a private library owned by the caller. Requires library ownership. Prompts for confirmation.

  - **Arguments:**
      - `<libraryName>`: The name of the private library.
      - `<userAddress>`: The Ethereum address of the user whose access is to be revoked.
  - **Example:**
    ```bash
    tpkm revoke my-secret-project 0xUserAddressWhoseAccessIsRevoked
    ```

#### `tpkm set-license <libraryName>`

Allows the owner of a library to set or update its licensing terms on the TPKM registry.

  - **Arguments:** `<libraryName>`
  - **Options:**
      - `-f, --fee <amount_with_unit>`: License fee (e.g., "0.01 eth", "10000 gwei", "0 eth" or "none"). If not provided, prompts with current fee as default.
      - `-r, --required <true_or_false>`: Whether a license is explicitly required (boolean: "true" or "false"). If not provided, prompts with current status as default.
  - **Details:**
      * Verifies caller is the library owner.
      * Private libraries cannot be set to `licenseRequired=true`.
      * A fee \> 0 with `licenseRequired=false` will issue a warning.
  - **Example:**
    ```bash
    tpkm set-license my-public-lib -f "0.05 eth" -r true
    tpkm set-license my-other-lib --fee none --required false
    ```

#### `tpkm purchase-license <libraryName>`

Allows users to purchase a lifetime access license for a public library that requires one.

  - **Arguments:** `<libraryName>`
  - **Options:**
      - `-a, --amount <amount_eth_or_gwei>`: Optional amount to send (e.g., "0.01 eth"). If not provided, the exact fee from the contract will be used. Overpayment might be refunded by the contract.
  - **Details:**
      * Verifies the library is public, requires a license, and the user doesn't already own one.
      * Ensures amount sent is not less than the required fee.
      * Prompts for confirmation before sending the transaction with the specified Ether value.
  - **Example:**
    ```bash
    tpkm purchase-license my-licensed-lib
    tpkm purchase-license another-licensed-lib -a "0.1 eth"
    ```

#### `tpkm delete <libraryName>`

**PERMANENTLY** deletes a registered library record from the TPKM smart contract.

  - **Arguments:** `<libraryName>`
  - **Restrictions:**
      * Caller must be the owner of the library record.
      * The library must have **NO published versions**.
  - **Process:** Involves strong warnings and a multi-step confirmation process (typing "yes" and then the library name exactly).
  - **Consequences:** This action is IRREVERSIBLE. It removes all metadata from the registry.
  - **Example:**
    ```bash
    tpkm delete my-mistakenly-registered-lib
    ```

### Registry Administration (Use with Extreme Caution)

#### `tpkm abandon-registry`

**EXTREMELY DANGEROUS AND IRREVERSIBLE ACTION\!** Transfers ownership of the `LibraryRegistry` smart contract itself (for the currently active network) to a specified burn address.

  - **Options:**
      - `--burn-address <address>`: The Ethereum address to transfer ownership to. (Default: `0x000000000000000000000000000000000000dEaD`)
  - **Restrictions:** Only the current contract owner (as per an Ownable pattern) can execute this.
  - **Process:** Displays severe warnings and requires a multi-step, explicit confirmation (confirming understanding, then typing a specific phrase including part of the contract address).
  - **Consequences:** Relinquishes all administrative control over this specific contract instance (e.g., pausing, upgrading, changing global fees) PERMANENTLY.
  - **Example (USE ON A TEST NETWORK FIRST\!):**
    ```bash
    tpkm abandon-registry
    tpkm abandon-registry --burn-address 0x0000000000000000000000000000000000000000
    ```

## Library Configuration File (`lib.config.json`)

To publish a library, you need a `lib.config.json` file in its root directory. Use `tpkm init` to generate a template.

**Fields:**

  - `name` (string, required): The name of the library. Must match a name you registered with `tpkm register` and own. Follows TPKM naming conventions (lowercase, numbers, hyphens, etc.).
  - `version` (string, required): The semantic version of this release (e.g., "1.0.0", "0.2.1-beta").
  - `description` (string, optional): A brief description of the library.
  - `language` (string, optional): Primary programming language (e.g., "javascript", "python", "solidity").
  - `dependencies` (object, optional): An object where keys are names of other TacoPKM libraries and values are their semantic version constraints.
    ```json
    {
      "dependencies": {
        "another-tpkm-lib": "^1.2.0",
        "common-utils-lib": "~0.5.2"
      }
    }
    ```

**Example `lib.config.json` (generated by `tpkm init` and then populated):**

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

The `tpkm init` command will create a file with `name`, `version`, and empty `description`, `language`, and `dependencies` (with a commented example).

## Development (Smart Contract)

This repository (`TacoPKM-CLI`) contains only the CLI tool. The `LibraryRegistry.sol` smart contract and its Hardhat development environment are expected to be in a separate repository (e.g., the main `TacoPKM` repository).

If you are developing the smart contract:

  * You will typically use `npx hardhat test` (or similar) in that project to run contract tests.
  * After making changes to the contract, recompile and redeploy it to your chosen network.
  * Copy the new ABI JSON file (usually found in a path like `artifacts/contracts/LibraryRegistry.sol/LibraryRegistry.json` in the contract project) into this CLI project's `cli/abi/LibraryRegistry.json` file.
  * Update the `CONTRACT_ADDRESS` in your `cli/.env` (for local testing) or update/add a network profile using `tpkm config add <name> --contract <NEW_ADDRESS>` for the relevant network.

## License

MIT
