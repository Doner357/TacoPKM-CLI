#!/usr/bin/env node
// cli/index.js
// Main entry point for the Taco Package Manager (TPKM) command-line interface.

// --- Default Public Network Configuration (Example: Sepolia) ---
// These constants provide fallback values if no user configuration is found or specified.
const DEFAULT_IPFS_API_URL = 'http://127.0.0.1:5001/api/v0'; // Default IPFS API endpoint (local node).

// --- Core Node.js Modules ---
const os = require('os'); // Provides operating system-related utility methods and properties (e.g., home directory).
const path = require('path'); // Provides utilities for working with file and directory paths.
const zlib = require('zlib'); // Provides compression and decompression functionalities (e.g., gzip for archives).
const { pipeline } = require('stream/promises'); // Utility for robustly piping streams together using async/await, ensuring proper error handling.

// --- Third-party CLI Utility Modules ---
const ora = require('ora'); // Displays elegant spinners in the terminal during long operations.
const Table = require('cli-table3'); // Creates nicely formatted tables for command-line output.
const { Command } = require('commander'); // Framework for building command-line interfaces (defining commands, options, parsing arguments).
const chalk = require('chalk'); // Adds color and styling to terminal output (using version 4 recommended).
const inquirer = require('inquirer'); // Creates interactive command-line prompts (e.g., for passwords, confirmations).

// --- Ethereum Interaction ---
const { ethers } = require('ethers'); // Comprehensive library for interacting with Ethereum blockchains (wallets, contracts, providers).

// --- File System & Archiving ---
const fs = require('fs-extra'); // Extends the native 'fs' module with additional methods like `ensureDirSync`.
const archiver = require('archiver'); // Library for creating archives (e.g., .tar.gz).
const tar = require('tar-fs'); // Stream-based library for packing and unpacking tar archives.

// --- Semantic Versioning ---
const semver = require('semver'); // Library for parsing and comparing semantic version strings (e.g., "1.2.3").

// --- Environment Variable Management ---
// Loads environment variables from a .env file located in the same directory as this script (__dirname) into process.env.
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// --- Configuration and Setup ---
const program = new Command(); // Initialize the main commander program instance.

// Keystore path configuration for local Ethereum wallet management.
// Defines where the encrypted wallet (keystore) is stored.
const keystoreDir = path.join(os.homedir(), '.tacopkm'); // Directory in the user's home folder (~/.tacopkm).
const keystorePath = path.join(keystoreDir, 'keystore.json'); // Full path to the keystore file (~/.tacopkm/keystore.json).

// --- Network Configuration File Path ---
// Defines where TPKM network profiles (RPC URLs, contract addresses) are stored.
const networkConfigDir = path.join(os.homedir(), '.tacopkm'); // Directory for network configuration (same as keystore).
const networkConfigPath = path.join(networkConfigDir, 'networks.json'); // Full path to the network configuration file (~/.tacopkm/networks.json).

// --- Ethers.js & IPFS Client Setup (Lazy Initialized) ---
// These clients are initialized only when needed ('on demand') to avoid unnecessary
// connections, allow for dynamic network switching based on configuration, and
// improve startup time.
let provider = null; // Ethers.js provider instance for read-only blockchain interaction (initialized by ensureNetworkClientsInitialized).
let registryAbi = null; // ABI (Application Binary Interface) for the LibraryRegistry smart contract (loaded once).
let contractReadOnly = null; // Read-only Ethers.js contract instance (initialized by ensureNetworkClientsInitialized).
let ipfs = null; // IPFS HTTP client instance (initialized by ensureNetworkClientsInitialized).

let networkClientsInitialized = false; // Flag to track if clients have been initialized for the current session.

// Variables to store details of the currently active network configuration.
let currentActiveNetworkName = 'unknown'; // Name of the active network profile (e.g., 'sepolia-public', 'custom (.env)').
let currentActiveContractAddress = 'unknown'; // Address of the LibraryRegistry contract being used.
let currentActiveRpcUrl = 'unknown'; // RPC URL being used.

// Writable contract instance and signer wallet are loaded only when a transaction needs to be signed
// (e.g., publishing, registering, deprecating).
let signerWallet = null; // Ethers.js Wallet instance connected to the provider (loaded by loadWalletAndConnect).
let writableContract = null; // Writable Ethers.js contract instance connected to the signer (loaded by loadWalletAndConnect).

// --- Network Config Helper Functions ---

/**
 * Loads the network configuration from the `networks.json` file in the user's TPKM directory.
 * Handles cases where the file doesn't exist or is corrupted.
 * @returns {object} The parsed network configuration object.
 * Structure: { activeNetwork: string | null, networks: { [name: string]: { rpcUrl: string, contractAddress: string } } }
 * Returns a default empty structure if loading fails.
 */
function loadNetworkConfig() {
    try {
        if (fs.existsSync(networkConfigPath)) {
            const fileContent = fs.readFileSync(networkConfigPath, 'utf8');
            return JSON.parse(fileContent);
        }
    } catch (error) {
        // Log a warning but don't crash; allow fallback to defaults or .env.
        console.warn(chalk.yellow(`Warning: Could not read or parse network config at ${networkConfigPath}. Using defaults or .env if available. Error: ${error.message}`));
    }
    // Return default structure if file doesn't exist or reading/parsing failed.
    return { activeNetwork: null, networks: {} };
}

/**
 * Saves the provided network configuration object to the `networks.json` file.
 * Ensures the target directory exists and pretty-prints the JSON output.
 * @param {object} config - The network configuration object to save (matching the structure from loadNetworkConfig).
 */
function saveNetworkConfig(config) {
    try {
        fs.ensureDirSync(networkConfigDir); // Create the ~/.tacopkm directory if it doesn't exist.
        fs.writeFileSync(networkConfigPath, JSON.stringify(config, null, 2), 'utf8'); // Write JSON with indentation.
    } catch (error) {
        console.error(chalk.red(`Error saving network config to ${networkConfigPath}:`), error.message);
        // Depending on severity, might consider exiting here.
    }
}

/**
 * Ensures that Ethereum provider, smart contract instances (read-only), and IPFS client are initialized.
 * This function establishes the connection settings for subsequent blockchain and IPFS operations.
 * It follows a priority order for configuration:
 * 1. Active network profile specified in `networks.json`.
 * 2. Environment variables (`RPC_URL`, `CONTRACT_ADDRESS`, `IPFS_API_URL`) in `cli/.env`.
 * 3. Hardcoded default public network settings (e.g., Sepolia).
 * It also handles loading the contract ABI and performs basic connectivity checks.
 * The process will exit if essential configuration (RPC, Contract Address, IPFS URL) cannot be determined
 * or if connections fail.
 * @throws Will exit the process (process.exit(1)) if critical configuration is missing or connections fail.
 */
async function ensureNetworkClientsInitialized() {
    // Avoid redundant initialization within the same execution context.
    if (networkClientsInitialized) return;

    // Load the contract ABI only once. Needed for creating contract instances.
    if (!registryAbi) {
        try {
             // Assumes ABI file is located relative to this script.
            registryAbi = require('./abi/LibraryRegistry.json').abi;
        } catch (abiError) {
            console.error(chalk.red(`Critical Error: Failed to load LibraryRegistry ABI from ./abi/LibraryRegistry.json. Ensure the file exists and is valid.`));
            console.error(chalk.red(`ABI Load Error: ${abiError.message}`));
            process.exit(1);
        }
    }

    const userConfig = loadNetworkConfig(); // Load ~/.tacopkm/networks.json

    let rpcToUse = null;
    let contractAddrToUse = null;
    let networkNameToUse = '';
    let sourceOfConfig = ''; // For logging where the config came from.

    // Priority 1: Active network profile from user's networks.json
    if (userConfig.activeNetwork && userConfig.networks[userConfig.activeNetwork]) {
        const activeProfile = userConfig.networks[userConfig.activeNetwork];
        // Basic validation of profile content.
        if (activeProfile.rpcUrl && activeProfile.contractAddress && ethers.isAddress(activeProfile.contractAddress)) {
            rpcToUse = activeProfile.rpcUrl;
            contractAddrToUse = activeProfile.contractAddress;
            networkNameToUse = userConfig.activeNetwork;
            sourceOfConfig = `active network profile "${networkNameToUse}" from ~/.tacopkm/networks.json`;
        } else {
             console.warn(chalk.yellow(`Warning: Active network profile "${userConfig.activeNetwork}" in networks.json is incomplete or invalid. Falling back...`));
        }
    }

    // Priority 2: Environment variables from cli/.env (acts as an override or alternative)
    if (!rpcToUse || !contractAddrToUse) {
        const envRpcUrl = process.env.RPC_URL;
        const envContractAddress = process.env.CONTRACT_ADDRESS;
        if (envRpcUrl && envContractAddress && ethers.isAddress(envContractAddress)) {
            rpcToUse = envRpcUrl;
            contractAddrToUse = envContractAddress;
            networkNameToUse = 'custom (.env)';
            sourceOfConfig = 'network configuration from cli/.env';
        }
    }

    // Priority 3: NO HARDCODED DEFAULT NETWORK. Error out if still no config.
    if (!rpcToUse || !contractAddrToUse) {
        console.error(chalk.red('Error: No usable blockchain network configuration found.'));
        console.log(chalk.yellow('Before using network-dependent commands, please configure a network:'));
        console.log(chalk.yellow('  1. Add a network profile: ' + chalk.bold(`tpkm config add <profile_name> --rpc <RPC_URL> --contract <CONTRACT_ADDRESS>`)));
        console.log(chalk.yellow('  2. Set it as active:     ' + chalk.bold(`tpkm config set-active <profile_name>`)));
        console.log(chalk.yellow('Alternatively, you can set RPC_URL and CONTRACT_ADDRESS in the cli/.env file.'));
        process.exit(1); // Exit if no network is configured.
    }

    // Determine IPFS API URL (Priority: .env > Default)
    const envIpfsApiUrl = process.env.IPFS_API_URL;
    const ipfsApiUrlToUse = envIpfsApiUrl || DEFAULT_IPFS_API_URL;
    const ipfsSource = envIpfsApiUrl ? 'cli/.env' : 'default';

    // Final validation: Ensure we have all necessary URLs/addresses before proceeding.
    if (!rpcToUse || !contractAddrToUse || !ipfsApiUrlToUse) {
        console.error(chalk.red('Critical Error: Could not determine valid RPC_URL, CONTRACT_ADDRESS, or IPFS_API_URL.'));
        console.error(chalk.yellow('Please configure network settings using "tpkm config add" or ensure values are set in cli/.env.'));
        process.exit(1);
    }

    console.log(chalk.blue(`Using configuration from: ${sourceOfConfig}`));

    // Initialize Ethers.js provider and read-only contract instance.
    try {
        provider = new ethers.JsonRpcProvider(rpcToUse);
        contractReadOnly = new ethers.Contract(contractAddrToUse, registryAbi, provider);

        // Verify contract connection by trying to get its address (also confirms RPC is reachable).
        // Use the verified address as the definitive current address.
        currentActiveContractAddress = await contractReadOnly.getAddress();
    } catch (ethError) {
        console.error(chalk.red(`Failed to connect to RPC "${rpcToUse}" or initialize contract at "${contractAddrToUse}".`));
        console.error(chalk.red(`Error: ${ethError.message}`));
        process.exit(1);
    }

    // Update global variables with the final, validated settings.
    currentActiveNetworkName = networkNameToUse;
    currentActiveRpcUrl = rpcToUse;

    // Initialize IPFS client and test connection.
    try {
        // Dynamically require ipfs-http-client only when needed.
        const { create: createIpfsClient } = require('ipfs-http-client');
        ipfs = createIpfsClient({ url: ipfsApiUrlToUse });
        // Perform a simple check to ensure the IPFS daemon is reachable.
        await ipfs.version(); // Throws an error if connection fails.
        console.log(chalk.cyan(`Connected to IPFS API: ${ipfsApiUrlToUse} (Source: ${ipfsSource})`));
    } catch(ipfsError) {
        console.error(chalk.red(`Failed to connect to IPFS API at ${ipfsApiUrlToUse}.`));
        console.error(chalk.yellow(`Please ensure your IPFS daemon is running and the API server is enabled/accessible.`));
        console.error(chalk.red(`IPFS Connection Error: ${ipfsError.message}`));
        // Most TPKM operations require IPFS, so exit.
        process.exit(1);
    }

    // Log the final effective settings being used.
    console.log(chalk.blue(`Effective RPC URL: ${currentActiveRpcUrl}`));
    console.log(chalk.blue(`Effective Contract Address: ${currentActiveContractAddress}`));

    networkClientsInitialized = true; // Mark initialization as complete.
}


// --- Wallet Management Helper Functions ---

/**
 * Retrieves the public Ethereum address from the local keystore file (~/.tacopkm/keystore.json).
 * This function reads the address directly from the JSON structure without requiring decryption.
 * @returns {Promise<string|null>} The checksummed public address if the keystore is found and valid, otherwise null.
 * Logs appropriate error/guidance messages to the console on failure.
 */
async function getPublicAddressFromKeystore() {
    if (!fs.existsSync(keystorePath)) {
        console.error(chalk.red(`No wallet keystore found at ${keystorePath}.`));
        console.log(chalk.yellow(`Use "tpkm wallet create" or "tpkm wallet import <privateKey>"`));
        return null;
    }
    try {
        const keystoreJson = fs.readFileSync(keystorePath, 'utf8');
        const walletData = JSON.parse(keystoreJson); // Keystore file is expected to be JSON.
        if (walletData && walletData.address) {
            // Use ethers.getAddress() to ensure checksum format, which is standard practice.
            return ethers.getAddress(walletData.address);
        } else {
            console.error(chalk.red('Keystore file is corrupted or missing the address field.'));
            return null;
        }
    } catch (error) {
        console.error(chalk.red(`Error reading or parsing keystore file at ${keystorePath}:`), error.message);
        return null;
    }
}

/**
 * Loads the encrypted wallet from the keystore file, decrypts it using a password,
 * connects it to the currently configured Ethereum provider, and creates instances
 * of the signer wallet and a writable contract.
 * Handles password input via interactive prompt or the TPKM_WALLET_PASSWORD environment variable.
 * Ensures network clients are initialized before connecting the wallet.
 * Caches the loaded wallet and contract instance for the current session to avoid repeated decryption.
 * @param {boolean} [promptForPassword=true] - If true, prompts the user interactively for the password.
 * If false, attempts to use the TPKM_WALLET_PASSWORD environment variable.
 * @returns {Promise<{wallet: ethers.Wallet, contract: ethers.Contract}>} An object containing the initialized signer wallet
 * and the writable contract instance.
 * @throws Will exit the process (process.exit(1)) if keystore is not found, decryption fails (e.g., wrong password),
 * password is required but not provided, or network initialization/connection fails.
 */
async function loadWalletAndConnect(promptForPassword = true) {
    // Return cached instances if they were already loaded in this CLI execution.
    if (signerWallet && writableContract) {
        return { wallet: signerWallet, contract: writableContract };
    }

    // 1. Check for keystore existence.
    if (!fs.existsSync(keystorePath)) {
        console.error(chalk.red(`No wallet keystore found at ${keystorePath}.`));
        console.log(chalk.yellow(`Use "tpkm wallet create" or "tpkm wallet import <privateKey>"`));
        process.exit(1);
    }

    // 2. Read the encrypted keystore JSON.
    let keystoreJson;
    try {
        keystoreJson = fs.readFileSync(keystorePath, 'utf8');
    } catch (readError) {
         console.error(chalk.red(`Error reading keystore file at ${keystorePath}:`), readError.message);
         process.exit(1);
    }

    // 3. Obtain the decryption password.
    let password = '';
    if (promptForPassword) {
        const answers = await inquirer.prompt([
            {
                type: 'password',
                name: 'password',
                message: 'Enter wallet password to decrypt keystore:',
                mask: '*', // Mask password input in the terminal.
            }
        ]);
        password = answers.password;
        if (!password) { // User likely just pressed Enter.
             console.error(chalk.red('Password cannot be empty. Aborting.'));
             process.exit(1);
        }
    } else if (process.env.TPKM_WALLET_PASSWORD) {
        password = process.env.TPKM_WALLET_PASSWORD;
        console.log(chalk.gray('Using password from TPKM_WALLET_PASSWORD environment variable.'));
    } else {
        // Password needed but not provided via prompt or env var.
        console.error(chalk.red('Password required for wallet operation.'));
        console.error(chalk.yellow('Provide password via interactive prompt or set the TPKM_WALLET_PASSWORD environment variable.'));
        process.exit(1);
    }

    // 4. Decrypt the wallet using the password and keystore JSON.
    let decryptedWalletBase; // The raw Wallet object before connecting to a provider.
    const decryptSpinner = ora({ text: 'Decrypting wallet...', color: 'yellow' }).start();
    try {
        decryptedWalletBase = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
        decryptSpinner.succeed(chalk.blue(`Wallet decrypted. Address: ${decryptedWalletBase.address}`));
    } catch (error) {
        // Common cause: incorrect password.
        decryptSpinner.fail(chalk.red('Failed to decrypt wallet. Incorrect password or corrupted keystore file.'));
        if (process.env.DEBUG) console.error(error); // Show full error details in debug mode.
        process.exit(1);
    }

    // 5. Ensure network clients (provider, read-only contract, ABI) are ready.
    // This needs to happen *after* successful decryption but *before* connecting the wallet.
    await ensureNetworkClientsInitialized();

    // 6. Connect the decrypted wallet to the provider and create a writable contract instance.
    try {
        // `provider` is guaranteed to be initialized by `ensureNetworkClientsInitialized`.
        signerWallet = decryptedWalletBase.connect(provider);

        // Create writable contract instance using the address from the (potentially already initialized)
        // read-only instance, the loaded ABI, and the newly connected signer.
        // `currentActiveContractAddress` and `registryAbi` are set by `ensureNetworkClientsInitialized`.
        writableContract = new ethers.Contract(currentActiveContractAddress, registryAbi, signerWallet);

        console.log(chalk.blue(`Wallet connected to network "${currentActiveNetworkName}". Ready to sign transactions.`));

        // Cache the instances for potential reuse in this session.
        return { wallet: signerWallet, contract: writableContract };
    } catch (connectError) {
        // Handle errors during the connection phase (e.g., provider issues after initialization).
        console.error(chalk.red('Failed to connect wallet to provider or create writable contract instance:'), connectError.message);
        if (process.env.DEBUG) console.error(connectError);
        process.exit(1);
    }
}


// --- Archiving and IPFS Helper Functions ---

/**
 * Archives the contents of a specified directory into a gzipped tarball (.tar.gz).
 * @param {string} sourceDir - The absolute or relative path to the directory to archive.
 * @param {string} outputFilePath - The absolute or relative path where the resulting .tar.gz file should be saved.
 * @returns {Promise<void>} A promise that resolves when archiving is successfully completed, or rejects on error.
 */
function archiveDirectory(sourceDir, outputFilePath) {
    return new Promise((resolve, reject) => {
        // Create a writable stream to the target archive file path.
        const output = fs.createWriteStream(outputFilePath);
        // Initialize the archiver in 'tar' mode with gzip compression.
        const archive = archiver('tar', {
            gzip: true,
            zlib: { level: 9 } // Set compression level (optional, 9 is highest).
        });

        // Event listener for when the output stream is closed (archive is fully written).
        output.on('close', () => {
            console.log(chalk.gray(`Archive created: ${outputFilePath} (${archive.pointer()} total bytes)`));
            resolve(); // Signal success.
        });

        // Event listener for non-critical warnings from the archiver.
        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') {
                // Example: A symbolic link points to a non-existent file. Log it but continue.
                console.warn(chalk.yellow('Archiver warning:'), err);
            } else {
                // Treat other warnings as potential errors.
                reject(err);
            }
        });

        // Event listener for critical errors during archiving.
        archive.on('error', (err) => {
            reject(err); // Signal failure.
        });

        // Pipe the archive data to the output file stream.
        archive.pipe(output);

        // Add the source directory's contents to the archive root.
        // The second argument `false` ensures contents are at the root, not inside a folder named after sourceDir.
        archive.directory(sourceDir, false);

        // Finalize the archive - no more files can be added. This triggers the 'close' event on the output stream once done.
        archive.finalize();
    });
}

/**
 * Uploads a file (typically an archive) to the configured IPFS node.
 * @param {string} filePath - The path to the local file to upload.
 * @returns {Promise<string>} The IPFS Content Identifier (CID) string of the uploaded file.
 * @throws Will throw an error if the IPFS client is not initialized or the upload fails.
 */
async function uploadToIpfs(filePath) {
    // Ensure IPFS client is ready (should have been called by the command handler).
    if (!ipfs) {
         throw new Error("IPFS client not initialized. Call ensureNetworkClientsInitialized first.");
    }

    let fileContent;
    try {
        fileContent = fs.readFileSync(filePath); // Read the entire file into a buffer.
    } catch (readError) {
        console.error(chalk.red(`Error reading file for IPFS upload: ${filePath}`), readError.message);
        throw readError; // Propagate the error.
    }

    try {
        // Use the initialized ipfs client to add the file content.
        const result = await ipfs.add(fileContent);
        const cidString = result.cid.toString();
        console.log(chalk.gray(`Uploaded to IPFS. CID: ${cidString}`));
        return cidString; // Return the CID.
    } catch (error) {
        console.error(chalk.red('IPFS upload failed:'), error.message);
        // Log more details if helpful, e.g., check IPFS daemon status.
        console.error(chalk.yellow('Ensure your IPFS daemon is running and accessible at the configured API URL.'));
        throw error; // Re-throw to be handled by the calling command.
    }
}

/**
 * Downloads a gzipped tarball from IPFS using its CID and extracts its contents to a target directory.
 * Uses streams for efficiency, especially with large files.
 * @param {string} libraryName - Name of the library being downloaded (for logging purposes).
 * @param {string} versionString - Version of the library being downloaded (for logging).
 * @param {string} ipfsHash - The IPFS CID (hash) of the .tar.gz archive to download.
 * @param {string} targetPath - The directory path where the archive contents should be extracted.
 * @returns {Promise<void>} A promise that resolves upon successful download and extraction, or rejects on error.
 * @throws Will throw an error if the IPFS client is not initialized, download fails, or extraction fails.
 */
async function downloadAndExtract(libraryName, versionString, ipfsHash, targetPath) {
    // Ensure IPFS client is ready.
    if (!ipfs) {
         throw new Error("IPFS client not initialized. Call ensureNetworkClientsInitialized first.");
    }

    const downloadSpinner = ora({
        text: `Downloading ${libraryName}@${versionString} from IPFS (CID: ${ipfsHash.substring(0, 10)}...)`,
        color: 'yellow'
    }).start();

    try {
        // Ensure the target directory exists, creating intermediate directories if necessary.
        fs.mkdirSync(targetPath, { recursive: true });

        // Create the necessary streams:
        // 1. Source: Stream data directly from IPFS using `ipfs.cat(CID)`.
        const sourceStream = ipfs.cat(ipfsHash);
        // 2. Decompressor: Stream to handle gzip decompression.
        const gunzip = zlib.createGunzip();
        // 3. Extractor: Stream to handle tar extraction into the target directory.
        const extract = tar.extract(targetPath);

        // Use stream.pipeline for robust error handling and proper stream cleanup.
        // It connects source -> gunzip -> extract.
        await pipeline(sourceStream, gunzip, extract);

        downloadSpinner.succeed(chalk.green(`  -> Extracted ${libraryName}@${versionString} to ${targetPath}`));
    } catch (error) {
        downloadSpinner.fail(chalk.red(`  -> Failed to download or extract ${libraryName}@${versionString} from IPFS CID ${ipfsHash}`));
        console.error(chalk.red(`  -> Error: ${error.message}`));
        // Check for common IPFS errors like 'dag node not found'.
        if (error.message && error.message.includes('dag node not found')) {
             console.error(chalk.yellow(`  -> The content for CID ${ipfsHash} might not be available on the IPFS network or pinned.`));
        }
        throw error; // Re-throw to allow the calling function (e.g., install) to handle the failure.
    }
}

/**
 * Recursively processes the installation of a library and its dependencies.
 * It resolves the appropriate version based on constraints, checks for version conflicts,
 * downloads the library archive from IPFS, extracts it, reads its dependencies,
 * and then recursively calls itself for each sub-dependency.
 * Uses a map to track already resolved packages to prevent infinite loops and redundant downloads.
 *
 * @param {string} targetName - The name of the library to install.
 * @param {string} targetConstraint - The semantic version constraint (e.g., "^1.0.0", "1.2.3", ">=2.0.0 <3.0.0").
 * @param {Map<string, string>} resolvedMap - A Map where keys are library names and values are the exact resolved versions
 * already being installed or previously installed in this run. Used to detect
 * cycles and ensure version consistency.
 * @param {string} installRoot - The root directory where all libraries will be installed (e.g., `tpkm_installed_libs`).
 * Libraries are typically placed in `installRoot/<libraryName>/<versionString>`.
 * @returns {Promise<void>} A promise that resolves when the library and its dependencies (if any) are processed,
 * or rejects if an error occurs (e.g., version conflict, package not found, download failure).
 * @throws Will throw an Error for critical issues like version conflicts, library/version not found in the registry,
 * or IPFS download/extraction failures.
 */
async function processInstallation(targetName, targetConstraint, resolvedMap, installRoot) {
    console.log(chalk.blue(`Processing dependency: ${targetName}@${targetConstraint}`));

    // 1. Check if a version of this package is already resolved/installed in this run.
    if (resolvedMap.has(targetName)) {
        const installedVersion = resolvedMap.get(targetName);
        // Check if the already resolved version satisfies the current constraint.
        if (semver.satisfies(installedVersion, targetConstraint)) {
            console.log(chalk.gray(`  -> ${targetName}@${installedVersion} already resolved and satisfies ${targetConstraint}. Skipping.`));
            return; // Requirement met by existing resolved version.
        } else {
            // Conflict: Another part of the dependency tree requires a version incompatible with the one already resolved.
            throw new Error(chalk.red(`Version conflict for "${targetName}": `) +
                            `Already resolved version ${chalk.yellow(installedVersion)} does not satisfy constraint ${chalk.yellow(targetConstraint)}.` +
                            ` Check your dependency tree.`);
        }
    }

    // 2. Fetch available versions for the target library from the smart contract.
    let availableVersions;
    const fetchVersionsSpinner = ora({ text: `  -> Fetching available versions for ${targetName}...`, color: 'gray' }).start();
    try {
        // Ensure read-only contract client is ready.
        if (!contractReadOnly) throw new Error("Read-only contract client not initialized.");
        availableVersions = await contractReadOnly.getVersionNumbers(targetName);

        if (!availableVersions || availableVersions.length === 0) {
             fetchVersionsSpinner.fail();
            throw new Error(`Library "${targetName}" not found or has no published versions in the registry.`);
        }
         fetchVersionsSpinner.succeed(chalk.gray(`  -> Found versions for ${targetName}: [${availableVersions.join(', ')}]`));
    } catch (error) {
        fetchVersionsSpinner.fail();
        // Use getRevertReason for potentially contract-specific errors.
        throw new Error(`Failed to fetch available versions for "${targetName}": ${getRevertReason(error)}`);
    }

    // 3. Determine the best version satisfying the constraint using semantic versioning rules.
    // `semver.maxSatisfying` finds the highest stable version that matches the constraint.
    const versionToInstall = semver.maxSatisfying(availableVersions, targetConstraint);
    if (!versionToInstall) {
        throw new Error(`No version found for "${targetName}" that satisfies constraint "${targetConstraint}". ` +
                        `Available versions: ${availableVersions.join(', ')}.`);
    }
    console.log(chalk.gray(`  -> Resolved ${targetName}@${targetConstraint} to version ${chalk.cyan(versionToInstall)}`));

    // 4. Mark this package and resolved version in the map BEFORE fetching details or downloading.
    // This prevents infinite loops in case of circular dependencies.
    resolvedMap.set(targetName, versionToInstall);

    // 5. Fetch detailed information (IPFS hash, dependencies) for the chosen version from the contract.
    let versionData;
    let ipfsHash;
    let subDependencies = []; // Initialize as empty array.
     const fetchInfoSpinner = ora({ text: `  -> Fetching info for ${targetName}@${versionToInstall}...`, color: 'gray' }).start();
    try {
        if (!contractReadOnly) throw new Error("Read-only contract client not initialized.");
        // Assumes getVersionInfo returns: [ipfsHash, publisher, timestamp, deprecated, dependencies]
        // where dependencies is an array of { name: string, constraint: string } structs.
        versionData = await contractReadOnly.getVersionInfo(targetName, versionToInstall);

        ipfsHash = versionData[0];
        const isDeprecated = versionData[3];
        // Ensure dependencies array exists, default to empty if not present or null.
        subDependencies = versionData[4] || [];

        fetchInfoSpinner.succeed(chalk.gray(`  -> Info received for ${targetName}@${versionToInstall}.`));

        // Validate required data.
        if (!ipfsHash || ipfsHash.trim() === '' || ipfsHash.startsWith('0x0000')) { // Check for empty or placeholder hash.
             resolvedMap.delete(targetName); // Backtrack: remove from resolved map if info is invalid.
            throw new Error(`Version ${versionToInstall} of "${targetName}" has an invalid or missing IPFS Hash in the registry.`);
        }
        if (isDeprecated) {
            console.warn(chalk.yellow(`  -> Warning: Installing deprecated version ${targetName}@${versionToInstall}. Consider using a newer version if available.`));
        }

    } catch (error) {
         fetchInfoSpinner.fail();
        resolvedMap.delete(targetName); // Backtrack: remove from resolved map if info fetching fails.
        throw new Error(`Failed to get version info for ${targetName}@${versionToInstall}: ${getRevertReason(error)}`);
    }

    // 6. Define the target path for extraction.
    // Example: ./tpkm_installed_libs/my-lib/1.2.3/
    const targetPath = path.join(installRoot, targetName, versionToInstall);

    // 7. Download the archive from IPFS and extract it to the target path.
    // `downloadAndExtract` handles the spinner and stream pipeline internally.
    await downloadAndExtract(targetName, versionToInstall, ipfsHash, targetPath);

    // 8. Recursively process sub-dependencies.
    if (subDependencies.length > 0) {
        console.log(chalk.blue(`  -> Processing ${subDependencies.length} sub-dependencies for ${targetName}@${versionToInstall}...`));
        for (const subDep of subDependencies) {
            // Here, you would typically perform access checks if the sub-dependency might be private.
            // This example assumes dependencies are public or access is implicitly handled by the contract logic
            // (e.g., getVersionInfo might fail if the caller doesn't have access to a private dependency's details).
            // A more robust implementation might explicitly call `contractReadOnly.hasAccess(subDep.name, callerAddress)` here.

            // Recursive call for the sub-dependency.
            await processInstallation(subDep.name, subDep.constraint, resolvedMap, installRoot);
        }
        console.log(chalk.blue(`  -> Finished processing sub-dependencies for ${targetName}@${versionToInstall}.`));
    } else {
         console.log(chalk.gray(`  -> ${targetName}@${versionToInstall} has no sub-dependencies.`));
    }
}


// --- Error Handling Helper ---

/**
 * Attempts to extract a more human-readable revert reason from an Ethereum transaction error object,
 * especially from errors returned by `ethers.js` contract calls.
 * It checks various properties where revert reasons might be stored and maps known
 * contract-specific error strings (like those from LibraryRegistry.sol) to user-friendly messages.
 *
 * @param {Error | any} error - The error object caught from an ethers.js call or other operation.
 * @returns {string} A user-friendly error message, the decoded revert reason, or a generic error message
 * if a specific reason cannot be reliably extracted.
 */
function getRevertReason(error) {
    let specificReason = null;

    // Ensure error is an object before accessing properties.
    if (!error || typeof error !== 'object') {
        return String(error) || "An unknown error occurred.";
    }

    // Strategy 1: Ethers v6+ standard `error.reason` (most common for simple reverts).
    if (typeof error.reason === 'string') {
        specificReason = error.reason;
    }
    // Strategy 2: Check `error.revert.args` (common in older ethers or specific frameworks).
    else if (error.revert && Array.isArray(error.revert.args) && error.revert.args.length > 0 && typeof error.revert.args[0] === 'string') {
        specificReason = error.revert.args[0];
    }
    // Strategy 3: Attempt to parse `error.data` using the contract ABI (for custom errors or requires).
    // Requires `registryAbi` to be loaded.
    else if (error.data && registryAbi) {
        try {
            const iface = new ethers.Interface(registryAbi);
            const parsedError = iface.parseError(error.data);
            if (parsedError) {
                // Handle standard `require` revert: Error(string)
                if (parsedError.name === "Error" && parsedError.args && typeof parsedError.args[0] === 'string') {
                    specificReason = parsedError.args[0];
                }
                // Handle custom errors: CustomErrorName(arg1, arg2)
                else {
                    specificReason = `${parsedError.name}(${parsedError.args.join(', ')})`;
                }
            }
        } catch (parseE) {
            // Ignore ABI parsing errors if `error.data` doesn't match a known error signature.
            if (process.env.DEBUG) console.warn(chalk.yellow("Could not parse error data using ABI:"), parseE.message);
        }
    }
     // Strategy 4: Look for error message within nested 'error' objects (sometimes seen with provider errors)
    else if (error.error && typeof error.error.message === 'string') {
         specificReason = error.error.message;
         // Often includes prefixes like "execution reverted: ", try to clean it up.
         if (specificReason.startsWith('execution reverted: ')) {
             specificReason = specificReason.substring('execution reverted: '.length);
         }
    }

    // Fallback to the main error message if no specific reason was extracted.
    let displayMessage = specificReason || error.message || "An unknown transaction error occurred.";

    // Map known LibraryRegistry contract revert strings (or parts of them) to friendlier messages.
    // Use the most specific reason found, or the full message for matching.
    const reasonToMatch = (specificReason || error.message || "").toLowerCase(); // Case-insensitive matching is safer.

    // --- LibraryRegistry Specific Error Mappings ---
    if (reasonToMatch.includes('libraryregistry: library does not exist')) {
        displayMessage = `Library not found in the registry. Check the spelling or register it first.`;
    } else if (reasonToMatch.includes('libraryregistry: version does not exist')) {
        displayMessage = `Version not found for this library. Use 'tpkm info <libraryName> --versions' to list available versions.`;
    } else if (reasonToMatch.includes('libraryregistry: caller is not the owner')) {
        displayMessage = `Permission Denied: Your wallet address is not the owner of this library or record.`;
    } else if (reasonToMatch.includes('libraryregistry: library name already exists')) {
        displayMessage = `Library name is already registered. Please choose a unique name.`;
    } else if (reasonToMatch.includes('libraryregistry: version already exists')) {
        displayMessage = `This version has already been published for this library. Please increment the version number.`;
    } else if (reasonToMatch.includes('libraryregistry: ipfs hash cannot be empty')) {
        displayMessage = `The IPFS hash cannot be empty. Ensure the package was uploaded to IPFS correctly before publishing.`;
    } else if (reasonToMatch.includes('libraryregistry: library is not private')) {
        displayMessage = `Operation Failed: This action is only applicable to private libraries, but the target library is public.`;
    } else if (reasonToMatch.includes('libraryregistry: invalid user address')) {
        displayMessage = `Invalid user address provided (e.g., it might be the zero address 0x0...).`;
    } else if (reasonToMatch.includes('libraryregistry: cannot delete library with published versions')) {
        displayMessage = `Deletion Failed: Cannot delete a library that still has published versions. Deprecate or manage versions first.`;
    } else if (reasonToMatch.includes('libraryregistry: user not authorized')) {
        displayMessage = `Access Denied: The specified user is not authorized to access this private library.`;
    } else if (reasonToMatch.includes('libraryregistry: user already authorized')) {
         displayMessage = `User is already authorized for this library. No action needed.`;
    } else if (reasonToMatch.includes('libraryregistry: cannot authorize owner')) {
         displayMessage = `Cannot explicitly authorize the library owner; owners always have access.`;
    } else if (reasonToMatch.includes('libraryregistry: cannot revoke owner')) {
         displayMessage = `Cannot revoke access for the library owner.`;
    }
    // --- End LibraryRegistry Specific ---

    // --- General Ethereum / Provider Error Mappings ---
    if (reasonToMatch.includes('insufficient funds')) {
        displayMessage = `Insufficient funds in your wallet to pay for the transaction gas fees.`;
    } else if (reasonToMatch.includes('nonce too low') || reasonToMatch.includes('replacement transaction underpriced')) {
        displayMessage = `Nonce error or transaction underpriced. Try the operation again, possibly with a higher gas price if manually set.`;
    } else if (reasonToMatch.includes('user denied transaction signature')) {
        displayMessage = `Transaction was rejected or cancelled by the user in their wallet software.`;
    }

    // --- IPFS Specific Error Mappings (from download/upload helpers) ---
    if (error.code === 'ERR_BAD_REQUEST' && reasonToMatch.includes('dag node not found')) {
        displayMessage = `IPFS content not found (DAG node not found). The requested CID may not be available or pinned on the network.`;
    }

    // Final cleanup: If the message is still very technical or an object, return the most specific string part.
    if (typeof displayMessage !== 'string') {
        return specificReason || error.message || "Transaction reverted or failed with an unspecified error.";
    }
    // Remove common prefixes if they weren't caught earlier.
    if (displayMessage.startsWith('execution reverted: ')) {
        displayMessage = displayMessage.substring('execution reverted: '.length);
    }
    if (displayMessage.startsWith('Error: ')) {
         displayMessage = displayMessage.substring('Error: '.length);
    }

    return displayMessage.trim(); // Return the cleaned-up, user-friendly message.
}


// =============================================================================
// --- CLI Command Definitions ---
// =============================================================================

program
    .name('tpkm')
    .description('Taco Package Manager CLI - A decentralized package manager using IPFS and Ethereum.')
    .version('0.1.0'); // Update version as the tool evolves.

// --- Config Subcommands (tpkm config ...) ---
// Manages network configuration profiles stored in ~/.tacopkm/networks.json.
const configCommand = program.command('config')
    .description('Manage TPKM network configurations (RPC URL, Contract Address).');

/**
 * Command: tpkm config add <name>
 * Adds or updates a named network profile (RPC URL, Contract Address).
 */
configCommand
    .command('add <name>')
    .description('Add or update a network configuration profile.')
    .option('-r, --rpc <url>', 'RPC URL for the network (e.g., https://...)')
    .option('-c, --contract <address>', 'Deployed LibraryRegistry contract address on this network (e.g., 0x...)')
    .option('-s, --set-active', 'Set this network as the active one after adding/updating')
    .action(async (name, options) => {
        let { rpc: rpcUrlOption, contract: contractAddressOption, setActive } = options;

        // Interactively prompt for missing required options.
        const questions = [];
        if (!rpcUrlOption) {
            questions.push({ type: 'input', name: 'rpcUrl', message: `Enter RPC URL for network "${name}":`, validate: input => !!input || "RPC URL cannot be empty." });
        }
        if (!contractAddressOption) {
            questions.push({ type: 'input', name: 'contractAddress', message: `Enter Contract Address for network "${name}":`, validate: input => ethers.isAddress(input) || "Please enter a valid Ethereum address." });
        }

        let answers = {};
        if (questions.length > 0) {
            answers = await inquirer.prompt(questions);
        }

        const rpcUrl = rpcUrlOption || answers.rpcUrl;
        const contractAddress = contractAddressOption || answers.contractAddress;

        // Final validation after potentially getting input from prompts.
        if (!rpcUrl || !ethers.isAddress(contractAddress)) {
            // Should ideally be caught by prompt validation, but double-check.
            console.error(chalk.red('Invalid RPC URL or Contract Address provided. Aborting.'));
            return;
        }

        const config = loadNetworkConfig(); // Load existing config.
        // Add or update the network profile.
        config.networks[name] = { rpcUrl: rpcUrl, contractAddress: contractAddress };
        console.log(chalk.blue(`Network profile "${name}" added/updated.`));

        // Set as active if requested or if it's the first network being added.
        if (setActive || !config.activeNetwork) {
            config.activeNetwork = name;
            console.log(chalk.blue(`Network "${name}" set as the active configuration.`));
        }

        saveNetworkConfig(config); // Persist changes to networks.json.
        console.log(chalk.green(`Network configuration saved successfully.`));
        console.log(chalk.gray(`  Profile Name: ${name}`));
        console.log(chalk.gray(`  RPC URL: ${rpcUrl}`));
        console.log(chalk.gray(`  Contract Address: ${contractAddress}`));
    });

/**
 * Command: tpkm config set-active <name>
 * Sets a previously added network profile as the active one for subsequent commands.
 */
configCommand
    .command('set-active <name>')
    .description('Set the active network configuration to use for TPKM commands.')
    .action((name) => {
        const config = loadNetworkConfig();
        if (!config.networks[name]) {
            console.error(chalk.red(`Error: Network profile "${name}" not found.`));
            console.log(chalk.yellow(`Use "tpkm config add ${name}" to add it first, or "tpkm config list" to see available profiles.`));
            return;
        }
        config.activeNetwork = name;
        saveNetworkConfig(config);
        console.log(chalk.green(`Network profile "${name}" is now set as active.`));
    });

/**
 * Command: tpkm config list (alias: ls)
 * Lists all saved network profiles and indicates the active one.
 */
configCommand
    .command('list')
    .alias('ls')
    .description('List all saved network configurations.')
    .action(() => {
        const config = loadNetworkConfig();
        console.log(chalk.cyan.bold('--- Saved Network Configurations ---'));

        if (Object.keys(config.networks).length === 0) {
            console.log(chalk.gray('No network configurations saved yet.'));
            console.log(chalk.yellow(`Use "tpkm config add <name>" to add one.`));
            return;
        }

        const table = new Table({
             head: [chalk.cyan('Active'), chalk.cyan('Name'), chalk.cyan('RPC URL'), chalk.cyan('Contract Address')],
             colWidths: [8, 25, 45, 45], // Adjust widths as needed
             chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' } // Minimalist table style
        });

        Object.entries(config.networks).forEach(([name, details]) => {
            const isActive = name === config.activeNetwork;
            table.push([
                isActive ? chalk.green('*') : '',
                chalk.whiteBright(name),
                details.rpcUrl,
                details.contractAddress
            ]);
        });
        console.log(table.toString());

        if (config.activeNetwork) {
            console.log(chalk.blue(`\nCurrent active network: "${config.activeNetwork}"`));
        } else {
            console.warn(chalk.yellow('\nWarning: No active network is set. Commands will use defaults or .env variables.'));
            console.warn(chalk.yellow('Use "tpkm config set-active <name>" to choose a profile.'));
        }
    });

/**
 * Command: tpkm config show [name]
 * Displays the details (RPC URL, Contract Address) of a specific network profile,
 * or the active profile if no name is provided.
 */
configCommand
    .command('show [name]')
    .description('Show details of a specific network configuration (or the active one if name is omitted).')
    .action((name) => {
        const config = loadNetworkConfig();
        const networkToShow = name || config.activeNetwork; // Use provided name or fallback to active.

        if (!networkToShow) {
            console.error(chalk.red('Error: No network name specified and no active network set.'));
            console.log(chalk.yellow('Use "tpkm config show <name>" or set an active network with "tpkm config set-active <name>".'));
            return;
        }

        const details = config.networks[networkToShow];
        if (!details) {
            console.error(chalk.red(`Error: Network profile "${networkToShow}" not found.`));
            console.log(chalk.yellow('Use "tpkm config list" to see available profiles.'));
            return;
        }

        const isActive = networkToShow === config.activeNetwork;
        console.log(chalk.cyan.bold(`--- Configuration for "${networkToShow}" ${isActive ? chalk.green('(Active)') : ''} ---`));
        console.log(chalk.whiteBright(`  RPC URL:          `) + details.rpcUrl);
        console.log(chalk.whiteBright(`  Contract Address: `) + details.contractAddress);
    });

/**
 * Command: tpkm config remove <name> (alias: rm)
 * Removes a saved network profile from the configuration file.
 */
configCommand
    .command('remove <name>')
    .alias('rm')
    .description('Remove a saved network configuration profile.')
    .action(async (name) => {
        const config = loadNetworkConfig();
        if (!config.networks[name]) {
            console.error(chalk.red(`Error: Network profile "${name}" not found.`));
            return;
        }

        // Ask for confirmation before deleting.
        const { confirmRemove } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmRemove',
            message: `Are you sure you want to remove the network configuration profile "${name}"?`,
            default: false // Default to No for safety.
        }]);

        if (confirmRemove) {
            delete config.networks[name]; // Remove the profile entry.
             let activeCleared = false;
            // If the removed network was the active one, clear the active setting.
            if (config.activeNetwork === name) {
                config.activeNetwork = null;
                 activeCleared = true;
            }
            saveNetworkConfig(config); // Save changes.
            console.log(chalk.green(`Network profile "${name}" removed successfully.`));
            if (activeCleared) {
                 console.warn(chalk.yellow(`The active network was removed. Please set a new active network using "tpkm config set-active <name>".`));
            }
        } else {
            console.log(chalk.blue('Removal cancelled.'));
        }
    });


// --- Wallet Management Commands (tpkm wallet ...) ---
// Manages the local encrypted Ethereum wallet (~/.tacopkm/keystore.json).
const walletCommand = program.command('wallet')
    .description('Manage local encrypted Ethereum wallet for TPKM operations.');

/**
 * Command: tpkm wallet create
 * Generates a new random Ethereum wallet and saves it as an encrypted keystore file.
 */
walletCommand
    .command('create')
    .description('Create a new Ethereum wallet and save it as an encrypted keystore file (~/.tacopkm/keystore.json).')
    .option('-p, --password <password>', 'Password to encrypt the new wallet (optional, will prompt if not provided)')
    .action(async (options) => {
        let password = options.password;

        // Prompt for password if not provided via option. Require confirmation.
        if (!password) {
            const answers = await inquirer.prompt([
                { type: 'password', name: 'newPassword', message: 'Enter a password for the new wallet:', mask: '*', validate: input => !!input || "Password cannot be empty." },
                { type: 'password', name: 'confirmPassword', message: 'Confirm password:', mask: '*' }
            ]);
            if (answers.newPassword !== answers.confirmPassword) {
                console.error(chalk.red('Passwords do not match. Wallet creation aborted.'));
                return;
            }
            password = answers.newPassword;
        }
        // Should be caught by prompt validation, but double-check.
        if (!password) {
            console.error(chalk.red('Password cannot be empty. Wallet creation aborted.'));
            return;
        }

        // Check if keystore already exists and ask for overwrite confirmation.
         if (fs.existsSync(keystorePath)) {
              const { overwrite } = await inquirer.prompt([{
                   type: 'confirm',
                   name: 'overwrite',
                   message: chalk.yellow(`Wallet keystore already exists at ${keystorePath}. Overwrite? (THIS IS IRREVERSIBLE)`),
                   default: false
              }]);
              if (!overwrite) {
                   console.log(chalk.blue('Wallet creation cancelled. Existing keystore preserved.'));
                   return;
              }
              console.log(chalk.yellow('Overwriting existing keystore...'));
         }

        try {
            fs.ensureDirSync(keystoreDir); // Ensure ~/.tacopkm directory exists.
            const newWalletInstance = ethers.Wallet.createRandom(); // Generate a new wallet.

            const encryptSpinner = ora({ text: 'Encrypting new wallet...', color: 'yellow' }).start();
            // Encrypt the wallet's private key using the provided password into JSON keystore format (V3).
            const keystoreJson = await newWalletInstance.encrypt(password);
            fs.writeFileSync(keystorePath, keystoreJson, 'utf8'); // Save the encrypted JSON.
            encryptSpinner.succeed(chalk.green(`Wallet created and saved to: ${keystorePath}`));

            console.log(chalk.blue(`New Wallet Address: ${newWalletInstance.address}`));
            console.log(chalk.magenta.bold('\n--- IMPORTANT ---'));
            console.log(chalk.magenta('Store your password securely. There is NO way to recover the wallet or funds without it.'));
            console.log(chalk.magenta('Consider backing up the keystore file itself to a secure location.'));
            console.log(chalk.magenta('-----------------\n'));

        } catch (error) {
            console.error(chalk.red('Error creating wallet:'), error.message);
        }
    });

/**
 * Command: tpkm wallet import <privateKey>
 * Imports an existing wallet using its private key and saves it as an encrypted keystore file.
 */
walletCommand
    .command('import <privateKey>')
    .description('Import an existing wallet from a private key and save it as an encrypted keystore file (~/.tacopkm/keystore.json).')
    .option('-p, --password <password>', 'Password to encrypt the imported wallet (optional, will prompt if not provided)')
    .action(async (privateKey, options) => {
        let password = options.password;

        // Validate private key format (basic check for hex string).
        if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
             console.error(chalk.red('Invalid private key format. It should be a 64-character hexadecimal string, optionally prefixed with "0x".'));
             return;
        }
         // Ensure '0x' prefix for ethers.js Wallet constructor.
        if (!privateKey.startsWith('0x')) {
            privateKey = '0x' + privateKey;
        }

        // Prompt for encryption password if not provided.
        if (!password) {
            const answers = await inquirer.prompt([
                { type: 'password', name: 'newPassword', message: 'Enter a password to encrypt the imported wallet:', mask: '*', validate: input => !!input || "Password cannot be empty." },
                { type: 'password', name: 'confirmPassword', message: 'Confirm password:', mask: '*' }
            ]);
            if (answers.newPassword !== answers.confirmPassword) {
                console.error(chalk.red('Passwords do not match. Wallet import aborted.'));
                return;
            }
            password = answers.newPassword;
        }
        if (!password) {
            console.error(chalk.red('Password cannot be empty. Wallet import aborted.'));
            return;
        }

         // Check if keystore already exists and ask for overwrite confirmation.
         if (fs.existsSync(keystorePath)) {
              const { overwrite } = await inquirer.prompt([{
                   type: 'confirm',
                   name: 'overwrite',
                   message: chalk.yellow(`Wallet keystore already exists at ${keystorePath}. Overwrite with imported key? (THIS IS IRREVERSIBLE)`),
                   default: false
              }]);
              if (!overwrite) {
                   console.log(chalk.blue('Wallet import cancelled. Existing keystore preserved.'));
                   return;
              }
               console.log(chalk.yellow('Overwriting existing keystore...'));
         }

        try {
            // Create wallet instance from the private key. This also validates the key.
            const importedWallet = new ethers.Wallet(privateKey);

            fs.ensureDirSync(keystoreDir); // Ensure directory exists.
            const encryptSpinner = ora({ text: 'Encrypting imported wallet...', color: 'yellow' }).start();
            const keystoreJson = await importedWallet.encrypt(password); // Encrypt the imported key.
            fs.writeFileSync(keystorePath, keystoreJson, 'utf8'); // Save, potentially overwriting.
            encryptSpinner.succeed(chalk.green(`Wallet imported successfully and saved to: ${keystorePath}`));

            console.log(chalk.blue(`Imported Wallet Address: ${importedWallet.address}`));
            console.log(chalk.magenta.bold('\n--- IMPORTANT ---'));
            console.log(chalk.magenta('Store your password securely. You need it to use this wallet with TPKM.'));
            console.log(chalk.magenta('Ensure the original private key is stored safely or securely deleted if no longer needed elsewhere.'));
            console.log(chalk.magenta('-----------------\n'));

        } catch (error) {
            // Catch errors from ethers.Wallet constructor (invalid key) or encryption.
            console.error(chalk.red('Error importing wallet:'), error.message);
        }
    });

/**
 * Command: tpkm wallet address
 * Displays the public Ethereum address stored in the local keystore file.
 * Requires decrypting the keystore, so it will prompt for the password.
 */
walletCommand
    .command('address')
    .description('Display the public address of the wallet stored in the local keystore (requires password).')
    .action(async () => {
        // `loadWalletAndConnect` handles finding the keystore, prompting for password,
        // decrypting, and getting the address. It also initializes network clients,
        // although they aren't strictly needed just to display the address.
        // Using it ensures consistency in wallet access patterns.
        // Alternatively, `getPublicAddressFromKeystore` could be used for a read-only approach,
        // but the original code used the decrypting method.
        try {
            // We only need the wallet object here, not the contract. Prompt for password implicitly.
            const { wallet } = await loadWalletAndConnect();
            if (wallet && wallet.address) {
                console.log(chalk.blue.bold(`Current wallet address: ${wallet.address}`));
            }
            // If `loadWalletAndConnect` fails (no keystore, wrong password), it prints errors and exits,
            // so we typically won't reach here on failure.
        } catch (error) {
            // This catch block is a fallback, as loadWalletAndConnect usually exits on error.
            console.error(chalk.red('Could not display wallet address:'), error.message);
        }
    });


// --- Library Management Commands (tpkm register, publish, install, etc.) ---

/**
 * Command: tpkm register <name>
 * Registers a new library name on the LibraryRegistry smart contract.
 * The caller's wallet address becomes the owner of the library record.
 */
program
    .command('register <name>')
    .description('Register a new library name on the TPKM smart contract registry.')
    .option('-d, --description <text>', 'A brief description of the library', '') // Optional description.
    .option('-t, --tags <tags>', 'Comma-separated tags for discoverability (e.g., "math,utils,array")', '') // Optional tags.
    .option('-l, --language <language>', 'Primary programming language (e.g., "javascript", "python")', '') // Optional language hint.
    .option('--private', 'Register the library as private (owner controls access)', false) // Flag for privacy.
    .action(async (name, options) => {
        // Basic name validation (similar to npm package name rules, adjust as needed).
        if (!/^[a-z0-9]+(?:[-_.]?[a-z0-9]+)*$/.test(name) || name.length > 214) {
             console.error(chalk.red(`Invalid library name: "${name}". Use lowercase letters, numbers, hyphens, underscores, or dots. Avoid leading/trailing separators.`));
             return;
        }

        await ensureNetworkClientsInitialized(); // Connect to network, IPFS.
        // Load wallet/signer and get writable contract instance. Will prompt for password.
        const { contract: writableContractInstance, wallet: currentSigner } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSigner) return; // Exit if wallet loading failed.

        console.log(chalk.yellow(`Attempting to register library "${name}" on network "${currentActiveNetworkName}"...`));
        console.log(chalk.gray(`  Owner will be: ${currentSigner.address}`));
        console.log(chalk.gray(`  Private: ${options.private ? 'Yes' : 'No'}`));
        if (options.description) console.log(chalk.gray(`  Description: ${options.description}`));
        if (options.language) console.log(chalk.gray(`  Language: ${options.language}`));
        const tagsArray = options.tags ? options.tags.split(',').map(tag => tag.trim()).filter(tag => tag) : [];
        if (tagsArray.length > 0) console.log(chalk.gray(`  Tags: ${tagsArray.join(', ')}`));


        // --- Pre-check: Verify if the library name is already taken ---
        const checkSpinner = ora({ text: `Checking availability of name "${name}"...`, color: 'gray' }).start();
        try {
            // Attempt to get info. If it succeeds, the library exists.
            await contractReadOnly.getLibraryInfo(name);
            // If the above line does not throw, the library exists.
            checkSpinner.fail(chalk.red(`Registration failed: Library name "${name}" is already registered.`));
            console.log(chalk.yellow('Please choose a different name.'));
            return;
        } catch (checkError) {
            const reason = getRevertReason(checkError);
            // Expect "Library not found" if the name is available.
            if (reason.toLowerCase().includes('library not found')) {
                checkSpinner.succeed(chalk.gray(`Library name "${name}" is available.`));
            } else {
                // Different error occurred during the check.
                checkSpinner.fail(chalk.red('Error during pre-check for library name:'));
                console.error(chalk.red(`  ${reason}`));
                return;
            }
        }
        // --- End Pre-check ---

        // Proceed with registration transaction.
        const registerSpinner = ora({ text: `Sending registration transaction for "${name}"...`, color: 'yellow' }).start();
        try {
            // Call the smart contract's `registerLibrary` function.
            const tx = await writableContractInstance.registerLibrary(
                name,
                options.description,
                tagsArray,
                options.private, // Pass the boolean privacy flag.
                options.language
            );
            registerSpinner.text = `Waiting for transaction confirmation (Hash: ${tx.hash.substring(0,10)}...)...`;
            await tx.wait(1); // Wait for 1 confirmation.
            registerSpinner.succeed(chalk.green(`Library "${name}" registered successfully!`));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));

        } catch (error) {
            registerSpinner.fail(chalk.red('Error registering library:'));
            console.error(chalk.red(`  ${getRevertReason(error)}`));
            if (process.env.DEBUG) console.error(error); // Log full error object in debug mode.
        }
    });

/**
 * Command: tpkm info <libraryIdentifier>
 * Fetches and displays information about a registered library or a specific version.
 * Identifier format: "libraryName" or "libraryName@version".
 */
program
    .command('info <libraryIdentifier>')
    .description('Get info about a library or a specific version (e.g., "my-lib" or "my-lib@1.0.0").')
    .option('--versions', 'List all published versions for the library.') // Flag to list versions.
    .action(async (libraryIdentifier, options) => {
        await ensureNetworkClientsInitialized(); // Need read-only contract access.

        let libraryName = libraryIdentifier;
        let versionString = null;
        const querySpecificVersion = libraryIdentifier.includes('@');
        const listAllVersions = options.versions; // Check if --versions flag was used.

        // Parse identifier if version is included.
        if (querySpecificVersion) {
            const parts = libraryIdentifier.split('@');
            if (parts.length !== 2 || !parts[0] || !parts[1]) {
                console.error(chalk.red('Invalid format. Use "libraryName" or "libraryName@version".'));
                return;
            }
            libraryName = parts[0];
            versionString = parts[1];
            // Validate the version part looks like a semantic version.
            if (!semver.valid(versionString)) {
                console.error(chalk.red(`Invalid version format: "${versionString}". Use semantic versioning (e.g., 1.0.0).`));
                return;
            }
        }

        const infoSpinner = ora({ text: `Fetching information for "${libraryIdentifier}"...`, color: 'yellow' }).start();
        try {
            // 1. Fetch and display general library information.
            infoSpinner.text = `Fetching general info for "${libraryName}"...`;
            // Assumes getLibraryInfo returns: [owner, description, tags, isPrivate, language]
            const libInfo = await contractReadOnly.getLibraryInfo(libraryName);
            infoSpinner.succeed(chalk.green(`Workspaceed info for "${libraryName}".`));

            const [owner, description, tags, isPrivate, language] = libInfo;

            console.log(chalk.cyan.bold(`\n--- Library Info: ${libraryName} ---`));
            const basicInfoTable = new Table({
                 chars: { 'top': '', 'top-mid': '', 'top-left': '', 'top-right': '', 'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '', 'left': '  ', 'right': '', 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' }, // No borders, key-value style.
                 style: { 'padding-left': 0, 'padding-right': 2 } // Padding for alignment.
            });
            basicInfoTable.push(
                { [chalk.whiteBright('Owner')]: owner },
                { [chalk.whiteBright('Description')]: description || chalk.gray('(Not set)') },
                { [chalk.whiteBright('Language')]: language || chalk.gray('(Not set)') },
                { [chalk.whiteBright('Tags')]: tags.length > 0 ? tags.join(', ') : chalk.gray('(None)') },
                { [chalk.whiteBright('Visibility')]: isPrivate ? chalk.yellow('Private') : chalk.green('Public') }
            );
            console.log(basicInfoTable.toString());

            // 2. If --versions flag is used or if only the library name was given (implying a general query), list versions.
            if (listAllVersions || (!querySpecificVersion && !versionString)) {
                 const versionSpinner = ora({ text: `Fetching published versions for ${libraryName}...`, color: 'gray' }).start();
                 try {
                     const versions = await contractReadOnly.getVersionNumbers(libraryName);
                     if (versions && versions.length > 0) {
                         // Sort versions semantically (highest first).
                         const sortedVersions = versions.sort(semver.rcompare);
                         versionSpinner.succeed(chalk.green(`Found ${versions.length} published version(s).`));

                         console.log(chalk.cyan.bold(`\n--- Published Versions (${versions.length}) ---`));
                         const versionsTable = new Table({
                             head: [chalk.cyan('Version')],
                             colWidths: [30],
                         });
                         sortedVersions.forEach(v => versionsTable.push([v]));
                         console.log(versionsTable.toString());

                     } else {
                         versionSpinner.info(chalk.gray('No versions published yet for this library.'));
                     }
                 } catch (versionError) {
                      versionSpinner.fail(chalk.red('Error fetching version list:'));
                     console.error(chalk.red(`  ${getRevertReason(versionError)}`));
                 }
            }

            // 3. If a specific version was requested, display its details.
            if (querySpecificVersion && versionString) {
                 const versionDetailSpinner = ora({ text: `Fetching details for ${libraryName}@${versionString}...`, color: 'gray' }).start();
                try {
                    // Assumes getVersionInfo returns: [ipfsHash, publisher, timestamp, deprecated, dependencies]
                    const versionData = await contractReadOnly.getVersionInfo(libraryName, versionString);
                    versionDetailSpinner.succeed(chalk.green(`Workspaceed details for ${libraryName}@${versionString}.`));

                    const [ipfsHash, publisher, timestamp, deprecated, dependencies] = versionData;
                    // Convert BigInt timestamp from contract (seconds since epoch) to a Date object.
                    const publishDate = new Date(Number(timestamp) * 1000);

                    console.log(chalk.cyan.bold(`\n--- Version Info: ${libraryName}@${versionString} ---`));
                    const versionDetailsTable = new Table({
                         chars: { /* as above */ 'top': '', 'top-mid': '', 'top-left': '', 'top-right': '', 'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '', 'left': '  ', 'right': '', 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
                         style: { 'padding-left': 0, 'padding-right': 2 }
                    });
                    versionDetailsTable.push(
                        { [chalk.whiteBright('IPFS Hash (CID)')]: ipfsHash },
                        { [chalk.whiteBright('Publisher')]: publisher },
                        { [chalk.whiteBright('Published')]: `${publishDate.toLocaleString()} (${timestamp.toString()}s)` },
                        { [chalk.whiteBright('Deprecated')]: deprecated ? chalk.red.bold('Yes') : 'No' }
                    );
                    console.log(versionDetailsTable.toString());

                    // Display Dependencies, if any.
                    console.log(chalk.whiteBright(`\n  Dependencies:`));
                    if (dependencies && dependencies.length > 0) {
                        const depsTable = new Table({
                            head: [chalk.cyan('Name'), chalk.cyan('Version Constraint')],
                            colWidths: [30, 25],
                            chars: { /* Standard table borders */ } // Use default or custom borders
                        });
                        dependencies.forEach(dep => depsTable.push([dep.name, dep.constraint]));
                        console.log(depsTable.toString());
                    } else {
                        console.log(chalk.gray('    (None)'));
                    }

                } catch (versionError) {
                     versionDetailSpinner.fail(chalk.red(`Error fetching details for version ${versionString}:`));
                    console.error(chalk.red(`  ${getRevertReason(versionError)}`)); // Likely "Version does not exist".
                }
            }
            console.log(''); // Add a final blank line for spacing.

        } catch (error) {
             // Handle errors from the initial getLibraryInfo call.
            infoSpinner.fail(chalk.red('Error fetching library info:'));
            console.error(chalk.red(`  ${getRevertReason(error)}`)); // Likely "Library does not exist".
            if (process.env.DEBUG) console.error(error.stack);
        }
    });

/**
 * Command: tpkm publish <directory>
 * Packages the library code in the specified directory, uploads the archive to IPFS,
 * and then calls the smart contract to publish a new version record, associating
 * the library name, version string, and IPFS hash. Requires ownership of the library.
 */
program
    .command('publish <directory>')
    .description('Package, upload to IPFS, and publish a new version of a library from a directory.')
    .option('-v, --version <version>', 'Version string (e.g., 1.0.0). Overrides version in lib.config.json.')
    .action(async (directory, options) => {
        await ensureNetworkClientsInitialized(); // Need IPFS, RPC.
        // Need signer wallet to publish. Will prompt for password.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return; // Exit if wallet loading failed.

        const dirPath = path.resolve(directory); // Get absolute path.
        const configPath = path.join(dirPath, 'lib.config.json'); // Standard config file name.
        // Use OS temp directory for the intermediate archive file.
        const tempArchiveName = `tpkm-publish-temp-${Date.now()}.tar.gz`;
        const tempArchivePath = path.join(os.tmpdir(), tempArchiveName);

        console.log(chalk.yellow(`Attempting to publish library from directory: ${dirPath}`));
        let libraryName = '';
        let versionString = '';
        let ipfsHash = ''; // Will store the CID after successful upload.
        let dependenciesToPass = []; // Array of { name: string, constraint: string } for the contract.

        try {
            // --- 1. Validate directory and configuration file ---
            if (!fs.existsSync(dirPath) || !fs.lstatSync(dirPath).isDirectory()) {
                throw new Error(`Directory not found or is not a valid directory: ${dirPath}`);
            }
            if (!fs.existsSync(configPath)) {
                throw new Error(`Configuration file 'lib.config.json' not found in ${dirPath}. Use 'tpkm init' to create one.`);
            }

            // --- 2. Read and parse lib.config.json ---
            let config;
            try {
                 config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch (parseError) {
                 throw new Error(`Failed to parse 'lib.config.json': ${parseError.message}`);
            }

            libraryName = config.name;
            // Use command-line version override if provided, otherwise use config version.
            versionString = options.version || config.version;

            // Validate essential config values.
            if (!libraryName || typeof libraryName !== 'string') {
                throw new Error('Missing or invalid "name" field in lib.config.json.');
            }
            if (!versionString) {
                // This happens if version is missing in both config and CLI option.
                throw new Error('Library version is missing. Specify it in lib.config.json or use the --version option.');
            }
            if (!semver.valid(versionString)) {
                throw new Error(`Invalid version format in config or option: "${versionString}". Use semantic versioning (e.g., 1.0.0).`);
            }
            console.log(chalk.gray(`Publishing: ${libraryName}@${versionString}`));

            // Parse dependencies from config.dependencies object.
            if (config.dependencies && typeof config.dependencies === 'object') {
                for (const [name, constraint] of Object.entries(config.dependencies)) {
                    if (!constraint || typeof constraint !== 'string') {
                        console.warn(chalk.yellow(`Warning: Invalid or missing version constraint for dependency "${name}" in lib.config.json. Skipping.`));
                        continue; // Skip dependencies with invalid constraints.
                    }
                     // Validate constraint format loosely (more complex validation could be added).
                     // A basic check could be `semver.validRange(constraint)`.
                     if (!semver.validRange(constraint)) {
                          console.warn(chalk.yellow(`Warning: Potentially invalid version constraint "${constraint}" for dependency "${name}". Proceeding, but check format.`));
                     }
                    dependenciesToPass.push({ name, constraint });
                }
                if (dependenciesToPass.length > 0) {
                    console.log(chalk.gray(`Including ${dependenciesToPass.length} dependencies from config: ${dependenciesToPass.map(d => `${d.name}@${d.constraint}`).join(', ')}`));
                }
            }

            // --- 3. Pre-check: Verify Ownership ---
            const ownerCheckSpinner = ora({ text: `Verifying ownership of library "${libraryName}"...`, color: 'gray' }).start();
            try {
                const libInfo = await contractReadOnly.getLibraryInfo(libraryName);
                const ownerAddressOnChain = libInfo[0]; // Owner is the first element.
                if (ownerAddressOnChain.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                     ownerCheckSpinner.fail();
                    // Throw a clear error if the current wallet doesn't own the library record.
                    throw new Error(`Permission Denied: Your wallet (${currentSignerWallet.address}) is not the registered owner (${ownerAddressOnChain}) of library "${libraryName}".`);
                }
                ownerCheckSpinner.succeed(chalk.gray(`Ownership confirmed.`));
            } catch (checkError) {
                 ownerCheckSpinner.fail();
                // Handle cases like the library not being registered yet, or other contract errors.
                console.error(chalk.red('Pre-publication check failed:'), getRevertReason(checkError));
                // Provide guidance based on the error.
                if (getRevertReason(checkError).toLowerCase().includes('library not found')) {
                     console.log(chalk.yellow(`Library "${libraryName}" is not registered yet. Use "tpkm register ${libraryName}" first.`));
                }
                // Re-throw to stop the publication process.
                throw new Error(`Pre-publication check failed: ${getRevertReason(checkError)}`);
            }

            // --- 4. Archive the directory contents ---
            const archiveSpinner = ora({ text: `Archiving directory content from ${dirPath}...`, color: 'yellow' }).start();
            try {
                await archiveDirectory(dirPath, tempArchivePath);
                archiveSpinner.succeed(chalk.gray(`Archive created temporarily at: ${tempArchivePath}`));
            } catch (archiveError) {
                archiveSpinner.fail(chalk.red('Archiving failed.'));
                throw archiveError; // Stop the process if archiving fails.
            }

            // --- 5. Upload the archive to IPFS ---
            const ipfsUploadSpinner = ora({ text: `Uploading archive to IPFS via ${currentActiveRpcUrl}...`, color: 'yellow' }).start();
            try {
                ipfsHash = await uploadToIpfs(tempArchivePath);
                if (!ipfsHash) { // Should be redundant if uploadToIpfs throws on failure, but good safety check.
                     throw new Error('IPFS upload completed but did not return a valid CID.');
                }
                ipfsUploadSpinner.succeed(chalk.green(`Uploaded to IPFS. CID: ${ipfsHash}`));
            } catch (uploadError) {
                ipfsUploadSpinner.fail(chalk.red('IPFS upload failed.'));
                throw uploadError; // Stop the process.
            }

            // --- 6. Call Smart Contract to Publish Version ---
            const publishSpinner = ora({ text: `Publishing ${libraryName}@${versionString} to the smart contract...`, color: 'yellow' }).start();
            try {
                // Call the `publishVersion` function on the writable contract instance.
                const tx = await writableContractInstance.publishVersion(
                    libraryName,
                    versionString,
                    ipfsHash,
                    dependenciesToPass // Pass the parsed dependencies array.
                );
                publishSpinner.text = `Waiting for transaction confirmation (Hash: ${tx.hash.substring(0,10)}...)...`;
                await tx.wait(1); // Wait for 1 confirmation.

                publishSpinner.succeed(chalk.green.bold(`Version ${versionString} of "${libraryName}" published successfully!`));
                console.log(chalk.blue(`  Transaction Hash: ${tx.hash}`));
                console.log(chalk.blue(`  IPFS Hash (CID): ${ipfsHash}`));

            } catch (publishError) {
                publishSpinner.fail(chalk.red(`Failed to publish version ${versionString} to the contract:`));
                // Check for common contract errors like "Version already exists".
                console.error(chalk.red(`  ${getRevertReason(publishError)}`));
                throw publishError; // Propagate the error.
            }

        } catch (error) {
            // Catch errors from any stage (validation, config reading, checks, archiving, upload, contract call).
            console.error(chalk.red.bold('\nPublication process failed:'), error.message || 'An unknown error occurred.');
            // Avoid logging the full error object unless in debug mode, as it can be verbose.
            if (process.env.DEBUG && error.stack) {
                console.error(error.stack);
            }
        } finally {
            // --- 7. Clean up the temporary archive file ---
            if (fs.existsSync(tempArchivePath)) {
                try {
                    fs.unlinkSync(tempArchivePath);
                    console.log(chalk.gray(`Temporary archive cleaned up (${tempArchivePath}).`));
                } catch (cleanupError) {
                    // Log a warning if cleanup fails, but don't let it stop the main error reporting.
                    console.warn(chalk.yellow(`Warning: Failed to clean up temporary archive: ${tempArchivePath}`), cleanupError.message);
                }
            }
        }
    });

/**
 * Command: tpkm install <libraryIdentifier>
 * Downloads a specific library version (and its dependencies recursively) from IPFS,
 * resolves versions based on constraints, and extracts them into a local directory (`tpkm_installed_libs`).
 * Format: "libraryName@versionString".
 */
program
    .command('install <libraryIdentifier>')
    .description('Download and extract a library version and its dependencies (format: "name@version").')
    // Potential future options: --save-dev, --global, --target-dir
    .action(async (libraryIdentifier /*, options */) => {
        await ensureNetworkClientsInitialized(); // Need IPFS, read-only contract access.

        // Regex to strictly parse "libraryName@versionString".
        const identifierRegex = /^([^@]+)@(.+)$/;
        const match = libraryIdentifier.match(identifierRegex);

        if (!match) {
            console.error(chalk.red('Invalid library identifier format.'));
            console.error(chalk.yellow('Please use "libraryName@versionString" (e.g., my-lib@1.0.0).'));
            return;
        }
        const [, libraryName, versionString] = match;

        // Validate the version part using semver.
        if (!semver.valid(versionString)) {
            console.error(chalk.red(`Invalid version format specified: "${versionString}".`));
            console.error(chalk.yellow('Please use a valid semantic version (e.g., 1.0.0, 2.1.0-beta.1).'));
            return;
        }

        console.log(chalk.yellow.bold(`Starting installation process for ${libraryName}@${versionString}...`));
        // Define the root directory for installations within the current working directory.
        const installRoot = path.join(process.cwd(), 'tpkm_installed_libs');
        // Map to track resolved packages { name: resolvedVersion } to handle dependencies and prevent cycles/conflicts.
        const resolvedPackages = new Map();

        try {
            // --- Optional: Access Check for Private Libraries ---
            // Get the public address from the local keystore (if it exists) to potentially check access for private libs.
            // This doesn't require the password, just reads the address from the file.
            const publicAddress = await getPublicAddressFromKeystore();

            // Note: The primary access control often happens within the contract's `getVersionInfo` or a dedicated
            // `hasAccess` function called by `processInstallation` or implicitly.
            // However, performing an explicit top-level check here can provide earlier feedback if the user lacks
            // access to the main requested library (if it's private).

            if (publicAddress) {
                // Perform an explicit check for the top-level library *if* a local wallet address is found.
                const accessCheckSpinner = ora({ text: `Checking access for ${publicAddress.substring(0,10)}... to "${libraryName}"...`, color: 'gray' }).start();
                try {
                    // Assumes contract has `hasAccess(libraryName, userAddress)` view function.
                    const hasAccess = await contractReadOnly.hasAccess(libraryName, publicAddress);
                    if (!hasAccess) {
                         accessCheckSpinner.fail();
                        // If this specific check fails, inform the user and stop.
                        throw new Error(`Access Denied: Wallet ${publicAddress} does not have permission to access library "${libraryName}". This library might be private or you need authorization.`);
                    }
                     accessCheckSpinner.succeed(chalk.gray('Access check passed (or library is public).'));
                } catch (accessCheckError) {
                     accessCheckSpinner.fail();
                    // Handle errors during the access check itself (e.g., library not found).
                    console.error(chalk.red('Error during access check for top-level library:'), getRevertReason(accessCheckError));
                    // Exit if the explicit access check fails critically.
                    return;
                }
            } else {
                // No local wallet configured, proceed assuming public access or that the contract will enforce permissions later.
                console.log(chalk.gray(`No local wallet address found via keystore. Proceeding with installation.`));
                console.log(chalk.yellow(`Access to private libraries or dependencies might be restricted.`));
            }
            // --- End Optional Access Check ---


            // --- Start Recursive Installation ---
            console.log(chalk.blue(`Resolving dependencies starting from ${libraryName}@${versionString}...`));
            // The `versionString` acts as the initial constraint for the top-level package.
            // `processInstallation` will handle fetching, downloading, extracting, and resolving sub-dependencies.
            await processInstallation(libraryName, versionString, resolvedPackages, installRoot);
            // --- End Recursive Installation ---


            // --- Installation Summary ---
            console.log(chalk.green.bold(`\nInstallation finished successfully!`));
            if (resolvedPackages.size > 0) {
                console.log(chalk.cyan('Installed packages and versions:'));
                 const installedTable = new Table({
                      head: [chalk.cyan('Package'), chalk.cyan('Installed Version')],
                       colWidths: [40, 20]
                 });
                resolvedPackages.forEach((version, name) => {
                    installedTable.push([name, version]);
                });
                 console.log(installedTable.toString());
                console.log(chalk.blue(`\nLibraries installed in: ${installRoot}`));
            } else {
                // This state should ideally not be reached if processInstallation succeeded for the main package.
                console.log(chalk.yellow('No packages appear to have been installed. This might indicate an unexpected issue.'));
            }

        } catch (error) {
            // Catch errors thrown by `processInstallation` (e.g., version conflicts, download failures) or initial checks.
            console.error(chalk.red.bold(`\nInstallation failed:`));
            // Use `error.message` as `getRevertReason` might not apply to all error types here (like version conflicts).
            console.error(chalk.red(`  ${error.message || getRevertReason(error)}`));
            if (process.env.DEBUG && error.stack) {
                console.error(error.stack);
            }
            // Optionally suggest checking network, IPFS, or permissions based on the error.
            if (error.message && error.message.toLowerCase().includes('version conflict')) {
                 console.log(chalk.yellow('Hint: Check the dependency requirements of your requested package and its sub-dependencies.'));
            }
        }
    });

/**
 * Command: tpkm list
 * Lists all library names registered in the smart contract.
 * Note: This might be inefficient on networks with a vast number of libraries if the contract iterates storage.
 */
program
    .command('list')
    .description('List all registered library names in the TPKM registry (can be slow on large registries).')
    .action(async () => {
        await ensureNetworkClientsInitialized(); // Need read-only contract access.

        const listSpinner = ora({ text: `Fetching list of all registered libraries from contract ${currentActiveContractAddress}...`, color: 'yellow' }).start();
        console.warn(chalk.magenta('\nNote: Depending on the smart contract implementation, listing all libraries might be slow or consume significant resources on large public networks.'));

        try {
            // Assumes the smart contract has a function like `getAllLibraryNames()` that returns string[].
            const libraryNames = await contractReadOnly.getAllLibraryNames();

            if (libraryNames && libraryNames.length > 0) {
                 listSpinner.succeed(chalk.green(`Found ${libraryNames.length} registered libraries.`));

                // Display the names in a simple table.
                const table = new Table({
                    head: [chalk.cyan.bold('Registered Library Name')],
                    colWidths: [70], // Adjust width as needed.
                    // Prettier table borders (optional)
                    chars: { 'top': '═', 'top-mid': '╤', 'top-left': '╔', 'top-right': '╗', 'bottom': '═', 'bottom-mid': '╧', 'bottom-left': '╚', 'bottom-right': '╝', 'left': '║', 'left-mid': '╟', 'mid': '─', 'mid-mid': '┼', 'right': '║', 'right-mid': '╢', 'middle': '│' }
                });

                // Create a shallow copy and sort it to avoid modifying the original read-only array
                const sortedLibraryNames = [...libraryNames].sort((a, b) => a.localeCompare(b));

                // Iterate over the sorted copy
                sortedLibraryNames.forEach(name => {
                    table.push([name]); // Add each library name as a new row.
                });

                console.log(table.toString());
            } else {
                listSpinner.info(chalk.gray('No libraries are currently registered in this registry.'));
            }
        } catch (error) {
             listSpinner.fail(chalk.red('Error fetching library list:'));
             // Check if the contract even supports `getAllLibraryNames`.
             if (error.message && (error.message.includes('call revert exception') || error.message.includes('function selector was not recognized'))) {
                  console.error(chalk.red(`  The connected smart contract may not support the 'getAllLibraryNames' function, or another error occurred.`));
             }
            console.error(chalk.red(`  ${getRevertReason(error)}`));
            if (process.env.DEBUG) console.error(error.stack);
        }
    });

/**
 * Command: tpkm deprecate <libraryIdentifier>
 * Marks a specific version of a library as deprecated in the smart contract registry.
 * This serves as a warning to users who try to install or depend on this version.
 * Requires the caller to be the owner of the library record.
 * Format: "libraryName@versionString".
 */
program
    .command('deprecate <libraryIdentifier>')
    .description('Mark a specific library version as deprecated (format: "name@version"). Requires library ownership.')
    .action(async (libraryIdentifier) => {
        await ensureNetworkClientsInitialized(); // Need network access.
        // Need signer to send the transaction. Will prompt for password.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return;

        // Parse and validate the identifier.
        const identifierRegex = /^([^@]+)@(.+)$/;
        const match = libraryIdentifier.match(identifierRegex);
        if (!match) {
            console.error(chalk.red('Invalid format. Please use "libraryName@versionString" (e.g., my-lib@1.0.0).'));
            return;
        }
        const [, libraryName, versionString] = match;

        if (!semver.valid(versionString)) {
            console.error(chalk.red(`Invalid version format: "${versionString}". Use semantic versioning.`));
            return;
        }

        console.log(chalk.yellow(`Attempting to mark version ${libraryName}@${versionString} as deprecated...`));

        // --- Pre-checks before sending transaction ---
        const checkSpinner = ora({ text: `Verifying ownership and version existence for ${libraryName}@${versionString}...`, color: 'gray' }).start();
        try {
            // 1. Verify ownership. `getLibraryInfo` also implicitly checks if the library exists.
            const libInfo = await contractReadOnly.getLibraryInfo(libraryName);
            const ownerAddressOnChain = libInfo[0];
            if (ownerAddressOnChain.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                 checkSpinner.fail();
                throw new Error(`Permission Denied: Your wallet (${currentSignerWallet.address}) is not the owner (${ownerAddressOnChain}) of library "${libraryName}".`);
            }

            // 2. Verify the specific version exists. `getVersionInfo` will throw if not found.
            // We also check if it's *already* deprecated.
            const versionInfo = await contractReadOnly.getVersionInfo(libraryName, versionString);
            const alreadyDeprecated = versionInfo[3]; // Assuming 'deprecated' is the 4th element.
            if (alreadyDeprecated) {
                 checkSpinner.warn(chalk.yellow(`${libraryName}@${versionString} is already marked as deprecated.`));
                 return; // No action needed if already deprecated.
            }

            checkSpinner.succeed(chalk.gray(`Ownership confirmed, version exists and is not already deprecated.`));
        } catch (checkError) {
            checkSpinner.fail(chalk.red('Pre-deprecation check failed:'));
            // Handle errors like library/version not found.
            console.error(chalk.red(`  ${getRevertReason(checkError)}`));
            return; // Stop if checks fail.
        }
        // --- End of Pre-checks ---


        // Confirm action with the user.
        const { confirmDeprecate } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmDeprecate',
            message: `Are you sure you want to mark ${libraryName}@${versionString} as deprecated? This action can usually be reversed if needed, but signals users to avoid this version.`,
            default: true
        }]);

        if (!confirmDeprecate) {
            console.log(chalk.blue('Deprecation cancelled by user.'));
            return;
        }

        // Send the deprecation transaction.
        const deprecateSpinner = ora({ text: `Sending transaction to deprecate ${libraryName}@${versionString}...`, color: 'yellow' }).start();
        try {
            // Assumes contract has `deprecateVersion(string name, string version)` function.
            const tx = await writableContractInstance.deprecateVersion(libraryName, versionString);
            deprecateSpinner.text = `Waiting for transaction confirmation (Hash: ${tx.hash.substring(0,10)}...)...`;
            await tx.wait(1); // Wait for 1 confirmation.
            deprecateSpinner.succeed(chalk.green(`${libraryName}@${versionString} has been marked as deprecated successfully!`));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));
        } catch (error) {
            deprecateSpinner.fail(chalk.red(`Error deprecating ${libraryName}@${versionString}:`));
            console.error(chalk.red(`  ${getRevertReason(error)}`));
            if (process.env.DEBUG) console.error(error.stack);
        }
    });

/**
 * Command: tpkm authorize <libraryName> <userAddress>
 * Grants a specific user address permission to access (e.g., download, view info of)
 * a private library owned by the caller. Requires library ownership.
 */
program
    .command('authorize <libraryName> <userAddress>')
    .description('Grant access to a private library for a specific user address. Requires library ownership.')
    .action(async (libraryName, userAddress) => {
        await ensureNetworkClientsInitialized(); // Network access.
        // Need signer to authorize. Will prompt for password.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return;

        // Validate the user address format.
        if (!ethers.isAddress(userAddress)) {
            console.error(chalk.red(`Invalid Ethereum address provided for user: ${userAddress}`));
            return;
        }
        // Prevent authorizing the zero address.
        if (userAddress === ethers.ZeroAddress) {
            console.error(chalk.red('Cannot authorize the zero address (0x0...). Please provide a valid user address.'));
            return;
        }

        console.log(chalk.yellow(`Attempting to authorize user ${userAddress} for private library "${libraryName}"...`));

        // --- Pre-checks ---
        const checkSpinner = ora({ text: `Verifying library ownership, status, and user authorization...`, color: 'gray' }).start();
        try {
            // 1. Get library info to check ownership and privacy status.
            // Assumes getLibraryInfo: [owner, description, tags, isPrivate, language]
            const libInfo = await contractReadOnly.getLibraryInfo(libraryName);
            const ownerAddressOnChain = libInfo[0];
            const isPrivate = libInfo[3];

            // 2. Verify ownership.
            if (ownerAddressOnChain.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                 checkSpinner.fail();
                throw new Error(`Permission Denied: Your wallet (${currentSignerWallet.address}) is not the owner (${ownerAddressOnChain}) of library "${libraryName}".`);
            }

            // 3. Verify the library is actually private. Authorization is only relevant for private libraries.
            if (!isPrivate) {
                 checkSpinner.fail();
                throw new Error(`Operation Not Applicable: Library "${libraryName}" is public. Authorization is only needed for private libraries.`);
            }

            // 4. Check if the user to be authorized is the owner (owners inherently have access).
            if (userAddress.toLowerCase() === ownerAddressOnChain.toLowerCase()) {
                checkSpinner.warn(chalk.yellow(`User ${userAddress} is the owner and already has access. No authorization needed.`));
                return;
            }

            // 5. Check if the user is *already* authorized using the `hasAccess` function.
            const currentlyAuthorized = await contractReadOnly.hasAccess(libraryName, userAddress);
            if (currentlyAuthorized) {
                checkSpinner.info(chalk.blue(`User ${userAddress} is already authorized to access "${libraryName}". No action needed.`));
                return; // Exit gracefully if already authorized.
            }

            checkSpinner.succeed(chalk.gray(`Checks passed: You own the private library "${libraryName}" and user ${userAddress.substring(0,10)}... is not yet authorized.`));
        } catch (checkError) {
            checkSpinner.fail(chalk.red('Pre-authorization check failed:'));
            console.error(chalk.red(`  ${getRevertReason(checkError)}`)); // Handle library not found, etc.
            return;
        }
        // --- End of Pre-checks ---


        // Send the authorization transaction.
        const authSpinner = ora({ text: `Sending transaction to authorize ${userAddress.substring(0,10)}... for "${libraryName}"...`, color: 'yellow' }).start();
        try {
            // Assumes contract has `authorizeUser(string name, address user)` function.
            const tx = await writableContractInstance.authorizeUser(libraryName, userAddress);
            authSpinner.text = `Waiting for transaction confirmation (Hash: ${tx.hash.substring(0,10)}...)...`;
            await tx.wait(1);
            authSpinner.succeed(chalk.green(`User ${userAddress} authorized successfully for library "${libraryName}"!`));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));
        } catch (error) {
            authSpinner.fail(chalk.red(`Error authorizing user for "${libraryName}":`));
            console.error(chalk.red(`  ${getRevertReason(error)}`));
            if (process.env.DEBUG) console.error(error.stack);
        }
    });

/**
 * Command: tpkm revoke <libraryName> <userAddress>
 * Revokes a previously granted access permission for a specific user address
 * from a private library owned by the caller. Requires library ownership.
 */
program
    .command('revoke <libraryName> <userAddress>')
    .description('Revoke access to a private library for a specific user address. Requires library ownership.')
    .action(async (libraryName, userAddress) => {
        await ensureNetworkClientsInitialized(); // Network access.
        // Need signer to revoke. Will prompt for password.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return;

        // Validate address format.
        if (!ethers.isAddress(userAddress)) {
            console.error(chalk.red(`Invalid Ethereum address provided for user: ${userAddress}`));
            return;
        }

        console.log(chalk.yellow(`Attempting to revoke access for user ${userAddress} from private library "${libraryName}"...`));

        // --- Pre-checks ---
        const checkSpinner = ora({ text: `Verifying library ownership, status, and user authorization...`, color: 'gray' }).start();
        try {
            // 1. Get library info for ownership and privacy check.
            const libInfo = await contractReadOnly.getLibraryInfo(libraryName);
            const ownerAddressOnChain = libInfo[0];
            const isPrivate = libInfo[3];

            // 2. Verify ownership.
            if (ownerAddressOnChain.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                 checkSpinner.fail();
                throw new Error(`Permission Denied: Your wallet (${currentSignerWallet.address}) is not the owner (${ownerAddressOnChain}) of library "${libraryName}".`);
            }

            // 3. Verify library is private.
            if (!isPrivate) {
                 checkSpinner.fail();
                throw new Error(`Operation Not Applicable: Library "${libraryName}" is public. Revocation only applies to private libraries.`);
            }

            // 4. Prevent revoking the owner's access (owners always have access).
            if (userAddress.toLowerCase() === ownerAddressOnChain.toLowerCase()) {
                checkSpinner.warn(chalk.yellow(`Cannot revoke access for the library owner (${userAddress}). Owners always retain access.`));
                return;
            }

            // 5. Check if the user actually *has* access currently (is authorized). You can only revoke existing access.
            const currentlyAuthorized = await contractReadOnly.hasAccess(libraryName, userAddress);
            if (!currentlyAuthorized) {
                checkSpinner.info(chalk.blue(`User ${userAddress} is not currently authorized for library "${libraryName}". No revocation needed.`));
                return; // Exit gracefully if user isn't authorized anyway.
            }

            checkSpinner.succeed(chalk.gray(`Checks passed: You own the private library "${libraryName}" and user ${userAddress.substring(0,10)}... is currently authorized.`));
        } catch (checkError) {
            checkSpinner.fail(chalk.red('Pre-revocation check failed:'));
            console.error(chalk.red(`  ${getRevertReason(checkError)}`));
            return;
        }
        // --- End of Pre-checks ---

         // Confirm action with the user.
        const { confirmRevoke } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmRevoke',
            message: `Are you sure you want to revoke access for user ${userAddress} from library "${libraryName}"? They will no longer be able to access this private library.`,
            default: true
        }]);

        if (!confirmRevoke) {
            console.log(chalk.blue('Revocation cancelled by user.'));
            return;
        }


        // Send the revocation transaction.
        const revokeSpinner = ora({ text: `Sending transaction to revoke access for ${userAddress.substring(0,10)}... from "${libraryName}"...`, color: 'yellow' }).start();
        try {
            // Assumes contract has `revokeAuthorization(string name, address user)` function.
            const tx = await writableContractInstance.revokeAuthorization(libraryName, userAddress);
             revokeSpinner.text = `Waiting for transaction confirmation (Hash: ${tx.hash.substring(0,10)}...)...`;
            await tx.wait(1);
            revokeSpinner.succeed(chalk.green(`Authorization revoked successfully for user ${userAddress} from library "${libraryName}"!`));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));
        } catch (error) {
            revokeSpinner.fail(chalk.red(`Error revoking authorization for "${libraryName}":`));
            console.error(chalk.red(`  ${getRevertReason(error)}`));
            if (process.env.DEBUG) console.error(error.stack);
        }
    });

/**
 * Command: tpkm delete <libraryName>
 * Deletes the entire library record from the smart contract registry.
 * This is typically restricted by the contract to the library owner and may require
 * that the library has no published versions remaining. THIS ACTION IS IRREVERSIBLE.
 */
program
    .command('delete <libraryName>')
    .description('Delete a registered library record entirely. Requires ownership and NO published versions. IRREVERSIBLE.')
    .action(async (libraryName) => {
        await ensureNetworkClientsInitialized(); // Ensure network clients are ready.
        // Load wallet/signer; this will prompt for password if keystore is used.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return; // Exit if wallet loading failed.

        console.log(chalk.red.bold(`\n!!! WARNING: IRREVERSIBLE ACTION !!!`));
        console.log(chalk.yellow(`You are attempting to permanently delete the library record for "${libraryName}" from the registry.`));
        console.log(chalk.yellow(`This will remove all associated metadata (owner, description, tags, versions list, access control).`));
        console.log(chalk.yellow(`Published version data (IPFS hashes), if any were on IPFS, might remain on IPFS but will become unresolvable via this TPKM registry instance.`));

        // --- Pre-checks ---
        const checkSpinner = ora({ text: `Verifying ownership and conditions for deleting "${libraryName}"...`, color: 'gray' }).start();
        let preCheckPassed = false;
        try {
            // 1. Verify ownership.
            const libInfo = await contractReadOnly.getLibraryInfo(libraryName); // Throws if lib doesn't exist.
            const ownerAddr = libInfo[0];
            if (ownerAddr.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                checkSpinner.fail(); // Fail spinner before throwing
                throw new Error(`CLIENT_VALIDATION: Permission Denied: Your wallet (${currentSignerWallet.address}) is not the owner (${ownerAddr}) of library "${libraryName}".`);
            }
            checkSpinner.text = `Ownership confirmed for "${libraryName}". Checking for published versions...`;

            // 2. Check for published versions. This MUST be a hard stop if versions exist.
            const versions = await contractReadOnly.getVersionNumbers(libraryName);
            if (versions.length > 0) {
                checkSpinner.fail(); // Fail spinner before throwing
                throw new Error(`CLIENT_VALIDATION: Cannot delete library "${libraryName}": It currently has ${versions.length} published version(s). The smart contract (and CLI policy) prevents deletion of libraries with active versions. Please deprecate or manage these versions first.`);
            }

            checkSpinner.succeed(chalk.gray(`Checks passed: Ownership confirmed and no published versions found for "${libraryName}". Ready for deletion confirmation.`));
            preCheckPassed = true;

        } catch (checkError) {
            // If spinner was not already failed (e.g., getLibraryInfo failed before version check)
            if (checkSpinner.isSpinning) {
                checkSpinner.fail();
            }
            // Handle client-side validation errors directly, parse others.
            if (checkError.message && checkError.message.startsWith('CLIENT_VALIDATION: ')) {
                console.error(chalk.red('Pre-deletion check failed:'), chalk.redBright(checkError.message.substring('CLIENT_VALIDATION: '.length)));
            } else {
                console.error(chalk.red('Pre-deletion check failed:'), getRevertReason(checkError));
            }
            return; // Stop execution if any pre-check fails.
        }

        // Should be redundant if the catch block always returns, but added for safety.
        if (!preCheckPassed) {
             console.log(chalk.blue('Pre-checks did not pass. Deletion aborted.'));
             return;
        }
        // --- End of Pre-checks ---


        // --- Confirmation Prompt (Crucial for destructive actions) ---
        try {
            const { confirmYes } = await inquirer.prompt([{
                type: 'input', // Using 'input' to force typing 'yes'
                name: 'confirmYes',
                message: chalk.red.bold(`Type 'yes' to confirm you want to PERMANENTLY delete the library "${libraryName}":`),
                validate: input => input.toLowerCase() === 'yes' || "Please type 'yes' to confirm deletion.",
                filter: input => input.toLowerCase() // Ensure comparison works by lowercasing input
            }]);

            if (confirmYes !== 'yes') {
                console.log(chalk.blue('Library deletion cancelled by user (first confirmation not received as "yes").'));
                return;
            }

            const { confirmName } = await inquirer.prompt([{
                type: 'input',
                name: 'confirmName',
                message: chalk.red.bold(`For final confirmation, type the library name "${libraryName}" again to finalize deletion:`),
                validate: input => input === libraryName || `Input must exactly match the library name "${libraryName}".`
            }]);

            if (confirmName !== libraryName) { // Second confirmation must match exact name
                console.log(chalk.blue('Library deletion cancelled by user (library name mismatch).'));
                return;
            }
        } catch (promptError) {
             console.error(chalk.red('Error during confirmation prompt:'), promptError.message);
             return; // Exit if prompting itself fails
        }
        // --- End Confirmation ---


        // If both confirmations pass, proceed with the transaction.
        const deleteSpinner = ora({ text: `Sending transaction to delete library "${libraryName}"...`, color: 'yellow' }).start();
        try {
            // Call the smart contract's `deleteLibrary` function.
            const tx = await writableContractInstance.deleteLibrary(libraryName);
            deleteSpinner.text = `Waiting for transaction confirmation (Hash: ${tx.hash.substring(0,10)}...)...`;
            await tx.wait(1); // Wait for 1 confirmation.
            deleteSpinner.succeed(chalk.green.bold(`Library "${libraryName}" deleted successfully from the registry!`));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));
        } catch (error) {
            deleteSpinner.fail(chalk.red(`Error deleting library "${libraryName}":`));
            // The contract itself should revert if conditions aren't met (e.g., versions still exist despite client check).
            console.error(chalk.red(`  ${getRevertReason(error)}`));
            if (process.env.DEBUG) {
                console.error(error.stack);
            }
        }
    });

/**
 * Command: tpkm abandon-registry
 * Transfers ownership of the LibraryRegistry smart contract itself to a specified burn address
 * (defaulting to 0x...dEaD). This is an EXTREMELY DANGEROUS and IRREVERSIBLE action,
 * effectively relinquishing all administrative control over the contract instance (like pausing,
 * upgrading via Ownable2Step, etc.). Only the current contract owner can execute this.
 */
program
    .command('abandon-registry')
    .description('IRREVERSIBLY transfer contract ownership to a burn address (e.g., 0x...dEaD). DANGEROUS.')
    .option('--burn-address <address>', 'The address to transfer ownership to (cannot be recovered)', '0x000000000000000000000000000000000000dEaD') // Common dead address
    .action(async (options) => {
        await ensureNetworkClientsInitialized(); // Network access needed.
        // Need signer who MUST be the current contract owner.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return;

        const burnAddress = options.burnAddress;

        // Validate the burn address format.
        if (!ethers.isAddress(burnAddress)) {
            console.error(chalk.red(`Invalid burn address provided: ${burnAddress}`));
            return;
        }
        if (burnAddress === ethers.ZeroAddress) {
            console.warn(chalk.yellow(`Warning: Transferring ownership to the zero address (${ethers.ZeroAddress}) is valid but means NO ONE can ever control it again.`));
        }

        // --- Display Strong Warnings ---
        console.log(chalk.red.bold('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'));
        console.log(chalk.red.bold('!!!              EXTREME DANGER ZONE            !!!'));
        console.log(chalk.red.bold('!!!    YOU ARE ABOUT TO ABANDON THE CONTRACT    !!!'));
        console.log(chalk.red.bold('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'));
        console.log(chalk.red(`This will transfer ownership of the LibraryRegistry smart contract:`));
        console.log(chalk.yellow(`  Contract Address: ${currentActiveContractAddress}`));
        console.log(chalk.yellow(`  Current Network:  ${currentActiveNetworkName} (${currentActiveRpcUrl})`));
        console.log(chalk.red(`Ownership will be PERMANENTLY transferred to:`));
        console.log(chalk.yellow(`  Burn Address:     ${burnAddress}`));
        console.log(chalk.red('After this action, your current wallet (and likely anyone else) will lose ALL administrative control over this contract instance FOREVER.'));
        console.log(chalk.red('Functions like pausing, unpausing, upgrading (if applicable), or changing fees (if any) will become unusable.'));
        console.log(chalk.red.bold('THERE IS NO UNDO.\n'));


        // --- Pre-check: Verify Signer is Current Contract Owner ---
        const checkOwnerSpinner = ora({ text: `Verifying you are the current contract owner...`, color: 'gray' }).start();
        let currentContractOwner;
        try {
            // Assumes the contract implements OpenZeppelin's Ownable and has an `owner()` view function.
            currentContractOwner = await writableContractInstance.owner();
            if (currentContractOwner.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                 checkOwnerSpinner.fail();
                console.error(chalk.red(`Error: Your current wallet (${currentSignerWallet.address}) is NOT the owner of the contract.`));
                console.error(chalk.red(`Current owner is: ${currentContractOwner}`));
                console.error(chalk.red(`Only the current owner can transfer ownership.`));
                return;
            }
             checkOwnerSpinner.succeed(chalk.gray(`Confirmed: Your wallet (${currentSignerWallet.address}) is the current owner.`));
        } catch (ownerCheckError) {
             checkOwnerSpinner.fail();
            console.error(chalk.red('Error verifying contract ownership:'), getRevertReason(ownerCheckError));
             console.error(chalk.yellow('Ensure the contract ABI includes the `owner()` function and the contract is deployed and accessible.'));
            return;
        }
        // --- End Pre-check ---


        // --- Multi-Step Confirmation ---
         // Use a separate readline interface for complex confirmations if inquirer isn't sufficient.
         const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
         const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

         try {
             const confirm1 = await askQuestion(chalk.yellow.bold('Do you understand the consequences and wish to proceed with abandoning the contract? (yes/no): '));
             if (confirm1.toLowerCase() !== 'yes') {
                 console.log(chalk.green('Registry abandonment cancelled by user.'));
                 return;
             }

             const confirmText = `abandon contract ${currentActiveContractAddress.slice(0, 6).toLowerCase()}`;
             const confirm2 = await askQuestion(chalk.yellow.bold(`This action is final. To confirm, please type EXACTLY: "${confirmText}": `));
             if (confirm2 !== confirmText) {
                 console.log(chalk.red('Confirmation text did not match. Registry abandonment cancelled for safety.'));
                 return;
             }
         } finally {
             rl.close(); // Ensure readline is closed regardless of outcome.
         }
        // --- End Confirmation ---


        // --- Execute Ownership Transfer ---
        const abandonSpinner = ora({ text: `Sending transaction to transfer ownership to ${burnAddress}...`, color: 'yellow' }).start();
        try {
            // Assumes OpenZeppelin's `Ownable.sol` `transferOwnership(address newOwner)` function.
            const tx = await writableContractInstance.transferOwnership(burnAddress);
            abandonSpinner.text = `Waiting for transaction confirmation (Hash: ${tx.hash.substring(0,10)}...)...`;
            await tx.wait(1);
            abandonSpinner.succeed(chalk.green.bold('Contract ownership successfully transferred to the burn address!'));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));
            console.log(chalk.red.bold('Administrative control via your wallet is now PERMANENTLY GONE for this contract instance.'));

            // Verify the new owner on-chain.
            const verifyOwnerSpinner = ora({ text: `Verifying new owner on-chain...`, color: 'gray' }).start();
            try {
                 const newOwner = await writableContractInstance.owner(); // Call owner() again
                 if (newOwner.toLowerCase() === burnAddress.toLowerCase()) {
                      verifyOwnerSpinner.succeed(chalk.green(`Confirmed: New contract owner is now ${newOwner}`));
                 } else {
                      verifyOwnerSpinner.fail(chalk.red.bold(`CRITICAL ERROR: New owner (${newOwner}) does NOT match the intended burn address (${burnAddress}). Investigate IMMEDIATELY!`));
                 }
            } catch (verifyError) {
                 verifyOwnerSpinner.fail(chalk.red(`Error re-fetching owner after transfer: ${verifyError.message}`));
            }

        } catch (error) {
            abandonSpinner.fail(chalk.red('Error transferring contract ownership:'));
            console.error(chalk.red(`  ${getRevertReason(error)}`));
            if (process.env.DEBUG) console.error(error.stack);
        }
    });

/**
 * Command: tpkm init
 * Creates a template `lib.config.json` file in the current working directory.
 * This file is required for publishing a library and contains metadata like name, version, and dependencies.
 */
program
    .command('init')
    .description('Initialize a new lib.config.json file in the current directory for a TPKM library.')
    .action(async () => {
        const configFilePath = path.join(process.cwd(), 'lib.config.json');
        console.log(chalk.yellow('Initializing new TPKM library configuration (lib.config.json)...'));

        // Check if config file already exists and prompt before overwriting.
        if (fs.existsSync(configFilePath)) {
            const { overwrite } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'overwrite',
                    message: chalk.yellow(`Warning: 'lib.config.json' already exists in this directory (${configFilePath}). Overwrite it?`),
                    default: false, // Default to No for safety.
                }
            ]);
            if (!overwrite) {
                console.log(chalk.blue('Initialization cancelled. Existing lib.config.json preserved.'));
                return;
            }
             console.log(chalk.yellow('Overwriting existing lib.config.json...'));
        }

        // --- Interactive Questions for Config ---
        const questions = [
            {
                type: 'input',
                name: 'name',
                message: 'Library name:',
                // Suggest current directory name, cleaned to be a valid package name.
                default: path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, ''),
                validate: function (value) {
                    // Stricter validation (similar to npm): lowercase letters, numbers, hyphens. No leading/trailing hyphens.
                    if (value && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 214) {
                        return true;
                    }
                    return 'Invalid name. Use lowercase letters, numbers, and hyphens only (e.g., my-cool-library). Cannot start/end with hyphen.';
                },
            },
            {
                type: 'input',
                name: 'version',
                message: 'Initial version:',
                default: '0.1.0', // Common starting version.
                validate: function (value) {
                    if (semver.valid(value)) { // Use semver for robust validation.
                        return true;
                    }
                    return 'Invalid version. Please use semantic versioning (e.g., 1.0.0, 0.2.1-beta.1).';
                },
            },
            {
                type: 'input',
                name: 'description',
                message: 'Description (optional):',
                default: '',
            },
            {
                type: 'input',
                name: 'language',
                message: 'Primary language (optional, e.g., javascript, python, solidity):',
                default: '',
            },
            // Potential future questions: author, license, repository URL...
        ];

        try {
            const answers = await inquirer.prompt(questions);

            // --- Construct the Config Object ---
            const libConfig = {
                // Use schema versioning for future compatibility? e.g., "$schemaVersion": "1.0"
                name: answers.name,
                version: answers.version,
                // Only include optional fields if they have a value.
                ...(answers.description && { description: answers.description }),
                ...(answers.language && { language: answers.language }),
                // Include an empty dependencies object by default for users to fill in.
                dependencies: {
                    // "example-dependency": "^1.2.0" // Example format
                },
                // Add other common fields?
                // "author": "",
                // "license": "MIT", // Default license?
                // "repository": { "type": "git", "url": "" }
            };

            // --- Write the File ---
            // Use JSON.stringify with indentation for readability.
            fs.writeFileSync(configFilePath, JSON.stringify(libConfig, null, 2), 'utf8'); // Use 2-space indentation.
            console.log(chalk.green(`\n'lib.config.json' created successfully at: ${configFilePath}`));
            console.log(chalk.blue('\nNext steps:'));
            console.log(chalk.blue('  1. Add your library code files to this directory.'));
            console.log(chalk.blue('  2. Update the `dependencies` section in lib.config.json if your library uses other TPKM packages.'));
            console.log(chalk.blue(`  3. Register your library name (if not done yet): tpkm register ${answers.name} [options]`));
            console.log(chalk.blue('  4. Publish your first version: tpkm publish .'));

        } catch (error) {
            // Catch errors during the inquirer prompt phase.
            console.error(chalk.red('Error during initialization:'), error.message);
            if (process.env.DEBUG) console.error(error);
        }
    });


// =============================================================================
// --- Parse CLI Arguments and Execute ---
// =============================================================================

// Process the command-line arguments based on the defined commands and options.
program.parse(process.argv);

// --- Handle edge cases where no command is provided ---

// If no arguments are given (e.g., just running `tpkm`), or only global options like `--help`,
// display the main help menu. Commander might handle `--help` automatically, but this catches the bare command case.
// Exclude the case where the only argument is 'config' itself (handled below).
const args = process.argv.slice(2); // Get arguments after 'node' and script path.
if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    if (!program.commands.find(cmd => cmd.name() === args[0])) { // Avoid showing help if a valid command was run without args
         program.outputHelp();
    }
}
// If only 'tpkm config' is run, without a specific config subcommand (add, list, etc.),
// show the help specific to the 'config' command group.
else if (args.length === 1 && args[0] === 'config') {
    configCommand.outputHelp();
}
// If only 'tpkm wallet' is run, show help for the wallet command group.
else if (args.length === 1 && args[0] === 'wallet') {
     walletCommand.outputHelp();
}

// For other cases (valid command + arguments), commander handles the execution via the `.action()` handlers defined above.