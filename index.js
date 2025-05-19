#!/usr/bin/env node
// cli/index.js
// Main entry point for the Taco Package Manager (TPKM) command-line interface.

// --- Default Public Network Configuration ---
// This constant provides a fallback value if no user configuration for IPFS is found or specified.
const DEFAULT_IPFS_API_URL = 'http://127.0.0.1:5001/api/v0'; // Default IPFS API endpoint (local node).

// --- Core Node.js Modules ---
const os = require('os'); // Provides operating system-related utility methods and properties (e.g., home directory).
const path = require('path'); // Provides utilities for working with file and directory paths.
const zlib = require('zlib'); // Provides compression and decompression functionalities (e.g., gzip for archives).
const { pipeline } = require('stream/promises'); // Utility for robustly piping streams together using async/await, ensuring proper error handling.

// --- Third-party CLI Utility Modules ---
const ora = require('ora'); // Displays elegant spinners in the terminal for long-running operations.
const Table = require('cli-table3'); // Creates formatted tables for command-line output.
const { Command } = require('commander'); // Framework for building command-line interfaces (defining commands, options, parsing arguments).
const chalk = require('chalk'); // Adds color and styling to terminal output (version 4 is used).
const inquirer = require('inquirer'); // Creates interactive command-line prompts (e.g., for passwords, confirmations).

// --- Ethereum Interaction ---
const { ethers } = require('ethers'); // Comprehensive library for interacting with Ethereum blockchains (wallets, contracts, providers).

// --- File System & Archiving ---
const fs = require('fs-extra'); // Extends the native 'fs' module with additional methods like `ensureDirSync` and promise-based functions.
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
const keystoreDir = path.join(os.homedir(), '.tacopkm'); // Directory in the user's home folder (e.g., ~/.tacopkm).
const keystorePath = path.join(keystoreDir, 'keystore.json'); // Full path to the keystore file (e.g., ~/.tacopkm/keystore.json).

// --- Network Configuration File Path ---
// Defines where TPKM network profiles (RPC URLs, contract addresses) are stored.
const networkConfigDir = path.join(os.homedir(), '.tacopkm'); // Directory for network configuration (same as keystore).
const networkConfigPath = path.join(networkConfigDir, 'networks.json'); // Full path to the network configuration file (e.g., ~/.tacopkm/networks.json).

// --- Ethers.js & IPFS Client Setup (Lazy Initialized) ---
// These clients are initialized only when needed ('on demand') to:
// - Avoid unnecessary connections.
// - Allow for dynamic network switching based on configuration.
// - Improve startup time of the CLI.
let provider = null; // Ethers.js provider instance for read-only blockchain interaction.
let registryAbi = null; // ABI (Application Binary Interface) for the LibraryRegistry smart contract (loaded once).
let contractReadOnly = null; // Read-only Ethers.js contract instance.
let ipfs = null; // IPFS HTTP client instance.

let networkClientsInitialized = false; // Flag to track if clients have been initialized for the current session.

// Variables to store details of the currently active network configuration.
// These are updated by ensureNetworkClientsInitialized.
let currentActiveNetworkName = 'unknown'; // Name of the active network profile (e.g., 'sepolia-public', 'custom (.env)').
let currentActiveContractAddress = 'unknown'; // Address of the LibraryRegistry contract being used.
let currentActiveRpcUrl = 'unknown'; // RPC URL being used for blockchain interaction.

// Writable contract instance and signer wallet are loaded only when a transaction needs to be signed
// (e.g., publishing, registering, deprecating). This is handled by loadWalletAndConnect.
let signerWallet = null; // Ethers.js Wallet instance connected to the provider.
let writableContract = null; // Writable Ethers.js contract instance connected to the signer.

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
        fs.writeFileSync(networkConfigPath, JSON.stringify(config, null, 2), 'utf8'); // Write JSON with 2-space indentation.
    } catch (error) {
        console.error(chalk.red(`Error saving network config to ${networkConfigPath}:`), error.message);
        // Depending on severity, one might consider exiting the process here.
    }
}

/**
 * Ensures that Ethereum provider, smart contract instances (read-only), and IPFS client are initialized.
 * This function establishes the connection settings for subsequent blockchain and IPFS operations.
 * It follows a priority order for configuration:
 * 1. Active network profile specified in `~/.tacopkm/networks.json`.
 * 2. Environment variables (`RPC_URL`, `CONTRACT_ADDRESS`, `IPFS_API_URL`) in `cli/.env`.
 * If configuration is not found through these sources, the process will exit with guidance.
 * It also handles loading the contract ABI and performs basic connectivity checks.
 * The process will exit (process.exit(1)) if essential configuration cannot be determined
 * or if connections to Ethereum RPC or IPFS daemon fail.
 * @throws Will exit the process (process.exit(1)) if critical configuration is missing or connections fail.
 */
async function ensureNetworkClientsInitialized() {
    // Avoid redundant initialization within the same execution context.
    if (networkClientsInitialized) return;

    // Load the contract ABI only once. This is needed for creating contract instances.
    if (!registryAbi) {
        try {
            // Assumes ABI file is located relative to this script in the './abi/' directory.
            registryAbi = require('./abi/LibraryRegistry.json').abi;
        } catch (abiError) {
            console.error(chalk.red(`Critical Error: Failed to load LibraryRegistry ABI from ./abi/LibraryRegistry.json. Ensure the file exists and is valid.`));
            console.error(chalk.red(`ABI Load Error: ${abiError.message}`));
            process.exit(1);
        }
    }

    const userConfig = loadNetworkConfig(); // Load user's network profiles from ~/.tacopkm/networks.json

    let rpcToUse = null;
    let contractAddrToUse = null;
    let networkNameToUse = '';
    let sourceOfConfig = ''; // For logging where the configuration originated.

    // Priority 1: Active network profile from user's networks.json
    if (userConfig.activeNetwork && userConfig.networks[userConfig.activeNetwork]) {
        const activeProfile = userConfig.networks[userConfig.activeNetwork];
        // Basic validation of the active profile's content.
        if (activeProfile.rpcUrl && activeProfile.contractAddress && ethers.isAddress(activeProfile.contractAddress)) {
            rpcToUse = activeProfile.rpcUrl;
            contractAddrToUse = activeProfile.contractAddress;
            networkNameToUse = userConfig.activeNetwork;
            sourceOfConfig = `active network profile "${networkNameToUse}" from ~/.tacopkm/networks.json`;
        } else {
            console.warn(chalk.yellow(`Warning: Active network profile "${userConfig.activeNetwork}" in networks.json is incomplete or invalid. Falling back...`));
        }
    }

    // Priority 2: Environment variables from cli/.env (acts as an override or alternative if networks.json is not set or invalid).
    if (!rpcToUse || !contractAddrToUse) {
        const envRpcUrl = process.env.RPC_URL;
        const envContractAddress = process.env.CONTRACT_ADDRESS;
        if (envRpcUrl && envContractAddress && ethers.isAddress(envContractAddress)) {
            rpcToUse = envRpcUrl;
            contractAddrToUse = envContractAddress;
            networkNameToUse = 'custom (.env)'; // Indicates that .env settings are being used.
            sourceOfConfig = 'network configuration from cli/.env file';
        }
    }

    // If no configuration found after checking networks.json and .env, guide user and exit.
    if (!rpcToUse || !contractAddrToUse) {
        console.error(chalk.red('Error: No usable blockchain network configuration found.'));
        console.log(chalk.yellow('Before using network-dependent commands, please configure a network:'));
        console.log(chalk.yellow('  1. Add a network profile: ' + chalk.bold(`tpkm config add <profile_name> --rpc <RPC_URL> --contract <CONTRACT_ADDRESS>`)));
        console.log(chalk.yellow('  2. Set it as active:    ' + chalk.bold(`tpkm config set-active <profile_name>`)));
        console.log(chalk.yellow('Alternatively, you can set RPC_URL and CONTRACT_ADDRESS in the cli/.env file.'));
        process.exit(1); // Exit if no network is configured.
    }

    // Determine IPFS API URL (Priority: .env > Default).
    const envIpfsApiUrl = process.env.IPFS_API_URL;
    const ipfsApiUrlToUse = envIpfsApiUrl || DEFAULT_IPFS_API_URL;
    const ipfsSource = envIpfsApiUrl ? 'cli/.env' : 'default setting';

    // Final validation: Ensure we have all necessary URLs/addresses before proceeding.
    // This check is somewhat redundant due to earlier checks but serves as a final safeguard.
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

        // Verify contract connection by trying to get its address. This also implicitly confirms the RPC is reachable.
        // Use the address returned by the contract as the definitive current address.
        currentActiveContractAddress = await contractReadOnly.getAddress();
    } catch (ethError) {
        console.error(chalk.red(`Failed to connect to Ethereum RPC "${rpcToUse}" or initialize contract at "${contractAddrToUse}".`));
        console.error(chalk.red(`Error: ${ethError.message}`));
        process.exit(1);
    }

    // Update global variables with the final, validated settings.
    currentActiveNetworkName = networkNameToUse;
    currentActiveRpcUrl = rpcToUse; // Store the RPC URL being used.

    // Initialize IPFS client and test connection.
    try {
        // Dynamically require ipfs-http-client only when needed to reduce initial load time.
        const { create: createIpfsClient } = require('ipfs-http-client');
        ipfs = createIpfsClient({ url: ipfsApiUrlToUse });
        // Perform a simple check to ensure the IPFS daemon is reachable by fetching its version.
        await ipfs.version(); // This will throw an error if the connection fails.
        console.log(chalk.cyan(`Connected to IPFS API: ${ipfsApiUrlToUse} (Source: ${ipfsSource})`));
    } catch(ipfsError) {
        console.error(chalk.red(`Failed to connect to IPFS API at ${ipfsApiUrlToUse}.`));
        console.error(chalk.yellow(`Please ensure your IPFS daemon is running and the API server is enabled and accessible.`));
        console.error(chalk.red(`IPFS Connection Error: ${ipfsError.message}`));
        // Most TPKM operations require IPFS, so exit if connection fails.
        process.exit(1);
    }

    // Log the final effective settings being used for clarity.
    console.log(chalk.blue(`Effective RPC URL: ${currentActiveRpcUrl}`));
    console.log(chalk.blue(`Effective Contract Address: ${currentActiveContractAddress}`));

    networkClientsInitialized = true; // Mark initialization as complete for this session.
}


// --- Wallet Management Helper Functions ---

/**
 * Retrieves the public Ethereum address from the local keystore file (~/.tacopkm/keystore.json).
 * This function reads the address directly from the JSON structure without requiring decryption,
 * making it a quick way to get the address if the keystore is present.
 * @returns {Promise<string|null>} The checksummed public address if the keystore is found and valid, otherwise null.
 * Logs appropriate error or guidance messages to the console on failure.
 */
async function getPublicAddressFromKeystore() {
    if (!fs.existsSync(keystorePath)) {
        console.error(chalk.red(`No wallet keystore found at ${keystorePath}.`));
        console.log(chalk.yellow(`Use "tpkm wallet create" or "tpkm wallet import <privateKey>" to set up a wallet.`));
        return null;
    }
    try {
        const keystoreJson = fs.readFileSync(keystorePath, 'utf8');
        const walletData = JSON.parse(keystoreJson); // Keystore file is expected to be a JSON object.
        if (walletData && walletData.address) {
            // Use ethers.getAddress() to ensure the address is in checksum format, which is standard practice.
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
 * Handles password input via an interactive prompt or the TPKM_WALLET_PASSWORD environment variable.
 * Ensures network clients are initialized before attempting to connect the wallet.
 * Caches the loaded wallet and writable contract instance for the current session to avoid repeated decryption.
 * @param {boolean} [promptForPassword=true] - If true, prompts the user interactively for the password.
 * If false, attempts to use the TPKM_WALLET_PASSWORD environment variable.
 * @returns {Promise<{wallet: ethers.Wallet, contract: ethers.Contract}>} An object containing the initialized signer wallet
 * and the writable contract instance.
 * @throws Will exit the process (process.exit(1)) if:
 * - Keystore is not found.
 * - Decryption fails (e.g., wrong password, corrupted keystore).
 * - Password is required but not provided (and not in env var).
 * - Network initialization or connection fails.
 */
async function loadWalletAndConnect(promptForPassword = true) {
    // Return cached instances if they were already loaded in this CLI execution session.
    if (signerWallet && writableContract) {
        return { wallet: signerWallet, contract: writableContract };
    }

    // 1. Check for keystore existence.
    if (!fs.existsSync(keystorePath)) {
        console.error(chalk.red(`No wallet keystore found at ${keystorePath}.`));
        console.log(chalk.yellow(`Use "tpkm wallet create" or "tpkm wallet import <privateKey>" to set up a wallet.`));
        process.exit(1);
    }

    // 2. Read the encrypted keystore JSON from the file.
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
                mask: '*', // Mask password input in the terminal (display asterisks).
            }
        ]);
        password = answers.password;
        if (!password) { // User likely just pressed Enter without typing.
            console.error(chalk.red('Password cannot be empty. Aborting.'));
            process.exit(1);
        }
    } else if (process.env.TPKM_WALLET_PASSWORD) {
        password = process.env.TPKM_WALLET_PASSWORD;
        console.log(chalk.gray('Using password from TPKM_WALLET_PASSWORD environment variable.'));
    } else {
        // Password is required (as promptForPassword was false, implying non-interactive use) but not found in env var.
        console.error(chalk.red('Password required for wallet operation.'));
        console.error(chalk.yellow('Provide password via interactive prompt or set the TPKM_WALLET_PASSWORD environment variable.'));
        process.exit(1);
    }

    // 4. Decrypt the wallet using the password and keystore JSON.
    let decryptedWalletBase; // The raw Ethers.js Wallet object before connecting to a provider.
    const decryptSpinner = ora({ text: 'Decrypting wallet...', color: 'yellow' }).start();
    try {
        decryptedWalletBase = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
        decryptSpinner.succeed(chalk.blue(`Wallet decrypted. Address: ${decryptedWalletBase.address}`));
    } catch (error) {
        // Common cause for decryption failure is an incorrect password.
        decryptSpinner.fail(chalk.red('Failed to decrypt wallet. Incorrect password or corrupted keystore file.'));
        if (process.env.DEBUG) console.error(error); // Show full error details if DEBUG environment variable is set.
        process.exit(1);
    }

    // 5. Ensure network clients (provider, read-only contract, ABI) are initialized and ready.
    // This needs to happen *after* successful decryption but *before* connecting the wallet to the provider.
    await ensureNetworkClientsInitialized();

    // 6. Connect the decrypted wallet to the provider and create a writable contract instance.
    try {
        // The `provider` is guaranteed to be initialized by `ensureNetworkClientsInitialized`.
        signerWallet = decryptedWalletBase.connect(provider);

        // Create a writable contract instance using the contract address determined by `ensureNetworkClientsInitialized`,
        // the loaded ABI, and the newly connected signer wallet.
        // `currentActiveContractAddress` and `registryAbi` are set by `ensureNetworkClientsInitialized`.
        writableContract = new ethers.Contract(currentActiveContractAddress, registryAbi, signerWallet);

        console.log(chalk.blue(`Wallet connected to network "${currentActiveNetworkName}". Ready to sign transactions.`));

        // Cache the instances for potential reuse in this session.
        return { wallet: signerWallet, contract: writableContract };
    } catch (connectError) {
        // Handle errors that might occur during the connection phase (e.g., provider issues after initial check).
        console.error(chalk.red('Failed to connect wallet to provider or create writable contract instance:'), connectError.message);
        if (process.env.DEBUG) console.error(connectError);
        process.exit(1);
    }
}


// --- Archiving and IPFS Helper Functions ---

/**
 * Archives the contents of a specified directory into a gzipped tarball (.tar.gz).
 * @param {string} sourceDir - The absolute or relative path to the directory to be archived.
 * @param {string} outputFilePath - The absolute or relative path where the resulting .tar.gz file should be saved.
 * @returns {Promise<void>} A promise that resolves when archiving is successfully completed, or rejects on error.
 */
function archiveDirectory(sourceDir, outputFilePath) {
    return new Promise((resolve, reject) => {
        // Create a writable stream to the target archive file path.
        const output = fs.createWriteStream(outputFilePath);
        // Initialize the archiver in 'tar' mode with gzip compression enabled.
        const archive = archiver('tar', {
            gzip: true,
            zlib: { level: 9 } // Set compression level (optional, 9 is highest, 1 is fastest).
        });

        // Event listener for when the output stream is closed (archive is fully written to disk).
        output.on('close', () => {
            console.log(chalk.gray(`Archive created: ${outputFilePath} (${archive.pointer()} total bytes)`));
            resolve(); // Signal successful completion.
        });

        // Event listener for non-critical warnings from the archiver.
        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') {
                // Example: A symbolic link points to a non-existent file. Log it but continue archiving.
                console.warn(chalk.yellow('Archiver warning (e.g., broken symlink):'), err);
            } else {
                // Treat other, potentially more severe, warnings as errors.
                reject(err);
            }
        });

        // Event listener for critical errors encountered during the archiving process.
        archive.on('error', (err) => {
            reject(err); // Signal failure.
        });

        // Pipe the archive data to the output file stream.
        archive.pipe(output);

        // Add the contents of the source directory to the root of the archive.
        // The second argument `false` ensures contents are at the root, not inside a folder named after sourceDir.
        archive.directory(sourceDir, false);

        // Finalize the archive. No more files can be added after this call.
        // This triggers the 'close' event on the output stream once all data has been written.
        archive.finalize();
    });
}

/**
 * Uploads a file (typically an archive) to the configured IPFS node.
 * @param {string} filePath - The path to the local file to be uploaded.
 * @returns {Promise<string>} The IPFS Content Identifier (CID) string of the uploaded file.
 * @throws Will throw an error if the IPFS client is not initialized or if the upload fails.
 */
async function uploadToIpfs(filePath) {
    // Ensure IPFS client is ready (it should have been initialized by a calling command handler
    // via ensureNetworkClientsInitialized).
    if (!ipfs) {
        throw new Error("IPFS client not initialized. Call ensureNetworkClientsInitialized first.");
    }

    let fileContent;
    try {
        fileContent = fs.readFileSync(filePath); // Read the entire file into a buffer for upload.
    } catch (readError) {
        console.error(chalk.red(`Error reading file for IPFS upload: ${filePath}`), readError.message);
        throw readError; // Propagate the error to the caller.
    }

    try {
        // Use the initialized 'ipfs' client to add the file content to IPFS.
        const result = await ipfs.add(fileContent);
        const cidString = result.cid.toString(); // Get the CID as a string.
        console.log(chalk.gray(`Uploaded to IPFS. CID: ${cidString}`));
        return cidString; // Return the CID of the uploaded content.
    } catch (error) {
        console.error(chalk.red('IPFS upload failed:'), error.message);
        // Provide additional guidance for common IPFS issues.
        console.error(chalk.yellow('Ensure your IPFS daemon is running and accessible at the configured API URL.'));
        throw error; // Re-throw the error to be handled by the calling command.
    }
}

/**
 * Downloads a gzipped tarball from IPFS using its CID and extracts its contents to a target directory.
 * Uses streams for efficiency, especially with large files, to avoid loading entire archives into memory.
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

        // Create the necessary streams for the pipeline:
        // 1. Source: Stream data directly from IPFS using `ipfs.cat(CID)`. This provides a readable stream of the file content.
        const sourceStream = ipfs.cat(ipfsHash);
        // 2. Decompressor: A stream to handle gzip decompression.
        const gunzip = zlib.createGunzip();
        // 3. Extractor: A stream to handle tar extraction into the target directory.
        const extract = tar.extract(targetPath);

        // Use stream.pipeline for robust error handling and proper stream cleanup.
        // It connects: IPFS Source Stream -> Gzip Decompressor -> Tar Extractor -> File System.
        await pipeline(sourceStream, gunzip, extract);

        downloadSpinner.succeed(chalk.green(`  -> Extracted ${libraryName}@${versionString} to ${targetPath}`));
    } catch (error) {
        downloadSpinner.fail(chalk.red(`  -> Failed to download or extract ${libraryName}@${versionString} from IPFS CID ${ipfsHash}`));
        console.error(chalk.red(`  -> Error: ${error.message}`));
        // Check for common IPFS errors, such as 'dag node not found', which indicates the content isn't available.
        if (error.message && error.message.toLowerCase().includes('dag node not found')) {
            console.error(chalk.yellow(`  -> The content for CID ${ipfsHash} might not be available on the IPFS network or pinned by any node.`));
        }
        throw error; // Re-throw to allow the calling function (e.g., install command) to handle the failure.
    }
}

/**
 * Recursively processes the installation of a library and its dependencies.
 * It resolves the appropriate version based on semantic versioning constraints,
 * checks for version conflicts with already resolved packages,
 * downloads the library archive from IPFS, extracts it, reads its dependencies from its config,
 * and then recursively calls itself for each sub-dependency.
 * Uses a map to track already resolved packages to prevent infinite loops and redundant downloads/extractions.
 *
 * @param {string} targetName - The name of the library to install.
 * @param {string} targetConstraint - The semantic version constraint (e.g., "^1.0.0", "1.2.3", ">=2.0.0 <3.0.0").
 * @param {Map<string, string>} resolvedMap - A Map where keys are library names and values are the exact resolved versions
 * already being installed or previously installed in this run. Used to detect
 * cycles and ensure version consistency across the dependency tree.
 * @param {string} installRoot - The root directory where all libraries will be installed (e.g., `tpkm_installed_libs`).
 * Libraries are typically placed in `installRoot/<libraryName>/<versionString>`.
 * @param {string|null} installerPublicAddress - The public address of the user initiating the installation, used for access checks.
 * @returns {Promise<void>} A promise that resolves when the library and its dependencies (if any) are processed successfully.
 * @throws Will throw an Error for critical issues such as:
 * - Version conflicts.
 * - Library or version not found in the registry.
 * - IPFS download or extraction failures.
 * - Access denied for private or licensed libraries.
 */
async function processInstallation(targetName, targetConstraint, resolvedMap, installRoot, installerPublicAddress) {
    console.log(chalk.blue(`Processing dependency: ${targetName}@${targetConstraint}`));

    // 1. Check if this package has already been resolved to a specific version in the current installation process.
    if (resolvedMap.has(targetName)) {
        const installedVersion = resolvedMap.get(targetName);
        // If the already resolved version satisfies the current constraint, no action is needed.
        if (semver.satisfies(installedVersion, targetConstraint)) {
            console.log(chalk.gray(`  -> ${targetName}@${installedVersion} already resolved and satisfies ${targetConstraint}. Skipping.`));
            return;
        } else {
            // If it doesn't satisfy, it's a version conflict.
            throw new Error(chalk.red(`Version conflict for "${targetName}": `) +
                            `Already resolved version ${chalk.yellow(installedVersion)} does not satisfy new constraint ${chalk.yellow(targetConstraint)}.`);
        }
    }

    // 2. Fetch available versions for the target library from the smart contract.
    let availableVersions;
    const fetchVersionsSpinner = ora({ text: `  -> Fetching available versions for ${targetName}...`, color: 'gray' }).start();
    try {
        if (!contractReadOnly) throw new Error("Read-only contract client not initialized. Cannot fetch versions.");
        availableVersions = await contractReadOnly.getVersionNumbers(targetName);
        if (!availableVersions || availableVersions.length === 0) {
            fetchVersionsSpinner.fail();
            throw new Error(`Library "${targetName}" not found or has no published versions in the registry.`);
        }
        fetchVersionsSpinner.succeed(chalk.gray(`  -> Found versions for ${targetName}: [${availableVersions.join(', ')}]`));
    } catch (error) {
        fetchVersionsSpinner.fail();
        throw new Error(`Failed to fetch available versions for "${targetName}": ${getRevertReason(error)}`);
    }

    // 3. Select the best version that satisfies the given constraint from the available versions.
    // `semver.maxSatisfying` picks the highest version that meets the constraint.
    const versionToInstall = semver.maxSatisfying(availableVersions, targetConstraint);
    if (!versionToInstall) {
        throw new Error(`No version found for library "${targetName}" that satisfies constraint "${targetConstraint}". Available versions: ${availableVersions.join(', ')}.`);
    }
    console.log(chalk.gray(`  -> Resolved ${targetName}@${targetConstraint} to version ${chalk.cyan(versionToInstall)}`));

    // 3a. Perform access check for this specific dependency using the installer's address.
    if (installerPublicAddress) {
        const depAccessCheckSpinner = ora({ text: `  -> Checking access for you to dependency "${targetName}"...`, color: 'gray' }).start();
        try {
            const hasAccessToDep = await contractReadOnly.hasAccess(targetName, installerPublicAddress);
            if (!hasAccessToDep) {
                depAccessCheckSpinner.fail();
                // Fetch library info to provide a more specific reason for access denial.
                let reasonSuffix = `Ensure you are authorized or have the required license.`;
                try {
                    const depLibInfo = await contractReadOnly.getLibraryInfo(targetName);
                    if (depLibInfo.isPrivate) {
                        reasonSuffix = `It's a private library. Please request authorization from the owner (${depLibInfo.owner}).`;
                    } else if (depLibInfo.licenseRequired) {
                        const feeStr = depLibInfo.licenseFee > 0 ? `${ethers.formatUnits(depLibInfo.licenseFee, 'ether')} ETH` : 'Free (claim required)';
                        reasonSuffix = `It requires a license (Fee: ${feeStr}). Purchase it using "tpkm purchase-license ${targetName}".`;
                    }
                } catch(e) { /* Ignore error if fetching more details fails; use the generic suffix. */ }
                throw new Error(`Access Denied for dependency "${targetName}". ${reasonSuffix}`);
            }
            depAccessCheckSpinner.succeed(chalk.gray(`  -> Access granted for dependency "${targetName}".`));
        } catch (accessError) {
            if(depAccessCheckSpinner.isSpinning) depAccessCheckSpinner.fail();
            // Re-throw the specific error message from the check or a general one.
            throw new Error(`Failed access check for dependency "${targetName}": ${accessError.message || getRevertReason(accessError)}`);
        }
    } else {
        // If no installer address is available (e.g., wallet not used), proceed assuming public access.
        // The contract's internal checks (if any) would still apply during actual data fetching if it were protected.
        console.log(chalk.gray(`  -> No local wallet address for access check on dependency "${targetName}". Assuming public access or contract will handle.`));
    }

    // 4. Mark this package and its resolved version in the map BEFORE fetching details or downloading.
    // This is crucial for preventing infinite loops in case of circular dependencies.
    resolvedMap.set(targetName, versionToInstall);

    // 5. Fetch detailed information (IPFS hash, sub-dependencies) for the chosen version from the contract.
    let ipfsHash;
    let subDependencies = []; // Dependencies of the current library being installed.
    const fetchInfoSpinner = ora({ text: `  -> Fetching info for ${targetName}@${versionToInstall}...`, color: 'gray' }).start();
    try {
        if (!contractReadOnly) throw new Error("Read-only contract client not initialized. Cannot fetch version info.");
        // Contract function getVersionInfo is expected to return: [ipfsHash, publisher, timestamp, isDeprecated, dependenciesArray]
        const versionData = await contractReadOnly.getVersionInfo(targetName, versionToInstall);
        ipfsHash = versionData[0]; // IPFS CID
        subDependencies = versionData[4] || []; // Array of { name: string, constraint: string }

        fetchInfoSpinner.succeed(chalk.gray(`  -> Info received for ${targetName}@${versionToInstall}.`));

        if (!ipfsHash || ipfsHash.trim() === '' || ipfsHash.startsWith('0x0000')) { // Basic validation of IPFS hash
            throw new Error(`Version ${versionToInstall} of "${targetName}" has an invalid or missing IPFS Hash in the registry.`);
        }
        if (versionData[3]) { // isDeprecated flag
            console.warn(chalk.yellow(`  -> Warning: Installing deprecated version ${targetName}@${versionToInstall}.`));
        }
    } catch (error) {
        fetchInfoSpinner.fail();
        resolvedMap.delete(targetName); // Backtrack: if info fetching fails, remove from resolved map as it wasn't successfully processed.
        throw new Error(`Failed to get version info for ${targetName}@${versionToInstall}: ${getRevertReason(error)}`);
    }

    // 6. Define the target path for extraction.
    // Example: ./tpkm_installed_libs/my-lib/1.2.3/
    const targetPath = path.join(installRoot, targetName, versionToInstall);

    // 7. Download the archive from IPFS and extract it to the target path.
    // `downloadAndExtract` handles its own spinner and stream pipeline internally.
    await downloadAndExtract(targetName, versionToInstall, ipfsHash, targetPath);

    // 8. Recursively process sub-dependencies found in the version's metadata.
    if (subDependencies.length > 0) {
        console.log(chalk.blue(`  -> Processing ${subDependencies.length} sub-dependencies for ${targetName}@${versionToInstall}...`));
        for (const subDep of subDependencies) {
            // Pass the installerPublicAddress down for access checks on sub-dependencies.
            await processInstallation(subDep.name, subDep.constraint, resolvedMap, installRoot, installerPublicAddress);
        }
        console.log(chalk.blue(`  -> Finished processing sub-dependencies for ${targetName}@${versionToInstall}.`));
    } else {
        console.log(chalk.gray(`  -> ${targetName}@${versionToInstall} has no sub-dependencies listed in its metadata.`));
    }
}


// --- Error Handling Helper ---

/**
 * Attempts to extract a more human-readable revert reason from an Ethereum transaction error object
 * or returns the message from a standard JavaScript Error.
 * It checks for known error patterns from Ethers.js, providers, and custom contract reverts.
 * @param {Error | any} error - The error object, which could be an Ethers.js error, a provider error, or a standard JS Error.
 * @returns {string} A user-friendly error message. Returns a generic message if no specific reason can be parsed.
 */
function getRevertReason(error) {
    const defaultUnknownError = "An unknown error occurred. Check details or enable debug mode (set DEBUG=true env var) for more info.";

    if (!error) {
        return defaultUnknownError;
    }

    // If it's already a simple string error message (e.g., from our client-side `throw new Error(...)`)
    // or not a typical Ethers.js error object, prioritize its message.
    if (typeof error === 'string') {
        return error;
    }
    if (typeof error !== 'object' || error === null) { // Handle non-object errors like numbers or booleans if they somehow occur.
        return String(error);
    }

    // Attempt to access nested error information, common in Ethers.js errors.
    // `error.error` often contains the core provider error.
    let internalError = (error.error && typeof error.error === 'object' && error.error.code) ? error.error : error;

    // Handle specific Ethers.js/provider error codes for common issues.
    if (internalError.code) {
        const errorCodeStr = String(internalError.code).toUpperCase();
        // These variables are module-level and should be accessible if populated.
        const addressString = signerWallet ? signerWallet.address : 'your configured wallet';
        const networkString = currentActiveNetworkName !== 'unknown' ? currentActiveNetworkName : 'the current network';

        switch (errorCodeStr) {
            case 'INSUFFICIENT_FUNDS':
            case '-32000': // Common code for "header not found" or "invalid json rpc response" which can mask insufficient funds on some nodes (like Ganache).
            case '-32003': // Sometimes "transaction rejected" which can also be due to insufficient funds.
                return `Insufficient funds in wallet (Address: ${addressString}) for transaction on network "${networkString}". Please add funds.`;
            case 'NONCE_EXPIRED': // Ethers.js specific for when nonce is too low.
                return `Nonce error (e.g., too low or already used). Try the operation again. If persisting, check network status or reset wallet nonce if using a local dev node.`;
            case 'REPLACEMENT_UNDERPRICED': // Transaction replacement (e.g., speed up) was sent with too low a gas price.
                return `Replacement transaction underpriced. The network may be busy, or the gas price was too low to replace the existing transaction.`;
            case 'CALL_EXCEPTION': // This often wraps contract reverts. We'll try to get a more specific reason below.
                break; // Fall through to try parsing revert data.
            case 'UNPREDICTABLE_GAS_LIMIT':
                // This often means the transaction is likely to revert on-chain for a reason that prevents gas estimation.
                // We'll attempt to extract a more specific contract revert reason below.
                // If not found, this code itself might be part of the specificReason or error.message.
                break; // Fall through.
            // Add other known Ethers.js or provider error codes here if needed for special handling.
        }
    }

    // Attempt to extract a contract revert reason.
    let specificReason = null;
    if (typeof internalError.reason === 'string') { // Ethers v6+ style for revert reasons.
        specificReason = internalError.reason;
    } else if (internalError.revert && Array.isArray(internalError.revert.args) && internalError.revert.args.length > 0 && typeof internalError.revert.args[0] === 'string') {
        // Older Ethers style or other libraries might structure revert info this way.
        specificReason = internalError.revert.args[0];
    } else if (internalError.data && registryAbi) { // Try to parse custom errors or other revert patterns if ABI is available.
        try {
            const iface = new ethers.Interface(registryAbi); // Use the loaded contract ABI.
            const parsedError = iface.parseError(internalError.data); // `internalError.data` usually holds the revert data.
            if (parsedError) {
                // For standard `Error(string)` reverts, `parsedError.name` is "Error" and `parsedError.args[0]` is the message.
                // For custom errors, `parsedError.name` is the custom error name, and `parsedError.args` are its arguments.
                specificReason = (parsedError.name === "Error" && parsedError.args && typeof parsedError.args[0] === 'string')
                    ? parsedError.args[0] // Standard string revert.
                    : `${parsedError.name}(${parsedError.args.join(', ')})`; // Custom error signature.
            }
        } catch (e) {
            // If parsing fails, it might not be a known custom error or the data is malformed.
            if (process.env.DEBUG) console.warn(chalk.yellow("Could not parse error data with contract ABI:"), e.message);
        }
    } else if (typeof internalError.message === 'string' && internalError.message.toLowerCase().includes('execution reverted')) {
        // If the error message itself indicates a revert but no specific reason was parsed, use the message.
        specificReason = internalError.message;
    }

    // Use the most specific reason found, or fall back to the general error message.
    let messageToParse = specificReason || error.message;
    if (typeof messageToParse !== 'string') messageToParse = ""; // Ensure it's a string for `.includes` and other string methods.

    const reasonToMatchLowerCase = messageToParse.toLowerCase();

    // Map known LibraryRegistry contract revert strings to more user-friendly messages.
    // These strings should match the `require` messages or custom error strings in the Solidity contract.
    if (reasonToMatchLowerCase.includes('libraryregistry: library does not exist')) return `Library not found in the registry. Please check the spelling or register it first using "tpkm register".`;
    if (reasonToMatchLowerCase.includes('libraryregistry: version does not exist')) return `Version not found for this library. Use 'tpkm info <libraryName> --versions' to list available versions.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: caller is not the owner')) return `Permission Denied: Your wallet is not the registered owner of this library or record.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: library name already exists')) return `Library name is already registered. Please choose a unique name.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: version already exists')) return `This version has already been published for this library. Please increment the version number.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: ipfs hash cannot be empty')) return `IPFS hash is missing or invalid. Ensure the package was correctly uploaded to IPFS before publishing.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: library is not private')) return `Operation Failed: This action is only applicable to private libraries.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: invalid user address')) return `Invalid user address provided (e.g., zero address). Please provide a valid Ethereum address.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: cannot delete library with published versions')) return `Deletion Failed: This library has published versions. You must manage (e.g., deprecate) versions before deleting the library record.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: user not authorized')) return `Access Denied: The specified user is not authorized for this private library.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: user already authorized')) return `User is already authorized for this private library. No action needed.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: cannot authorize owner')) return `Cannot explicitly authorize the library owner. Owners inherently have access.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: cannot revoke owner')) return `Cannot revoke access for the library owner. Owners always retain access.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: private libraries cannot require a license')) return `Operation Failed: Private libraries use direct authorization ("tpkm authorize"), not purchasable licenses.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: license not required')) return `License not required for this library. Purchase or access management is not applicable or handled differently.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: license already owned')) return `License already owned by this address for this library.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: insufficient ether sent')) return `Insufficient Ether sent for the license fee. Please check the required fee and try again.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: failed to send ether to library owner')) return `Payment transfer to the library owner failed. This might be a temporary network issue or an issue with the owner's receiving address.`;
    if (reasonToMatchLowerCase.includes('libraryregistry: failed to refund overpayment to buyer')) return `Failed to refund overpayment to the buyer. The primary transaction may have succeeded, but refund failed.`;


    // Map specific IPFS client error codes or messages if needed.
    if (error.code === 'ERR_BAD_REQUEST' && reasonToMatchLowerCase.includes('dag node not found')) {
        return `IPFS content not found (DAG node not found). The CID may be invalid, or the content may not be available on the IPFS network.`;
    }

    // If it's a client-side thrown error (from our pre-checks), its message is likely already user-friendly.
    // Check if it's a simple error object without special Ethers.js properties like `code`, `reason`, `data`.
    const isSimpleError = !error.code && !error.reason && !error.data && !error.revert && error.message;
    if (isSimpleError) {
        // If it's one of our custom `CLIENT_VALIDATION:` prefixed errors, strip the prefix for cleaner display.
        if (error.message.startsWith('CLIENT_VALIDATION: ')) {
            return error.message.substring('CLIENT_VALIDATION: '.length).trim();
        }
        return error.message.trim(); // Return the message directly.
    }

    // Final fallback: try to return the most specific part parsed, or the original error message, or the default unknown error.
    let finalMessage = specificReason || error.message || defaultUnknownError;
    if (typeof finalMessage !== 'string') finalMessage = String(finalMessage); // Ensure it's a string.

    // Clean up common prefixes from Ethers.js or provider messages for brevity.
    if (finalMessage.startsWith('execution reverted: ')) finalMessage = finalMessage.substring('execution reverted: '.length);
    if (finalMessage.startsWith('Error: ')) finalMessage = finalMessage.substring('Error: '.length);
    if (finalMessage.startsWith('RPC Error: ')) finalMessage = finalMessage.substring('RPC Error: '.length);
    // Provider errors often have structure like "message: '...', code: ..., data: '...'".
    // We prioritize `reason` or parsed data, but `message` itself might be the best if those aren't available.

    return finalMessage.trim();
}


// =============================================================================
// --- CLI Command Definitions ---
// =============================================================================

program
    .name('tpkm')
    .description('Taco Package Manager CLI - A decentralized package manager using IPFS and Ethereum.')
    .version('0.1.1'); // Update this version as the TPKM tool evolves.

// --- Config Subcommands (tpkm config ...) ---
// Manages network configuration profiles stored in ~/.tacopkm/networks.json.
// These profiles define connection details (RPC URL, Contract Address) for different Ethereum networks.
const configCommand = program.command('config')
    .description('Manage TPKM network configurations (RPC URL, Contract Address).');

/**
 * Command: tpkm config add <name>
 * Adds or updates a named network profile. A profile consists of an RPC URL and a LibraryRegistry contract address.
 * Users can be prompted for these details if not provided as options.
 */
configCommand
    .command('add <name>')
    .description('Add or update a network configuration profile.')
    .option('-r, --rpc <url>', 'RPC URL for the Ethereum network (e.g., http://localhost:8545, https://sepolia.infura.io/v3/YOUR_KEY)')
    .option('-c, --contract <address>', 'Deployed LibraryRegistry smart contract address on this network (e.g., 0x123...)')
    .option('-s, --set-active', 'Set this network profile as the active one immediately after adding/updating.')
    .action(async (name, options) => {
        let { rpc: rpcUrlOption, contract: contractAddressOption, setActive } = options;

        // Interactively prompt for missing required options if they weren't provided via flags.
        const questions = [];
        if (!rpcUrlOption) {
            questions.push({
                type: 'input',
                name: 'rpcUrl',
                message: `Enter RPC URL for network profile "${name}":`,
                validate: input => (!!input && (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('ws://') || input.startsWith('wss://'))) || "RPC URL cannot be empty and should start with http(s):// or ws(s)://."
            });
        }
        if (!contractAddressOption) {
            questions.push({
                type: 'input',
                name: 'contractAddress',
                message: `Enter LibraryRegistry Contract Address for network profile "${name}":`,
                validate: input => ethers.isAddress(input) || "Please enter a valid Ethereum address (e.g., 0x...).",
                filter: input => ethers.getAddress(input) // Convert to checksum address automatically
            });
        }

        let answers = {};
        if (questions.length > 0) {
            answers = await inquirer.prompt(questions);
        }

        const rpcUrl = rpcUrlOption || answers.rpcUrl;
        const contractAddress = ethers.getAddress(contractAddressOption || answers.contractAddress); // Ensure checksum

        // Final validation after potentially getting input from prompts.
        // This should ideally be caught by prompt validation, but serves as a double-check.
        if (!rpcUrl || !ethers.isAddress(contractAddress)) {
            console.error(chalk.red('Invalid RPC URL or Contract Address provided. Aborting profile creation.'));
            return;
        }

        const config = loadNetworkConfig(); // Load existing configuration.
        // Add or update the specified network profile.
        config.networks[name] = { rpcUrl: rpcUrl, contractAddress: contractAddress };
        console.log(chalk.blue(`Network profile "${name}" added/updated.`));

        // Set this profile as active if the --set-active flag was used, or if it's the first network being added.
        if (setActive || !config.activeNetwork || Object.keys(config.networks).length === 1) {
            config.activeNetwork = name;
            console.log(chalk.blue(`Network profile "${name}" set as the active configuration.`));
        }

        saveNetworkConfig(config); // Persist changes to the networks.json file.
        console.log(chalk.green(`Network configuration saved successfully to ${networkConfigPath}.`));
        console.log(chalk.gray(`  Profile Name:     ${name}`));
        console.log(chalk.gray(`  RPC URL:          ${rpcUrl}`));
        console.log(chalk.gray(`  Contract Address: ${contractAddress}`));
    });

/**
 * Command: tpkm config set-active <name>
 * Sets a previously added network profile as the active one for subsequent TPKM commands.
 * The active profile determines which Ethereum network and contract TPKM interacts with.
 */
configCommand
    .command('set-active <name>')
    .description('Set the active network configuration profile to use for TPKM commands.')
    .action((name) => {
        const config = loadNetworkConfig();
        if (!config.networks[name]) {
            console.error(chalk.red(`Error: Network profile "${name}" not found.`));
            console.log(chalk.yellow(`Use "tpkm config add ${name} --rpc <URL> --contract <ADDRESS>" to add it first, or "tpkm config list" to see available profiles.`));
            return;
        }
        config.activeNetwork = name;
        saveNetworkConfig(config);
        console.log(chalk.green(`Network profile "${name}" is now set as active.`));
    });

/**
 * Command: tpkm config list (alias: ls)
 * Lists all saved network profiles and indicates which one is currently active.
 * Output is formatted for better readability in the terminal.
 */
configCommand
    .command('list')
    .alias('ls')
    .description('List all saved network configuration profiles.')
    .action(() => {
        const config = loadNetworkConfig();
        console.log(chalk.cyan.bold('--- Saved Network Configurations ---'));

        if (Object.keys(config.networks).length === 0) {
            console.log(chalk.gray('No network configurations saved yet.'));
            console.log(chalk.yellow(`Use "tpkm config add <name> --rpc <URL> --contract <ADDRESS>" to add one.`));
            return;
        }

        Object.entries(config.networks).forEach(([name, details]) => {
            const isActive = name === config.activeNetwork;
            console.log(chalk.whiteBright(`\nProfile: ${name}${isActive ? chalk.green.bold(' (Active)') : ''}`));
            console.log(chalk.gray(`  RPC URL:          ${details.rpcUrl}`));
            console.log(chalk.gray(`  Contract Address: ${details.contractAddress}`));
        });
        console.log(''); // Add a blank line after the list for better spacing.

        if (config.activeNetwork) {
            console.log(chalk.blue(`Current active network profile: "${config.activeNetwork}"`));
        } else if (Object.keys(config.networks).length > 0) {
            console.warn(chalk.yellow('\nWarning: No active network profile is set.'));
            console.warn(chalk.yellow('TPKM commands requiring network interaction might fail or prompt for configuration.'));
            console.warn(chalk.yellow('Use "tpkm config set-active <profile_name>" to choose a profile.'));
        }
         // If .env provides RPC_URL and CONTRACT_ADDRESS, ensureNetworkClientsInitialized will use them if no active profile is set.
         // This message primarily guides users to utilize the profile system.
        if (!config.activeNetwork && (process.env.RPC_URL && process.env.CONTRACT_ADDRESS)) {
            console.info(chalk.blue('\nNote: RPC_URL and CONTRACT_ADDRESS are set in your .env file. These will be used as a fallback if no active network is set.'));
        }
    });

/**
 * Command: tpkm config show [name]
 * Displays the details (RPC URL, Contract Address) of a specific network profile.
 * If no name is provided, it shows the details of the currently active profile.
 */
configCommand
    .command('show [name]')
    .description('Show details of a specific network configuration profile (or the active one if name is omitted).')
    .action((name) => {
        const config = loadNetworkConfig();
        const networkToShow = name || config.activeNetwork; // Use provided name or fallback to the active profile.

        if (!networkToShow) {
            console.error(chalk.red('Error: No network profile name specified and no active network profile set.'));
            console.log(chalk.yellow('Use "tpkm config show <profile_name>" or set an active profile with "tpkm config set-active <profile_name>".'));
            return;
        }

        const details = config.networks[networkToShow];
        if (!details) {
            console.error(chalk.red(`Error: Network profile "${networkToShow}" not found.`));
            console.log(chalk.yellow('Use "tpkm config list" to see available profiles.'));
            return;
        }

        const isActive = networkToShow === config.activeNetwork;
        console.log(chalk.cyan.bold(`--- Configuration for "${networkToShow}" ${isActive ? chalk.green.bold('(Active)') : ''} ---`));
        console.log(chalk.whiteBright(`  RPC URL:          `) + details.rpcUrl);
        console.log(chalk.whiteBright(`  Contract Address: `) + details.contractAddress);
    });

/**
 * Command: tpkm config remove <name> (alias: rm)
 * Removes a saved network profile from the TPKM configuration file.
 * Prompts for confirmation before deleting.
 */
configCommand
    .command('remove <name>')
    .alias('rm')
    .description('Remove a saved network configuration profile.')
    .action(async (name) => {
        const config = loadNetworkConfig();
        if (!config.networks[name]) {
            console.error(chalk.red(`Error: Network profile "${name}" not found. Cannot remove.`));
            return;
        }

        // Ask for confirmation before deleting, as this is a destructive action.
        const { confirmRemove } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmRemove',
            message: `Are you sure you want to remove the network configuration profile "${name}"?`,
            default: false // Default to No for safety.
        }]);

        if (confirmRemove) {
            delete config.networks[name]; // Remove the profile entry from the networks object.
            let activeCleared = false;
            // If the removed network was the active one, clear the activeNetwork setting.
            if (config.activeNetwork === name) {
                config.activeNetwork = null; // Set to null, indicating no active profile.
                activeCleared = true;
            }
            saveNetworkConfig(config); // Save the updated configuration.
            console.log(chalk.green(`Network profile "${name}" removed successfully.`));
            if (activeCleared) {
                console.warn(chalk.yellow(`The active network profile was removed. Please set a new active network using "tpkm config set-active <profile_name>".`));
            }
        } else {
            console.log(chalk.blue('Removal cancelled.'));
        }
    });


// --- Wallet Management Commands (tpkm wallet ...) ---
// Manages the local encrypted Ethereum wallet stored at ~/.tacopkm/keystore.json.
// This wallet is used for signing transactions required by TPKM operations like registering or publishing.
const walletCommand = program.command('wallet')
    .description('Manage local encrypted Ethereum wallet for TPKM operations.');

/**
 * Command: tpkm wallet create
 * Generates a new random Ethereum wallet and saves it as an encrypted keystore file (JSON V3 format).
 * Prompts for a password to encrypt the wallet. Warns user about password and keystore backup.
 */
walletCommand
    .command('create')
    .description('Create a new Ethereum wallet and save it as an encrypted keystore file (~/.tacopkm/keystore.json).')
    .option('-p, --password <password>', 'Password to encrypt the new wallet (optional; will prompt if not provided).')
    .action(async (options) => {
        let password = options.password;

        // Prompt for password if not provided via CLI option. Require password confirmation.
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
        // This check should be caught by prompt validation if password was prompted,
        // but it's a good safeguard if the -p option somehow results in an empty string.
        if (!password) {
            console.error(chalk.red('Password cannot be empty. Wallet creation aborted.'));
            return;
        }

        // Check if a keystore file already exists and ask for overwrite confirmation.
        if (fs.existsSync(keystorePath)) {
            const { overwrite } = await inquirer.prompt([{
                type: 'confirm',
                name: 'overwrite',
                message: chalk.yellow(`Wallet keystore already exists at ${keystorePath}. Overwrite? (THIS IS IRREVERSIBLE and will delete the existing key)`),
                default: false // Default to No for safety.
            }]);
            if (!overwrite) {
                console.log(chalk.blue('Wallet creation cancelled. Existing keystore preserved.'));
                return;
            }
            console.log(chalk.yellow('Overwriting existing keystore...'));
        }

        try {
            fs.ensureDirSync(keystoreDir); // Ensure the ~/.tacopkm directory exists.
            const newWalletInstance = ethers.Wallet.createRandom(); // Generate a new random Ethereum wallet.

            const encryptSpinner = ora({ text: 'Encrypting new wallet...', color: 'yellow' }).start();
            // Encrypt the wallet's private key using the provided password into JSON keystore format (Ethers.js default is V3).
            const keystoreJson = await newWalletInstance.encrypt(password);
            fs.writeFileSync(keystorePath, keystoreJson, 'utf8'); // Save the encrypted JSON to the keystore file.
            encryptSpinner.succeed(chalk.green(`New wallet created and saved to: ${keystorePath}`));

            console.log(chalk.blue(`New Wallet Address: ${newWalletInstance.address}`));
            console.log(chalk.magenta.bold('\n--- IMPORTANT ---'));
            console.log(chalk.magenta('1. Store your password securely. There is NO way to recover the wallet or funds without it.'));
            console.log(chalk.magenta(`2. Consider backing up the keystore file (${keystorePath}) itself to a secure, offline location.`));
            console.log(chalk.magenta('-----------------\n'));

        } catch (error) {
            console.error(chalk.red('Error creating wallet:'), error.message);
        }
    });

/**
 * Command: tpkm wallet import <privateKey>
 * Imports an existing wallet using its private key and saves it as an encrypted keystore file.
 * Prompts for a password to encrypt the imported wallet.
 */
walletCommand
    .command('import <privateKey>')
    .description('Import an existing wallet from a private key and save it as an encrypted keystore file (~/.tacopkm/keystore.json).')
    .option('-p, --password <password>', 'Password to encrypt the imported wallet (optional; will prompt if not provided).')
    .action(async (privateKey, options) => {
        let password = options.password;

        // Basic validation of private key format (should be a 64-character hex string, optionally prefixed with "0x").
        if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
            console.error(chalk.red('Invalid private key format. It should be a 64-character hexadecimal string, optionally prefixed with "0x".'));
            return;
        }
        // Ensure '0x' prefix for the ethers.js Wallet constructor, as it expects it.
        if (!privateKey.startsWith('0x')) {
            privateKey = '0x' + privateKey;
        }

        // Prompt for encryption password if not provided via CLI option.
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
        if (!password) { // Safeguard.
            console.error(chalk.red('Password cannot be empty. Wallet import aborted.'));
            return;
        }

        // Check if keystore already exists and ask for overwrite confirmation.
        if (fs.existsSync(keystorePath)) {
            const { overwrite } = await inquirer.prompt([{
                type: 'confirm',
                name: 'overwrite',
                message: chalk.yellow(`Wallet keystore already exists at ${keystorePath}. Overwrite with imported key? (THIS IS IRREVERSIBLE and will delete the existing key)`),
                default: false
            }]);
            if (!overwrite) {
                console.log(chalk.blue('Wallet import cancelled. Existing keystore preserved.'));
                return;
            }
            console.log(chalk.yellow('Overwriting existing keystore...'));
        }

        try {
            // Create a wallet instance from the private key. This also validates the key's correctness.
            const importedWallet = new ethers.Wallet(privateKey);

            fs.ensureDirSync(keystoreDir); // Ensure the ~/.tacopkm directory exists.
            const encryptSpinner = ora({ text: 'Encrypting imported wallet...', color: 'yellow' }).start();
            const keystoreJson = await importedWallet.encrypt(password); // Encrypt the imported private key.
            fs.writeFileSync(keystorePath, keystoreJson, 'utf8'); // Save the encrypted JSON, potentially overwriting.
            encryptSpinner.succeed(chalk.green(`Wallet imported successfully and saved to: ${keystorePath}`));

            console.log(chalk.blue(`Imported Wallet Address: ${importedWallet.address}`));
            console.log(chalk.magenta.bold('\n--- IMPORTANT ---'));
            console.log(chalk.magenta('1. Store your password securely. You will need it to use this wallet with TPKM.'));
            console.log(chalk.magenta(`2. Consider backing up the new keystore file (${keystorePath}) to a secure, offline location.`));
            console.log(chalk.magenta('3. Ensure the original private key is stored safely or securely deleted if no longer needed elsewhere.'));
            console.log(chalk.magenta('-----------------\n'));

        } catch (error) {
            // Catch errors from ethers.Wallet constructor (e.g., invalid private key length/format) or encryption process.
            console.error(chalk.red('Error importing wallet:'), error.message);
        }
    });

/**
 * Command: tpkm wallet address
 * Displays the public Ethereum address of the wallet stored in the local keystore file.
 * This requires decrypting the keystore, so it will prompt for the password.
 */
walletCommand
    .command('address')
    .description('Display the public address of the wallet stored in the local keystore (requires password).')
    .action(async () => {
        // `loadWalletAndConnect` handles finding the keystore, prompting for password,
        // decrypting, and providing the wallet object which contains the address.
        // It also initializes network clients, which aren't strictly needed here but ensures consistency.
        // An alternative, `getPublicAddressFromKeystore`, could be used if password entry is to be avoided
        // for just viewing the address (if the keystore format stores it unencrypted, which V3 JSON does).
        // However, using loadWalletAndConnect ensures the wallet is valid and decryptable.
        try {
            // We only need the wallet object here to display its address. The contract instance is not used.
            // `loadWalletAndConnect` will prompt for password implicitly.
            const { wallet } = await loadWalletAndConnect(); // Default is promptForPassword=true
            if (wallet && wallet.address) {
                console.log(chalk.blue.bold(`Current TPKM wallet address: ${wallet.address}`));
            }
            // If `loadWalletAndConnect` fails (e.g., no keystore, wrong password), it prints errors and exits the process,
            // so we typically won't reach here on failure unless an unexpected error occurs.
        } catch (error) {
            // This catch block is a fallback, as loadWalletAndConnect usually handles its own errors and exits.
            console.error(chalk.red('Could not display wallet address:'), error.message);
        }
    });

/**
 * Command: tpkm wallet balance
 * Displays the ETH balance of the currently configured wallet on the active network.
 */
walletCommand
    .command('balance')
    .description('Display the ETH balance of the currently configured wallet on the active network.')
    .action(async () => {
        // Spinner for user feedback during async operations.
        const balanceSpinner = ora({ text: 'Fetching wallet balance...', color: 'yellow' }).start();

        try {
            // 1. Get the public address from the keystore (does not require password).
            const publicAddress = await getPublicAddressFromKeystore();
            if (!publicAddress) {
                // getPublicAddressFromKeystore already prints detailed error messages.
                balanceSpinner.fail('Could not retrieve wallet address from keystore.');
                return;
            }

            // 2. Ensure network clients (provider) are initialized.
            // This also sets currentActiveNetworkName and currentActiveRpcUrl.
            await ensureNetworkClientsInitialized();
            balanceSpinner.text = `Fetching balance for address ${publicAddress.substring(0,10)}... on network "${currentActiveNetworkName}"...`;
            if (!provider) { // Should be caught by ensureNetworkClientsInitialized, but as a safeguard.
                balanceSpinner.fail('Network provider not initialized.');
                throw new Error('Network provider could not be initialized.');
            }

            // 3. Get the balance from the blockchain using the provider.
            const balanceWei = await provider.getBalance(publicAddress);
            balanceSpinner.succeed(chalk.green('Balance fetched successfully!'));

            // 4. Format and display the balance.
            const balanceEth = ethers.formatEther(balanceWei); // Convert Wei to ETH string.
            const networkNameToDisplay = currentActiveNetworkName !== 'unknown' ? currentActiveNetworkName : 'the configured network';

            console.log(chalk.blue.bold(`\nWallet Address: ${publicAddress}`));
            console.log(chalk.whiteBright(`Network:        ${networkNameToDisplay}`));
            console.log(chalk.whiteBright(`Balance:        ${balanceEth} ETH`));
            console.log(chalk.gray  (`                (${balanceWei.toString()} Wei)`));

        } catch (error) {
            if (balanceSpinner.isSpinning) {
                balanceSpinner.fail(chalk.red('Failed to fetch balance.'));
            }
            // Use getRevertReason for potentially network/contract related errors,
            // or just error.message for other issues.
            console.error(chalk.red('Error fetching balance:'), getRevertReason(error) || error.message);
            if (process.env.DEBUG) {
                console.error(error.stack);
            }
        }
    });


// --- Library Management Commands (tpkm register, publish, install, etc.) ---

/**
 * Command: tpkm register <name>
 * Registers a new library name on the LibraryRegistry smart contract.
 * The caller's wallet address (from the local keystore) becomes the owner of this library record.
 * Allows specifying description, tags, language, and privacy status.
 */
program
    .command('register <name>')
    .description('Register a new library name on the TPKM smart contract registry.')
    .option('-d, --description <text>', 'A brief description of the library (e.g., "A utility for array manipulation").', '')
    .option('-t, --tags <tags>', 'Comma-separated tags for discoverability (e.g., "math,utils,array").', '')
    .option('-l, --language <language>', 'Primary programming language of the library (e.g., "javascript", "python", "solidity").', '')
    .option('--private', 'Register the library as private (owner controls access via authorize/revoke). Default is public.', false)
    .action(async (name, options) => {
        // Basic name validation (similar to npm package name rules, but adjust as per TPKM's specific requirements).
        // Allows lowercase letters, numbers, hyphens, underscores, dots. Cannot start/end with separators. Max length 214.
        if (!/^[a-z0-9]+(?:[-_.]?[a-z0-9]+)*$/.test(name) || name.length > 214) {
            console.error(chalk.red(`Invalid library name: "${name}".`));
            console.error(chalk.red('Use lowercase letters, numbers, and optionally hyphens (-), underscores (_), or dots (.).'));
            console.error(chalk.red('It must not start or end with these separators, and should be less than 215 characters.'));
            return;
        }

        await ensureNetworkClientsInitialized(); // Connect to network, IPFS (though IPFS not strictly needed for register).
        // Load wallet/signer and get a writable contract instance. This will prompt for password.
        const { contract: writableContractInstance, wallet: currentSigner } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSigner) return; // Exit if wallet loading failed.

        console.log(chalk.yellow(`Attempting to register library "${name}" on network "${currentActiveNetworkName}"...`));
        console.log(chalk.gray(`  Owner will be:      ${currentSigner.address}`));
        console.log(chalk.gray(`  Set as Private:     ${options.private ? 'Yes' : 'No'}`));
        if (options.description) console.log(chalk.gray(`  Description:        ${options.description}`));
        if (options.language) console.log(chalk.gray(`  Language:           ${options.language}`));
        const tagsArray = options.tags ? options.tags.split(',').map(tag => tag.trim()).filter(tag => tag) : [];
        if (tagsArray.length > 0) console.log(chalk.gray(`  Tags:               ${tagsArray.join(', ')}`));


        // --- Pre-check: Verify if the library name is already taken on-chain ---
        const checkSpinner = ora({ text: `Checking availability of name "${name}" on the registry...`, color: 'gray' }).start();
        try {
            // Attempt to get library info. If it succeeds without error, the library name already exists.
            await contractReadOnly.getLibraryInfo(name);
            // If the above line does not throw, it means the library exists.
            checkSpinner.fail(chalk.red(`Registration failed: Library name "${name}" is already registered.`));
            console.log(chalk.yellow('Please choose a different, unique name for your library.'));
            return;
        } catch (checkError) {
            const reason = getRevertReason(checkError);
            // We expect a "Library not found" type of error if the name is available.
            if (reason.toLowerCase().includes('library not found')) {
                checkSpinner.succeed(chalk.gray(`Library name "${name}" appears to be available.`));
            } else {
                // A different error occurred during the pre-check (e.g., network issue).
                checkSpinner.fail(chalk.red('Error during pre-check for library name availability:'));
                console.error(chalk.red(`  ${reason}`));
                return;
            }
        }
        // --- End Pre-check ---

        // Proceed with the registration transaction.
        const registerSpinner = ora({ text: `Sending registration transaction for "${name}"...`, color: 'yellow' }).start();
        try {
            // Call the smart contract's `registerLibrary` function with the provided details.
            const tx = await writableContractInstance.registerLibrary(
                name,
                options.description,
                tagsArray,
                options.private, // Pass the boolean privacy flag.
                options.language
            );
            registerSpinner.text = `Waiting for transaction confirmation (Tx Hash: ${tx.hash.substring(0,10)}...). This may take a moment...`;
            await tx.wait(1); // Wait for 1 block confirmation.
            registerSpinner.succeed(chalk.green.bold(`Library "${name}" registered successfully!`));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));

        } catch (error) {
            registerSpinner.fail(chalk.red('Error registering library:'));
            console.error(chalk.red(`  ${getRevertReason(error)}`)); // Use helper to parse revert reasons.
            if (process.env.DEBUG) console.error(error); // Log full error object in debug mode.
        }
    });

/**
 * Command: tpkm info <libraryIdentifier>
 * Fetches and displays information about a registered library or a specific version of it.
 * The identifier can be "libraryName" (for general info and latest/all versions)
 * or "libraryName@version" (for details of a specific version).
 */
program
    .command('info <libraryIdentifier>')
    .description('Get information about a library or a specific version (e.g., "my-lib" or "my-lib@1.0.0").')
    .option('--versions', 'List all published versions for the library, sorted newest first.') // Flag to explicitly list versions.
    .action(async (libraryIdentifier, options) => {
        await ensureNetworkClientsInitialized(); // Need read-only contract access.

        let libraryName = libraryIdentifier;
        let versionString = null; // Will hold the version if specified in the identifier.
        const querySpecificVersion = libraryIdentifier.includes('@');
        const listAllVersionsFlag = options.versions; // Check if --versions flag was used.

        // Parse the libraryIdentifier if a version is included (e.g., "my-lib@1.0.0").
        if (querySpecificVersion) {
            const parts = libraryIdentifier.split('@');
            if (parts.length !== 2 || !parts[0] || !parts[1]) { // Basic format check.
                console.error(chalk.red('Invalid library identifier format. Use "libraryName" or "libraryName@versionString".'));
                return;
            }
            libraryName = parts[0];
            versionString = parts[1];
            // Validate that the version part looks like a semantic version.
            if (!semver.valid(versionString)) {
                console.error(chalk.red(`Invalid version format: "${versionString}". Please use semantic versioning (e.g., 1.0.0, 1.2.3-alpha.1).`));
                return;
            }
        }

        const infoSpinner = ora({ text: `Fetching information for "${libraryIdentifier}"...`, color: 'yellow' }).start();
        try {
            infoSpinner.text = `Fetching general library info for "${libraryName}"...`;
            // Retrieve general library information from the smart contract.
            // Expected return: [owner, description, tags, isPrivate, language, licenseFee, licenseRequired]
            const libInfoData = await contractReadOnly.getLibraryInfo(libraryName);
            infoSpinner.succeed(chalk.green(`Fetched general info for "${libraryName}".`));

            const [owner, description, tags, isPrivate, language, licenseFee, licenseRequired] = libInfoData;

            // Display basic library information in a stacked format for readability.
            console.log(chalk.cyan.bold(`\n--- Library Information: ${chalk.whiteBright(libraryName)} ---`));
            console.log(`  ${chalk.whiteBright('Owner')}:              ${owner}`);
            console.log(`  ${chalk.whiteBright('Description')}:        ${description || chalk.gray('(Not set)')}`);
            console.log(`  ${chalk.whiteBright('Language')}:           ${language || chalk.gray('(Not set)')}`);
            console.log(`  ${chalk.whiteBright('Tags')}:               ${tags.length > 0 ? tags.join(', ') : chalk.gray('(None)')}`);
            console.log(`  ${chalk.whiteBright('Visibility')}:         ${isPrivate ? chalk.yellow('Private') : chalk.green('Public')}`);

            // Display license-related information.
            if (licenseRequired || licenseFee > 0) { // If license is explicitly required or a fee is set
                console.log(`  ${chalk.whiteBright('License Required')}:   ${licenseRequired ? chalk.yellow('Yes') : chalk.gray('No (but fee set)')}`);
                console.log(`  ${chalk.whiteBright('License Fee')}:        ${ethers.formatUnits(licenseFee, 'ether')} ETH (${licenseFee.toString()} Wei)`);
            } else if (!isPrivate) { // Public and no license requirement/fee
                console.log(`  ${chalk.whiteBright('License Status')}:     ${chalk.green('Open Access (Public, No License Fee/Requirement)')}`);
            } else { // Private (access is via direct authorization, not purchasable license)
                console.log(`  ${chalk.whiteBright('Access Control')}:   ${chalk.yellow('Private (Access via direct owner authorization)')}`);
            }

            // Check and display user's current access/license status for this library.
            const currentUserAddress = await getPublicAddressFromKeystore(); // Get address from local keystore.
            let currentUserHasAccess = false; // Assume no access initially for version details
            if (currentUserAddress) {
                const licenseCheckSpinner = ora({ text: `Checking your license/access status for "${libraryName}"...`, color: 'gray' }).start();
                try {
                    const userHasLicense = await contractReadOnly.hasUserLicense(libraryName, currentUserAddress);
                    currentUserHasAccess = await contractReadOnly.hasAccess(libraryName, currentUserAddress); // Broader access check

                    if (userHasLicense) {
                        licenseCheckSpinner.succeed(chalk.green(`You (${currentUserAddress.substring(0,10)}...) OWN a license for this library.`));
                    } else if (currentUserHasAccess) {
                        if (owner.toLowerCase() === currentUserAddress.toLowerCase()) {
                            licenseCheckSpinner.info(chalk.blue(`You are the OWNER of this library (full access).`));
                        } else if (isPrivate) {
                            licenseCheckSpinner.info(chalk.blue(`You (${currentUserAddress.substring(0,10)}...) have DIRECT AUTHORIZED access to this private library.`));
                        } else { // Public and free, or some other access mechanism grants access.
                            licenseCheckSpinner.info(chalk.blue(`You (${currentUserAddress.substring(0,10)}...) have general access (e.g., public library).`));
                        }
                    } else if (isPrivate || licenseRequired) { // Needs permission/license but user doesn't have it.
                        licenseCheckSpinner.warn(chalk.yellow(`You (${currentUserAddress.substring(0,10)}...) DO NOT currently have the required access/license for this library.`));
                        if (licenseRequired && !isPrivate) console.log(chalk.yellow(`  -> A license purchase is required for public library "${libraryName}". Use "tpkm purchase-license ${libraryName}".`));
                        else if (isPrivate) console.log(chalk.yellow(`  -> Access to private library "${libraryName}" requires direct authorization from the owner.`));
                    } else {
                        licenseCheckSpinner.stop(); // No specific message needed if public, no license required, and no explicit ownership/auth.
                    }
                } catch (licenseCheckError) {
                    licenseCheckSpinner.fail(chalk.red('Could not determine your license/access status for this library.'));
                }
            } else {
                console.log(chalk.gray("No local wallet configured. Displaying publicly available information. Access to private/licensed content details may be restricted."));
                // For non-wallet users, assume they only have access if the lib is public & not license-required
                currentUserHasAccess = !isPrivate && !licenseRequired;
            }
            console.log(''); // Add a blank line for spacing.

            // If --versions flag is used, or if only the library name was given (implying a general query), list its versions.
            if (listAllVersionsFlag || (!querySpecificVersion && !versionString)) {
                const versionSpinner = ora({ text: `Fetching published versions for ${libraryName}...`, color: 'gray' }).start();
                try {
                    const versions = await contractReadOnly.getVersionNumbers(libraryName);
                    if (versions && versions.length > 0) {
                        // Sort versions semantically in descending order (newest first).
                        const sortedVersions = [...versions].sort(semver.rcompare);
                        versionSpinner.succeed(chalk.green(`Found ${versions.length} published version(s).`));

                        console.log(chalk.cyan.bold(`\n--- Published Versions (${versions.length}) ---`));
                        const versionsTable = new Table({
                            head: [chalk.cyan('Version')],
                            colWidths: [30], // Width for version strings.
                            style: { head: ['cyan'], border: ['grey'] }
                        });
                        sortedVersions.forEach(v => versionsTable.push([v]));
                        console.log(versionsTable.toString());
                    } else {
                        versionSpinner.info(chalk.gray('No versions have been published yet for this library.'));
                    }
                } catch (versionError) {
                    versionSpinner.fail(chalk.red('Error fetching version list:'));
                    console.error(chalk.red(`  ${getRevertReason(versionError)}`));
                }
                 console.log(''); // Spacing after versions list
            }

            // If a specific version was requested (e.g., "my-lib@1.0.0"), display its details.
            if (querySpecificVersion && versionString) {
                if (currentUserHasAccess) {
                    const versionDetailSpinner = ora({ text: `Fetching details for ${libraryName}@${versionString}...`, color: 'gray' }).start();
                    try {
                        // Expected return: [ipfsHash, publisher, timestamp, isDeprecated, dependenciesArray]
                        const versionData = await contractReadOnly.getVersionInfo(libraryName, versionString);
                        versionDetailSpinner.succeed(chalk.green(`Fetched details for ${libraryName}@${versionString}.`));

                        const [ipfsHash, publisher, timestamp, deprecated, dependencies] = versionData;
                        // Convert BigInt timestamp from contract (seconds since Unix epoch) to a JavaScript Date object.
                        const publishDate = new Date(Number(timestamp) * 1000);

                        console.log(chalk.cyan.bold(`\n--- Version Details: ${chalk.whiteBright(libraryName)}@${chalk.whiteBright(versionString)} ---`));
                        // Using a simple stacked list for version details as well.
                        console.log(`  ${chalk.whiteBright('IPFS Hash (CID)')}:  ${ipfsHash}`);
                        console.log(`  ${chalk.whiteBright('Publisher')}:        ${publisher}`);
                        console.log(`  ${chalk.whiteBright('Published Date')}:   ${publishDate.toLocaleString()} (Timestamp: ${timestamp.toString()}s)`);
                        console.log(`  ${chalk.whiteBright('Deprecated')}:        ${deprecated ? chalk.red.bold('Yes') : 'No'}`);

                        // Display Dependencies for this specific version, if any.
                        console.log(chalk.whiteBright(`\n  Dependencies for this version:`));
                        if (dependencies && dependencies.length > 0) {
                            const depsTable = new Table({
                                head: [chalk.cyan('Dependency Name'), chalk.cyan('Version Constraint')],
                                colWidths: [35, 25], // Adjusted widths.
                                style: { head: ['cyan'], border: ['grey'] }
                            });
                            dependencies.forEach(dep => depsTable.push([dep.name, dep.constraint]));
                            console.log(depsTable.toString());
                        } else {
                            console.log(chalk.gray('    (This version has no listed dependencies)'));
                        }
                    } catch (versionError) {
                        versionDetailSpinner.fail(chalk.red(`Error fetching details for version ${versionString}:`));
                        // This error most likely means "Version does not exist".
                        console.error(chalk.red(`  ${getRevertReason(versionError)}`));
                    }
                } else {
                    // User does not have access, do not show IPFS hash or full version details.
                    infoSpinner.stop(); // Stop the main spinner if it was still going.
                    console.log(chalk.cyan.bold(`\n--- Version Details: ${chalk.whiteBright(libraryName)}@${chalk.whiteBright(versionString)} ---`));
                    console.log(chalk.yellow(`  Access required to view full details (including IPFS Hash) for this version.`));
                    if (isPrivate) {
                        console.log(chalk.yellow(`  This is a private library. Request authorization from the owner.`));
                    } else if (licenseRequired) {
                        console.log(chalk.yellow(`  This library version requires a license. Use "tpkm purchase-license ${libraryName}" to acquire one.`));
                    }
                }
            }
            console.log(''); // Add a final blank line for overall spacing.

        } catch (error) {
            // Handle errors from the initial getLibraryInfo call (e.g., library not found).
            infoSpinner.fail(chalk.red('Error fetching library information:'));
            console.error(chalk.red(`  ${getRevertReason(error)}`)); // Likely "Library does not exist".
            if (process.env.DEBUG) console.error(error.stack); // Full stack trace in debug mode.
        }
    });

/**
 * Command: tpkm publish <directory>
 * Packages the library code from the specified directory, uploads the resulting archive to IPFS,
 * and then calls the smart contract to publish a new version record. This record associates
 * the library name, version string, and the IPFS hash (CID) of the package.
 * Requires ownership of the library record in the smart contract.
 * Reads metadata (name, version, dependencies) from a `lib.config.json` file in the directory.
 */
program
    .command('publish <directory>')
    .description('Package, upload to IPFS, and publish a new version of a library from a specified directory.')
    .option('-v, --version <version>', 'Version string (e.g., "1.0.0"). Overrides the version specified in lib.config.json.')
    .action(async (directory, options) => {
        await ensureNetworkClientsInitialized(); // Ensure IPFS and Ethereum RPC clients are ready.
        // Publishing requires signing a transaction, so load the wallet. This will prompt for password.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return; // Exit if wallet loading failed.

        const dirPath = path.resolve(directory); // Get absolute path to the target directory.
        const configPath = path.join(dirPath, 'lib.config.json'); // Path to the library's configuration file.
        // Use OS temporary directory for the intermediate archive file to avoid cluttering the project.
        const tempArchiveName = `tpkm-publish-temp-${currentSignerWallet.address.slice(2,10)}-${Date.now()}.tar.gz`; // More unique temp name
        const tempArchivePath = path.join(os.tmpdir(), tempArchiveName);

        console.log(chalk.yellow(`Attempting to publish library from directory: ${dirPath}`));
        let libraryName = '';
        let versionString = '';
        let ipfsHash = ''; // Will store the IPFS CID after successful upload.
        let dependenciesToPass = []; // Array of { name: string, constraint: string } for the smart contract.

        try {
            // --- 1. Validate directory and existence of configuration file ---
            if (!fs.existsSync(dirPath) || !fs.lstatSync(dirPath).isDirectory()) {
                throw new Error(`CLIENT_VALIDATION: Directory not found or is not a valid directory: ${dirPath}`);
            }
            if (!fs.existsSync(configPath)) {
                throw new Error(`CLIENT_VALIDATION: Configuration file 'lib.config.json' not found in ${dirPath}. Use 'tpkm init' to create one or ensure you are in the correct directory.`);
            }

            // --- 2. Read and parse lib.config.json ---
            let config;
            try {
                config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch (parseError) {
                throw new Error(`CLIENT_VALIDATION: Failed to parse 'lib.config.json': ${parseError.message}. Ensure it is valid JSON.`);
            }

            libraryName = config.name;
            // Use command-line version override if provided; otherwise, use the version from lib.config.json.
            versionString = options.version || config.version;

            // Validate essential configuration values from lib.config.json.
            if (!libraryName || typeof libraryName !== 'string') {
                throw new Error('CLIENT_VALIDATION: Missing or invalid "name" field in lib.config.json. It must be a string.');
            }
            if (!versionString) {
                // This occurs if version is missing in both lib.config.json and was not provided via the --version CLI option.
                throw new Error('CLIENT_VALIDATION: Library version is missing. Specify it in lib.config.json or use the --version option.');
            }
            if (!semver.valid(versionString)) {
                throw new Error(`CLIENT_VALIDATION: Invalid version format "${versionString}" (from config or --version option). Use semantic versioning (e.g., 1.0.0).`);
            }
            console.log(chalk.gray(`Publishing: ${libraryName}@${versionString}`));

            // Parse dependencies from config.dependencies object, if present.
            if (config.dependencies && typeof config.dependencies === 'object') {
                for (const [name, constraint] of Object.entries(config.dependencies)) {
                    if (!constraint || typeof constraint !== 'string') {
                        console.warn(chalk.yellow(`Warning: Invalid or missing version constraint for dependency "${name}" in lib.config.json. Skipping this dependency.`));
                        continue; // Skip dependencies with invalid or missing constraints.
                    }
                    // Validate constraint format using semver.validRange.
                    if (!semver.validRange(constraint)) {
                        console.warn(chalk.yellow(`Warning: Potentially invalid semantic version range "${constraint}" for dependency "${name}". TPKM will proceed, but ensure the constraint is correct.`));
                    }
                    dependenciesToPass.push({ name, constraint });
                }
                if (dependenciesToPass.length > 0) {
                    console.log(chalk.gray(`Including ${dependenciesToPass.length} dependencies from config: ${dependenciesToPass.map(d => `${d.name}@${d.constraint}`).join(', ')}`));
                }
            }

            // --- 3. Pre-check: Verify Ownership of the library on-chain ---
            const ownerCheckSpinner = ora({ text: `Verifying ownership of library "${libraryName}"...`, color: 'gray' }).start();
            try {
                const libInfo = await contractReadOnly.getLibraryInfo(libraryName); // Fetches owner, among other things.
                const ownerAddressOnChain = libInfo[0]; // Owner is expected to be the first element in the returned array.
                if (ownerAddressOnChain.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                    // Current wallet does not own the library record.
                    throw new Error(`CLIENT_VALIDATION: Permission Denied. Your wallet (${currentSignerWallet.address}) is not the registered owner (${ownerAddressOnChain}) of library "${libraryName}".`);
                }
                ownerCheckSpinner.succeed(chalk.gray(`Ownership confirmed for "${libraryName}".`));
            } catch (checkError) {
                ownerCheckSpinner.fail();
                const reason = getRevertReason(checkError);
                console.error(chalk.red('Pre-publication ownership check failed:'), reason);
                // Provide guidance if the library isn't registered yet.
                if (reason.toLowerCase().includes('library not found')) {
                    console.log(chalk.yellow(`It seems library "${libraryName}" is not registered yet. Use "tpkm register ${libraryName}" first.`));
                }
                throw new Error(`Pre-publication check failed: ${reason}`); // Re-throw to stop the publication process.
            }

            // --- 4. Archive the directory contents into a .tar.gz file ---
            const archiveSpinner = ora({ text: `Archiving directory content from ${dirPath}...`, color: 'yellow' }).start();
            try {
                await archiveDirectory(dirPath, tempArchivePath);
                // Spinner success message is handled by archiveDirectory itself if successful.
                archiveSpinner.succeed(chalk.gray(`Directory content archived successfully to: ${tempArchivePath}`));
            } catch (archiveError) {
                archiveSpinner.fail(chalk.red('Archiving failed.'));
                throw archiveError; // Stop the process if archiving fails.
            }

            // --- 5. Upload the archive to IPFS ---
            // The IPFS API URL is determined by ensureNetworkClientsInitialized.
            const ipfsUploadSpinner = ora({ text: `Uploading archive to IPFS via connected node...`, color: 'yellow' }).start();
            try {
                ipfsHash = await uploadToIpfs(tempArchivePath); // This function handles its own success log.
                if (!ipfsHash) { // Safety check, though uploadToIpfs should throw on critical failure.
                    throw new Error('IPFS upload completed but did not return a valid CID.');
                }
                ipfsUploadSpinner.succeed(chalk.green(`Archive uploaded to IPFS. CID: ${ipfsHash}`));
            } catch (uploadError) {
                ipfsUploadSpinner.fail(chalk.red('IPFS upload failed.'));
                throw uploadError; // Stop the process if IPFS upload fails.
            }

            // --- 6. Call Smart Contract to Publish Version ---
            const publishSpinner = ora({ text: `Publishing version ${versionString} of "${libraryName}" to the smart contract...`, color: 'yellow' }).start();
            try {
                // Call the `publishVersion` function on the writable contract instance.
                const tx = await writableContractInstance.publishVersion(
                    libraryName,
                    versionString,
                    ipfsHash,
                    dependenciesToPass // Pass the array of parsed dependencies.
                );
                publishSpinner.text = `Waiting for transaction confirmation (Tx Hash: ${tx.hash.substring(0,10)}...). This may take some time...`;
                await tx.wait(1); // Wait for 1 block confirmation.

                publishSpinner.succeed(chalk.green.bold(`Version ${versionString} of "${libraryName}" published successfully!`));
                console.log(chalk.blue(`  Transaction Hash: ${tx.hash}`));
                console.log(chalk.blue(`  IPFS Hash (CID):  ${ipfsHash}`));

            } catch (publishError) {
                publishSpinner.fail(chalk.red(`Failed to publish version ${versionString} to the smart contract:`));
                // Check for common contract errors like "Version already exists".
                console.error(chalk.red(`  ${getRevertReason(publishError)}`));
                throw publishError; // Propagate the error.
            }

        } catch (error) {
            // Catch errors from any stage: validation, config reading, pre-checks, archiving, IPFS upload, or contract call.
            console.error(chalk.red.bold('\nPublication process failed:'), error.message.startsWith('CLIENT_VALIDATION: ') ? error.message.substring('CLIENT_VALIDATION: '.length) : error.message);
            // Avoid logging the full error object unless in debug mode, as it can be verbose.
            if (process.env.DEBUG && error.stack) {
                console.error(error.stack);
            }
        } finally {
            // --- 7. Clean up the temporary archive file ---
            if (fs.existsSync(tempArchivePath)) {
                try {
                    fs.unlinkSync(tempArchivePath);
                    console.log(chalk.gray(`Temporary archive cleaned up from: ${tempArchivePath}`));
                } catch (cleanupError) {
                    // Log a warning if cleanup fails, but don't let it hide the main error.
                    console.warn(chalk.yellow(`Warning: Failed to clean up temporary archive: ${tempArchivePath}. Error: ${cleanupError.message}`));
                }
            }
        }
    });

/**
 * Command: tpkm install <libraryIdentifier>
 * Downloads a specific library version (and its dependencies recursively) from IPFS.
 * It resolves versions based on semantic versioning constraints found in dependency metadata,
 * checks for version conflicts, and extracts the downloaded archives into a local directory
 * (default: `tpkm_installed_libs` in the current working directory).
 * Format for libraryIdentifier: "libraryName@versionString" (e.g., "my-lib@1.0.0").
 */
program
    .command('install <libraryIdentifier>')
    .description('Download and extract a library version and its dependencies (e.g., "name" for latest, or "name@version").')
    .action(async (libraryIdentifier /*, options */) => {
        await ensureNetworkClientsInitialized();

        let libraryName = '';
        let versionString = ''; // This will be the exact version to install
        let versionConstraint = ''; // This will be the constraint (e.g. "1.0.0" or "*" for latest)

        const isSpecificVersion = libraryIdentifier.includes('@');

        if (isSpecificVersion) {
            const identifierRegex = /^([^@]+)@(.+)$/;
            const match = libraryIdentifier.match(identifierRegex);
            if (!match) {
                console.error(chalk.red('Invalid format. Use "libraryName" or "libraryName@versionString".'));
                return;
            }
            libraryName = match[1];
            versionString = match[2]; // User specified an exact version
            versionConstraint = versionString; // For specific version, constraint is the version itself

            if (!semver.valid(versionString)) {
                console.error(chalk.red(`Invalid version format specified: "${versionString}". Use semantic versioning.`));
                return;
            }
        } else {
            libraryName = libraryIdentifier;
            versionConstraint = '*'; // SemVer wildcard for "any version", maxSatisfying will pick latest stable
            console.log(chalk.gray(`No version specified for "${libraryName}". Attempting to install the latest stable version.`));
        }

        console.log(chalk.yellow.bold(`Starting installation process for ${libraryName}@${isSpecificVersion ? versionString : 'latest'}...`));
        const installRoot = path.join(process.cwd(), 'tpkm_installed_libs');
        const resolvedPackages = new Map();

        try {
            const installerPublicAddress = await getPublicAddressFromKeystore();

            // --- Top-level Access Check ---
            if (installerPublicAddress) {
                const accessCheckSpinner = ora({ text: `Checking your access to library "${libraryName}"...`, color: 'gray' }).start();
                try {
                    const hasAccess = await contractReadOnly.hasAccess(libraryName, installerPublicAddress);
                    if (!hasAccess) {
                        accessCheckSpinner.fail();
                        let reasonSuffix = `Ensure you are authorized or have the required license.`;
                        try { const libInfo = await contractReadOnly.getLibraryInfo(libraryName); if (libInfo.isPrivate) { reasonSuffix = `It's a private library. Request authorization from owner (${libInfo.owner}).`; } else if (libInfo.licenseRequired) { const feeStr = libInfo.licenseFee > 0 ? `${ethers.formatUnits(libInfo.licenseFee, 'ether')} ETH` : 'Free (claim required)'; reasonSuffix = `It requires a license (Fee: ${feeStr}). Purchase using "tpkm purchase-license ${libraryName}".`; } } catch(e) {}
                        throw new Error(`Access Denied: Wallet ${installerPublicAddress.substring(0,10)}... does not have permission for "${libraryName}". ${reasonSuffix}`);
                    }
                    accessCheckSpinner.succeed(chalk.gray('Access granted for top-level library (or library is public/no specific access needed).'));
                } catch (accessCheckError) {
                    if(accessCheckSpinner.isSpinning) accessCheckSpinner.fail();
                    console.error(chalk.red('Error during access check for the top-level library:'), getRevertReason(accessCheckError));
                    return;
                }
            } else {
                console.log(chalk.gray(`No local wallet for access checks. Proceeding, assuming public access or contract will handle permissions.`));
            }
            // --- End Top-level Access Check ---


            // --- Determine Version to Install if not specified (using versionConstraint) ---
            if (!isSpecificVersion) { // If user just typed "tpkm install libraryName"
                const resolveLatestSpinner = ora({ text: `Resolving latest version for "${libraryName}"...`, color: 'gray' }).start();
                try {
                    const availableVersions = await contractReadOnly.getVersionNumbers(libraryName);
                    if (!availableVersions || availableVersions.length === 0) {
                        resolveLatestSpinner.fail();
                        throw new Error(`No versions found for library "${libraryName}".`);
                    }
                    // Filter out pre-release versions unless explicitly requested (not supported yet)
                    const stableVersions = availableVersions.filter(v => semver.prerelease(v) === null);
                    if (stableVersions.length === 0) {
                        resolveLatestSpinner.fail();
                        throw new Error(`No stable versions found for "${libraryName}". Available (incl. pre-releases): ${availableVersions.join(', ')}`);
                    }
                    // semver.maxSatisfying with "*" on a clean list (no pre-releases) gives the highest stable.
                    // Or, sort and pick the latest: stableVersions.sort(semver.rcompare)[0];
                    versionString = semver.maxSatisfying(stableVersions, versionConstraint); // constraint is "*"
                    if (!versionString) { // Should not happen if stableVersions is not empty
                        resolveLatestSpinner.fail();
                        throw new Error(`Could not determine latest stable version for "${libraryName}" from [${stableVersions.join(', ')}].`);
                    }
                    resolveLatestSpinner.succeed(chalk.gray(`Latest stable version for "${libraryName}" resolved to: ${chalk.cyan(versionString)}`));
                } catch (error) {
                    if(resolveLatestSpinner.isSpinning) resolveLatestSpinner.fail();
                    console.error(chalk.red(`Error resolving latest version for "${libraryName}":`), getRevertReason(error));
                    return;
                }
            }
            // At this point, versionString is the EXACT version to install.
            // For the top-level package, the constraint passed to processInstallation will be this exact version.

            // --- Start Recursive Installation ---
            console.log(chalk.blue(`Resolving dependencies starting from ${libraryName}@${versionString}...`));
            await processInstallation(libraryName, versionString, resolvedPackages, installRoot, installerPublicAddress);
            // --- End Recursive Installation ---


            // --- Installation Summary ---
            console.log(chalk.green.bold(`\nInstallation finished successfully!`));
            if (resolvedPackages.size > 0) {
                console.log(chalk.cyan('Installed packages and their resolved versions:'));
                const installedTable = new Table({
                    head: [chalk.cyan('Package Name'), chalk.cyan('Installed Version')],
                    colWidths: [40, 20], // Adjust as needed.
                    style: { head: ['cyan'], border: ['grey'] }
                });
                resolvedPackages.forEach((version, name) => {
                    installedTable.push([name, version]);
                });
                console.log(installedTable.toString());
                console.log(chalk.blue(`\nLibraries installed in: ${installRoot}`));
            } else {
                // This state should ideally not be reached if processInstallation succeeded for the main package,
                // as the main package itself would be in resolvedPackages.
                console.log(chalk.yellow('No packages appear to have been installed. This might indicate an unexpected issue or that the requested package was already processed (check logs).'));
            }

        } catch (error) {
            // Catch errors thrown by `processInstallation` (e.g., version conflicts, download failures) or initial access checks.
            console.error(chalk.red.bold(`\nInstallation failed:`));
            // `error.message` is often more direct for non-contract errors like version conflicts.
            // `getRevertReason` is better for Ethereum-specific errors.
            console.error(chalk.red(`  ${error.message || getRevertReason(error)}`));
            if (process.env.DEBUG && error.stack) {
                console.error(error.stack); // Full stack trace in debug mode.
            }
            // Optionally suggest checking network, IPFS, or permissions based on the error type.
            if (error.message && error.message.toLowerCase().includes('version conflict')) {
                console.log(chalk.yellow('Hint: A version conflict occurred. Check the dependency requirements of your requested package and its sub-dependencies.'));
            }
        }
    });

/**
 * Command: tpkm list
 * Lists all library names registered in the TPKM smart contract.
 * Note: This command relies on a contract function (e.g., `getAllLibraryNames()`) that returns all names.
 * On networks with a very large number of registered libraries, this might be inefficient or slow
 * if the contract iterates through storage to compile the list.
 */
program
    .command('list')
    .description('List all registered library names in the TPKM registry (can be slow on large registries).')
    .action(async () => {
        await ensureNetworkClientsInitialized(); // Need read-only contract access.

        const listSpinner = ora({ text: `Fetching list of all registered libraries from contract at ${currentActiveContractAddress}...`, color: 'yellow' }).start();
        // Add a note about potential performance issues with this command on large registries.
        console.warn(chalk.magenta('\nNote: Depending on the smart contract implementation and the number of libraries, listing all libraries might be slow or consume significant resources on public networks.'));

        try {
            // Assumes the smart contract has a function like `getAllLibraryNames()` that returns an array of strings.
            // The actual function name might vary based on the contract's ABI.
            const libraryNames = await contractReadOnly.getAllLibraryNames();

            if (libraryNames && libraryNames.length > 0) {
                listSpinner.succeed(chalk.green(`Found ${libraryNames.length} registered libraries.`));

                // Display the names in a simple, single-column table for clarity.
                const table = new Table({
                    head: [chalk.cyan.bold('Registered Library Name')],
                    colWidths: [70], // Adjust width as needed for typical library names.
                    style: { head: ['cyan'], border: ['grey'] },
                    // Using prettier table characters for a more defined look.
                    chars: { 'top': '═', 'top-mid': '╤', 'top-left': '╔', 'top-right': '╗',
                             'bottom': '═', 'bottom-mid': '╧', 'bottom-left': '╚', 'bottom-right': '╝',
                             'left': '║', 'left-mid': '╟', 'mid': '─', 'mid-mid': '┼',
                             'right': '║', 'right-mid': '╢', 'middle': '│' }
                });

                // Create a shallow copy and sort it alphabetically to avoid modifying the original read-only array from the contract.
                const sortedLibraryNames = [...libraryNames].sort((a, b) => a.localeCompare(b));

                // Iterate over the sorted copy and add each library name as a new row to the table.
                sortedLibraryNames.forEach(name => {
                    table.push([name]);
                });

                console.log(table.toString());
            } else {
                listSpinner.info(chalk.gray('No libraries are currently registered in this TPKM registry.'));
            }
        } catch (error) {
            listSpinner.fail(chalk.red('Error fetching library list:'));
            // Check if the error indicates the contract might not support the `getAllLibraryNames` function.
            if (error.message && (error.message.toLowerCase().includes('call revert exception') || error.message.toLowerCase().includes('function selector was not recognized') || error.message.toLowerCase().includes('is not a function'))) {
                console.error(chalk.red(`  The connected smart contract at ${currentActiveContractAddress} may not support the 'getAllLibraryNames' function, or another contract error occurred.`));
                console.error(chalk.yellow('  Ensure the ABI is correct and the contract implements this feature.'));
            }
            console.error(chalk.red(`  ${getRevertReason(error)}`)); // Use helper for more specific error details.
            if (process.env.DEBUG) console.error(error.stack); // Full stack trace in debug mode.
        }
    });

/**
 * Command: tpkm deprecate <libraryIdentifier>
 * Marks a specific version of a library as deprecated in the smart contract registry.
 * This action serves as a warning to users who might try to install or depend on this version.
 * It requires the caller (identified by their wallet) to be the owner of the library record.
 * Format for libraryIdentifier: "libraryName@versionString".
 */
program
    .command('deprecate <libraryIdentifier>')
    .description('Mark a specific library version as deprecated (format: "name@version"). Requires library ownership.')
    .action(async (libraryIdentifier) => {
        await ensureNetworkClientsInitialized(); // Ensure network access is established.
        // Deprecating a version requires signing a transaction, so load the wallet.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return; // Exit if wallet loading fails.

        // Parse and validate the libraryIdentifier format ("libraryName@versionString").
        const identifierRegex = /^([^@]+)@(.+)$/;
        const match = libraryIdentifier.match(identifierRegex);
        if (!match) {
            console.error(chalk.red('Invalid library identifier format. Please use "libraryName@versionString" (e.g., my-lib@1.0.0).'));
            return;
        }
        const [, libraryName, versionString] = match; // Destructure to get name and version.

        // Validate the version string using semver.
        if (!semver.valid(versionString)) {
            console.error(chalk.red(`Invalid version format: "${versionString}". Please use semantic versioning (e.g., 1.0.0).`));
            return;
        }

        console.log(chalk.yellow(`Attempting to mark version ${libraryName}@${versionString} as deprecated...`));

        // --- Pre-checks before sending the deprecation transaction ---
        const checkSpinner = ora({ text: `Verifying ownership and version status for ${libraryName}@${versionString}...`, color: 'gray' }).start();
        try {
            // 1. Verify ownership of the library. `getLibraryInfo` also implicitly checks if the library exists.
            const libInfo = await contractReadOnly.getLibraryInfo(libraryName);
            const ownerAddressOnChain = libInfo[0]; // Owner address is expected at index 0.
            if (ownerAddressOnChain.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                checkSpinner.fail(); // Stop spinner before throwing.
                throw new Error(`CLIENT_VALIDATION: Permission Denied. Your wallet (${currentSignerWallet.address}) is not the owner (${ownerAddressOnChain}) of library "${libraryName}".`);
            }

            // 2. Verify the specific version exists and check if it's already deprecated.
            // `getVersionInfo` will throw if the version is not found.
            // Expected return: [ipfsHash, publisher, timestamp, isDeprecated, dependencies]
            const versionInfo = await contractReadOnly.getVersionInfo(libraryName, versionString);
            const alreadyDeprecated = versionInfo[3]; // 'isDeprecated' flag is expected at index 3.
            if (alreadyDeprecated) {
                checkSpinner.warn(chalk.yellow(`${libraryName}@${versionString} is already marked as deprecated. No action needed.`));
                return; // Exit if already deprecated.
            }

            checkSpinner.succeed(chalk.gray(`Ownership confirmed. Version ${versionString} exists and is not currently deprecated.`));
        } catch (checkError) {
            checkSpinner.fail(chalk.red('Pre-deprecation check failed:'));
            // Handle errors like library/version not found, or permission issues already caught.
            console.error(chalk.red(`  ${getRevertReason(checkError)}`));
            return; // Stop the process if any pre-check fails.
        }
        // --- End of Pre-checks ---


        // Confirm the deprecation action with the user.
        const { confirmDeprecate } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmDeprecate',
            message: `Are you sure you want to mark ${libraryName}@${versionString} as deprecated? This action signals to users that this version should not be used (e.g., due to bugs or being superseded). This can usually be reversed by the owner if needed.`,
            default: true // Default to Yes, but user must explicitly confirm.
        }]);

        if (!confirmDeprecate) {
            console.log(chalk.blue('Deprecation cancelled by user.'));
            return;
        }

        // Send the deprecation transaction to the smart contract.
        const deprecateSpinner = ora({ text: `Sending transaction to deprecate ${libraryName}@${versionString}...`, color: 'yellow' }).start();
        try {
            // Assumes the smart contract has a `deprecateVersion(string name, string version)` function.
            const tx = await writableContractInstance.deprecateVersion(libraryName, versionString);
            deprecateSpinner.text = `Waiting for transaction confirmation (Tx Hash: ${tx.hash.substring(0,10)}...). This may take a moment...`;
            await tx.wait(1); // Wait for 1 block confirmation.
            deprecateSpinner.succeed(chalk.green.bold(`${libraryName}@${versionString} has been marked as deprecated successfully!`));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));
        } catch (error) {
            deprecateSpinner.fail(chalk.red(`Error deprecating ${libraryName}@${versionString}:`));
            console.error(chalk.red(`  ${getRevertReason(error)}`)); // Use helper for parsed revert reasons.
            if (process.env.DEBUG) console.error(error.stack); // Full stack trace in debug mode.
        }
    });

/**
 * Command: tpkm authorize <libraryName> <userAddress>
 * Grants a specific user address permission to access (e.g., download, view info of)
 * a private library owned by the caller. This requires the caller to be the owner of the library.
 * Authorization is managed on-chain.
 */
program
    .command('authorize <libraryName> <userAddress>')
    .description('Grant access to a private library for a specific user address. Requires library ownership.')
    .action(async (libraryName, userAddress) => {
        await ensureNetworkClientsInitialized(); // Ensure network access is ready.
        // Authorizing a user requires signing a transaction.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return;

        // Validate the user address format.
        if (!ethers.isAddress(userAddress)) {
            console.error(chalk.red(`Invalid Ethereum address provided for user: ${userAddress}. Please use a valid address (e.g., 0x...).`));
            return;
        }
        // Prevent authorizing the zero address, which is often an invalid target.
        if (userAddress === ethers.ZeroAddress) {
            console.error(chalk.red('Cannot authorize the zero address (0x000...000). Please provide a valid user address.'));
            return;
        }

        console.log(chalk.yellow(`Attempting to authorize user ${userAddress} for private library "${libraryName}"...`));

        // --- Pre-checks before sending transaction ---
        const checkSpinner = ora({ text: `Verifying library ownership, privacy status, and current user authorization...`, color: 'gray' }).start();
        try {
            // 1. Get library info to check ownership and privacy status.
            // Expected return: [owner, description, tags, isPrivate, language, ...]
            const libInfo = await contractReadOnly.getLibraryInfo(libraryName);
            const ownerAddressOnChain = libInfo[0]; // Owner address.
            const isPrivate = libInfo[3]; // isPrivate flag.

            // 2. Verify the caller is the owner of the library.
            if (ownerAddressOnChain.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                checkSpinner.fail();
                throw new Error(`CLIENT_VALIDATION: Permission Denied. Your wallet (${currentSignerWallet.address}) is not the owner (${ownerAddressOnChain}) of library "${libraryName}".`);
            }

            // 3. Verify the library is actually private. Authorization is only relevant for private libraries.
            if (!isPrivate) {
                checkSpinner.fail();
                throw new Error(`CLIENT_VALIDATION: Operation Not Applicable. Library "${libraryName}" is public. Authorization is only needed for private libraries.`);
            }

            // 4. Check if the user to be authorized is the owner themselves (owners inherently have access).
            if (userAddress.toLowerCase() === ownerAddressOnChain.toLowerCase()) {
                checkSpinner.warn(chalk.yellow(`User ${userAddress} is the owner of "${libraryName}" and already has full access. No explicit authorization needed.`));
                return; // Exit if trying to authorize the owner.
            }

            // 5. Check if the user is *already* authorized using the `hasAccess` contract function.
            const currentlyAuthorized = await contractReadOnly.hasAccess(libraryName, userAddress);
            if (currentlyAuthorized) {
                checkSpinner.info(chalk.blue(`User ${userAddress} is already authorized to access "${libraryName}". No action needed.`));
                return; // Exit gracefully if user is already authorized.
            }

            checkSpinner.succeed(chalk.gray(`Checks passed: You own the private library "${libraryName}", and user ${userAddress.substring(0,10)}... is not yet authorized.`));
        } catch (checkError) {
            checkSpinner.fail(chalk.red('Pre-authorization check failed:'));
            console.error(chalk.red(`  ${getRevertReason(checkError)}`)); // Handle library not found, etc.
            return; // Stop if checks fail.
        }
        // --- End of Pre-checks ---


        // Send the authorization transaction.
        const authSpinner = ora({ text: `Sending transaction to authorize user ${userAddress.substring(0,10)}... for "${libraryName}"...`, color: 'yellow' }).start();
        try {
            // Assumes the smart contract has an `authorizeUser(string name, address user)` function.
            const tx = await writableContractInstance.authorizeUser(libraryName, userAddress);
            authSpinner.text = `Waiting for transaction confirmation (Tx Hash: ${tx.hash.substring(0,10)}...). This may take a moment...`;
            await tx.wait(1); // Wait for 1 block confirmation.
            authSpinner.succeed(chalk.green.bold(`User ${userAddress} authorized successfully for library "${libraryName}"!`));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));
        } catch (error) {
            authSpinner.fail(chalk.red(`Error authorizing user for "${libraryName}":`));
            console.error(chalk.red(`  ${getRevertReason(error)}`)); // Use helper for parsed revert reasons.
            if (process.env.DEBUG) console.error(error.stack); // Full stack trace in debug mode.
        }
    });

/**
 * Command: tpkm revoke <libraryName> <userAddress>
 * Revokes a previously granted access permission for a specific user address
 * from a private library owned by the caller. Requires library ownership.
 * Revocation is managed on-chain.
 */
program
    .command('revoke <libraryName> <userAddress>')
    .description('Revoke access to a private library for a specific user address. Requires library ownership.')
    .action(async (libraryName, userAddress) => {
        await ensureNetworkClientsInitialized(); // Ensure network access.
        // Revoking access requires signing a transaction.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return;

        // Validate the user address format.
        if (!ethers.isAddress(userAddress)) {
            console.error(chalk.red(`Invalid Ethereum address provided for user: ${userAddress}. Please use a valid address (e.g., 0x...).`));
            return;
        }

        console.log(chalk.yellow(`Attempting to revoke access for user ${userAddress} from private library "${libraryName}"...`));

        // --- Pre-checks before sending transaction ---
        const checkSpinner = ora({ text: `Verifying library ownership, status, and user's current authorization...`, color: 'gray' }).start();
        try {
            // 1. Get library info for ownership and privacy status check.
            const libInfo = await contractReadOnly.getLibraryInfo(libraryName);
            const ownerAddressOnChain = libInfo[0]; // Owner address.
            const isPrivate = libInfo[3]; // isPrivate flag.

            // 2. Verify the caller is the owner.
            if (ownerAddressOnChain.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                checkSpinner.fail();
                throw new Error(`CLIENT_VALIDATION: Permission Denied. Your wallet (${currentSignerWallet.address}) is not the owner (${ownerAddressOnChain}) of library "${libraryName}".`);
            }

            // 3. Verify the library is private. Revocation is for private libraries.
            if (!isPrivate) {
                checkSpinner.fail();
                throw new Error(`CLIENT_VALIDATION: Operation Not Applicable. Library "${libraryName}" is public. Revocation only applies to private libraries.`);
            }

            // 4. Prevent revoking the owner's own access (owners always have access and cannot be revoked this way).
            if (userAddress.toLowerCase() === ownerAddressOnChain.toLowerCase()) {
                checkSpinner.warn(chalk.yellow(`Cannot revoke access for the library owner (${userAddress}). Owners always retain access and cannot be managed via authorize/revoke for themselves.`));
                return; // Exit if trying to revoke owner.
            }

            // 5. Check if the user actually *has* access currently (is authorized). You can only revoke existing access.
            const currentlyAuthorized = await contractReadOnly.hasAccess(libraryName, userAddress);
            if (!currentlyAuthorized) {
                checkSpinner.info(chalk.blue(`User ${userAddress} is not currently authorized for library "${libraryName}". No revocation needed.`));
                return; // Exit gracefully if user isn't authorized anyway.
            }

            checkSpinner.succeed(chalk.gray(`Checks passed: You own the private library "${libraryName}", and user ${userAddress.substring(0,10)}... is currently authorized.`));
        } catch (checkError) {
            checkSpinner.fail(chalk.red('Pre-revocation check failed:'));
            console.error(chalk.red(`  ${getRevertReason(checkError)}`)); // Handle library not found, etc.
            return; // Stop if checks fail.
        }
        // --- End of Pre-checks ---

        // Confirm the revocation action with the user.
        const { confirmRevoke } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmRevoke',
            message: `Are you sure you want to revoke access for user ${userAddress} from library "${libraryName}"? They will no longer be able to access this private library.`,
            default: true // Default to Yes for confirmation.
        }]);

        if (!confirmRevoke) {
            console.log(chalk.blue('Revocation cancelled by user.'));
            return;
        }

        // Send the revocation transaction.
        const revokeSpinner = ora({ text: `Sending transaction to revoke access for ${userAddress.substring(0,10)}... from "${libraryName}"...`, color: 'yellow' }).start();
        try {
            // Assumes the smart contract has a `revokeAuthorization(string name, address user)` function.
            const tx = await writableContractInstance.revokeAuthorization(libraryName, userAddress);
            revokeSpinner.text = `Waiting for transaction confirmation (Tx Hash: ${tx.hash.substring(0,10)}...). This may take a moment...`;
            await tx.wait(1); // Wait for 1 block confirmation.
            revokeSpinner.succeed(chalk.green.bold(`Authorization revoked successfully for user ${userAddress} from library "${libraryName}"!`));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));
        } catch (error) {
            revokeSpinner.fail(chalk.red(`Error revoking authorization for "${libraryName}":`));
            console.error(chalk.red(`  ${getRevertReason(error)}`)); // Use helper for parsed revert reasons.
            if (process.env.DEBUG) console.error(error.stack); // Full stack trace in debug mode.
        }
    });

/**
 * Command: tpkm delete <libraryName>
 * Deletes the entire library record from the smart contract registry.
 * This is a destructive and typically irreversible action.
 * It is usually restricted by the contract to the library owner and may require
 * that the library has no published versions remaining.
 */
program
    .command('delete <libraryName>')
    .description('PERMANENTLY delete a registered library record. Requires ownership and NO published versions. IRREVERSIBLE.')
    .action(async (libraryName) => {
        await ensureNetworkClientsInitialized(); // Ensure network clients are ready.
        // Deleting a library record is a privileged action requiring a signed transaction.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return; // Exit if wallet loading failed.

        // Display strong warnings about the irreversibility of this action.
        console.log(chalk.red.bold('\n!!! WARNING: IRREVERSIBLE AND DESTRUCTIVE ACTION !!!'));
        console.log(chalk.yellow(`You are attempting to permanently delete the entire library record for "${libraryName}" from the TPKM registry on network "${currentActiveNetworkName}".`));
        console.log(chalk.yellow(`This will remove all associated metadata: owner, description, tags, list of versions, and access control settings (authorizations/licenses).`));
        console.log(chalk.yellow(`Published version data (IPFS CIDs for archives) will remain on IPFS if pinned, but will become unresolvable and unmanageable via this TPKM registry instance.`));
        console.log(chalk.red.bold('This action cannot be undone.\n'));

        // --- Pre-checks before prompting for confirmation ---
        const checkSpinner = ora({ text: `Verifying ownership and conditions for deleting "${libraryName}"...`, color: 'gray' }).start();
        let preCheckPassed = false;
        try {
            // 1. Verify ownership. `getLibraryInfo` also implicitly checks if the library exists (throws if not).
            const libInfo = await contractReadOnly.getLibraryInfo(libraryName);
            const ownerAddr = libInfo[0]; // Owner address.
            if (ownerAddr.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                checkSpinner.fail(); // Fail spinner before throwing custom client-side error.
                throw new Error(`CLIENT_VALIDATION: Permission Denied. Your wallet (${currentSignerWallet.address}) is not the owner (${ownerAddr}) of library "${libraryName}".`);
            }
            checkSpinner.text = `Ownership confirmed for "${libraryName}". Checking for published versions...`;

            // 2. Check for published versions. Smart contracts often (and should) prevent deletion if versions exist.
            const versions = await contractReadOnly.getVersionNumbers(libraryName);
            if (versions.length > 0) {
                checkSpinner.fail(); // Fail spinner before throwing.
                throw new Error(`CLIENT_VALIDATION: Cannot delete library "${libraryName}". It currently has ${versions.length} published version(s). The smart contract (and CLI policy) typically prevents deletion of libraries with active versions. Please manage or deprecate these versions first, or ensure the contract allows this (highly discouraged).`);
            }

            checkSpinner.succeed(chalk.gray(`Checks passed: Ownership confirmed and no published versions found for "${libraryName}". Ready for deletion confirmation.`));
            preCheckPassed = true;

        } catch (checkError) {
            // If spinner was not already failed (e.g., getLibraryInfo itself failed before version check).
            if (checkSpinner.isSpinning) {
                checkSpinner.fail();
            }
            // Handle client-side validation errors directly for cleaner messages; parse others.
            if (checkError.message && checkError.message.startsWith('CLIENT_VALIDATION: ')) {
                console.error(chalk.red('Pre-deletion check failed:'), chalk.redBright(checkError.message.substring('CLIENT_VALIDATION: '.length)));
            } else {
                console.error(chalk.red('Pre-deletion check failed:'), getRevertReason(checkError));
            }
            return; // Stop execution if any pre-check fails.
        }

        // This check should be redundant if the catch block always returns, but added for logical safety.
        if (!preCheckPassed) {
            console.log(chalk.blue('Pre-checks did not pass. Deletion aborted.'));
            return;
        }
        // --- End of Pre-checks ---


        // --- Multi-Step Confirmation (Crucial for such a destructive action) ---
        try {
            // First confirmation: type 'yes'.
            const { confirmYes } = await inquirer.prompt([{
                type: 'input', // Using 'input' to force deliberate typing of 'yes'.
                name: 'confirmYes',
                message: chalk.red.bold(`This action is final. Type 'yes' to confirm you want to PERMANENTLY delete the library "${libraryName}":`),
                validate: input => input.toLowerCase() === 'yes' || "Please type 'yes' to confirm deletion, or any other input to cancel.",
                filter: input => input.toLowerCase() // Ensure comparison works by lowercasing input.
            }]);

            if (confirmYes !== 'yes') {
                console.log(chalk.blue('Library deletion cancelled by user (first confirmation was not "yes").'));
                return;
            }

            // Second confirmation: type the library name exactly.
            const { confirmName } = await inquirer.prompt([{
                type: 'input',
                name: 'confirmName',
                message: chalk.red.bold(`For final confirmation, type the library name "${libraryName}" EXACTLY as shown to finalize deletion:`),
                validate: input => input === libraryName || `Input must exactly match the library name "${libraryName}". Any other input will cancel.`
            }]);

            if (confirmName !== libraryName) { // Second confirmation must match the exact library name.
                console.log(chalk.blue('Library deletion cancelled by user (library name mismatch in final confirmation).'));
                return;
            }
        } catch (promptError) { // Catch errors during the inquirer prompt phase itself.
            console.error(chalk.red('Error during confirmation prompt:'), promptError.message);
            return; // Exit if prompting fails.
        }
        // --- End Confirmation ---


        // If both confirmations pass, proceed with the transaction to delete the library.
        const deleteSpinner = ora({ text: `Sending transaction to delete library "${libraryName}" from the registry...`, color: 'yellow' }).start();
        try {
            // Call the smart contract's `deleteLibrary` function.
            const tx = await writableContractInstance.deleteLibrary(libraryName);
            deleteSpinner.text = `Waiting for transaction confirmation (Tx Hash: ${tx.hash.substring(0,10)}...). This may take some time...`;
            await tx.wait(1); // Wait for 1 block confirmation.
            deleteSpinner.succeed(chalk.green.bold(`Library "${libraryName}" and all its metadata deleted successfully from the registry!`));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));
        } catch (error) {
            deleteSpinner.fail(chalk.red(`Error deleting library "${libraryName}":`));
            // The contract itself should revert if conditions for deletion aren't met (e.g., versions still exist despite client-side checks).
            console.error(chalk.red(`  ${getRevertReason(error)}`));
            if (process.env.DEBUG) {
                console.error(error.stack); // Full stack trace in debug mode.
            }
        }
    });

/**
 * Command: tpkm abandon-registry
 * Transfers ownership of the LibraryRegistry smart contract itself to a specified burn address
 * (defaulting to a common one like 0x...dEaD). This is an EXTREMELY DANGEROUS and IRREVERSIBLE action,
 * as it effectively relinquishes all administrative control over this specific contract instance
 * (e.g., pausing, upgrading via Ownable2Step patterns, changing global contract fees, etc.).
 * Only the current contract owner (as per Ownable pattern) can execute this.
 */
program
    .command('abandon-registry')
    .description('IRREVERSIBLY transfer contract ownership to a burn address (e.g., 0x...dEaD). EXTREMELY DANGEROUS.')
    .option('--burn-address <address>', 'The Ethereum address to transfer ownership to (this address cannot recover control if it is a true burn address).', '0x000000000000000000000000000000000000dEaD') // Common dead/burn address.
    .action(async (options) => {
        await ensureNetworkClientsInitialized(); // Network access needed to interact with the contract.
        // This command requires the signer to be the current owner of the contract.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return; // Wallet loading failed.

        const burnAddress = options.burnAddress;

        // Validate the burn address format.
        if (!ethers.isAddress(burnAddress)) {
            console.error(chalk.red(`Invalid burn address provided: "${burnAddress}". Please use a valid Ethereum address.`));
            return;
        }
        if (burnAddress === ethers.ZeroAddress) {
            console.warn(chalk.yellow.bold(`Warning: You are about to transfer ownership to the zero address (${ethers.ZeroAddress}). This is a valid burn mechanism, but means NO ONE can ever control or administer this contract instance again.`));
        } else if (burnAddress.toLowerCase() === '0x000000000000000000000000000000000000dead') {
            console.log(chalk.yellow(`Using common burn address: ${burnAddress}`));
        } else {
            console.warn(chalk.yellow(`Using custom burn address: ${burnAddress}. Ensure this is an address from which keys are irretrievably lost.`));
        }


        // --- Display Strong Warnings about the consequences ---
        console.log(chalk.red.bold('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'));
        console.log(chalk.red.bold('!!!           EXTREME DANGER ZONE             !!!'));
        console.log(chalk.red.bold('!!!   YOU ARE ABOUT TO ABANDON THIS REGISTRY  !!!'));
        console.log(chalk.red.bold('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'));
        console.log(chalk.red(`This will transfer ownership of the LibraryRegistry smart contract:`));
        console.log(chalk.yellow(`  Contract Address: ${currentActiveContractAddress}`));
        console.log(chalk.yellow(`  Current Network:  ${currentActiveNetworkName} (RPC: ${currentActiveRpcUrl})`));
        console.log(chalk.red(`Ownership will be PERMANENTLY transferred to the burn address:`));
        console.log(chalk.yellow(`  Burn Address:     ${burnAddress}`));
        console.log(chalk.red('\nAfter this action, your current wallet (and likely anyone else, if a true burn address is used) will lose ALL administrative control over this contract instance FOREVER.'));
        console.log(chalk.red('This means functions like pausing, unpausing, upgrading (if the contract supports Ownable2Step or similar patterns), or changing any contract-level parameters (e.g., global fees, if applicable) will become unusable by any party.'));
        console.log(chalk.red.bold('THERE IS NO UNDO. This is a step towards full decentralization and immutability of the registry, but removes all safety nets.\n'));


        // --- Pre-check: Verify Signer is the Current Contract Owner ---
        const checkOwnerSpinner = ora({ text: `Verifying you are the current contract owner of ${currentActiveContractAddress}...`, color: 'gray' }).start();
        let currentContractOwner;
        try {
            // Assumes the contract implements OpenZeppelin's Ownable.sol (or a similar pattern) and has an `owner()` view function.
            currentContractOwner = await writableContractInstance.owner(); // Fetches the current owner from the contract.
            if (currentContractOwner.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                checkOwnerSpinner.fail();
                console.error(chalk.red(`Error: Your current wallet (${currentSignerWallet.address}) is NOT the owner of the contract.`));
                console.error(chalk.red(`The current registered owner of the contract is: ${currentContractOwner}`));
                console.error(chalk.red(`Only the current owner can transfer ownership. Aborting.`));
                return;
            }
            checkOwnerSpinner.succeed(chalk.gray(`Confirmed: Your wallet (${currentSignerWallet.address}) is the current owner of the contract.`));
        } catch (ownerCheckError) {
            checkOwnerSpinner.fail();
            console.error(chalk.red('Error verifying contract ownership:'), getRevertReason(ownerCheckError));
            console.error(chalk.yellow('Ensure the contract ABI includes the `owner()` function, the contract is deployed, accessible, and implements an ownership pattern.'));
            return;
        }
        // --- End Pre-check ---


        // --- Multi-Step Confirmation for such a critical action ---
        // Using readline for more complex, multi-input confirmations if inquirer feels too simple for this gravity.
        // However, for CLI, multiple inquirer prompts are also effective. Let's stick to inquirer for consistency.
        try {
            const { confirmUnderstand } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmUnderstand',
                message: chalk.yellow.bold('Do you fully understand the irreversible consequences of abandoning this contract registry and wish to proceed?'),
                default: false // Default to NO for safety.
            }]);
            if (!confirmUnderstand) {
                console.log(chalk.green('Registry abandonment cancelled by user. No changes made.'));
                return;
            }

            const confirmText = `abandon contract ${currentActiveContractAddress.slice(0, 10).toLowerCase()}`; // Use part of contract address
            const { confirmType } = await inquirer.prompt([{
                type: 'input',
                name: 'confirmType',
                message: chalk.red.bold(`This action is final and cannot be undone. To confirm, please type EXACTLY: "${confirmText}":`),
                validate: input => input === confirmText || `Input must exactly match "${confirmText}". Any other input will cancel.`
            }]);

            if (confirmType !== confirmText) { // Final check
                console.log(chalk.red('Confirmation text did not match. Registry abandonment cancelled for safety.'));
                return;
            }
        } catch (promptError) {
            console.error(chalk.red('Error during confirmation prompt:'), promptError.message);
            return; // Exit if prompting fails.
        }
        // --- End Confirmation ---


        // --- Execute Ownership Transfer ---
        const abandonSpinner = ora({ text: `Sending transaction to transfer ownership of contract ${currentActiveContractAddress} to burn address ${burnAddress}...`, color: 'yellow' }).start();
        try {
            // Assumes the contract uses OpenZeppelin's `Ownable.sol` `transferOwnership(address newOwner)` function.
            const tx = await writableContractInstance.transferOwnership(burnAddress);
            abandonSpinner.text = `Waiting for transaction confirmation (Tx Hash: ${tx.hash.substring(0,10)}...). This may take considerable time...`;
            await tx.wait(1); // Wait for 1 block confirmation.
            abandonSpinner.succeed(chalk.green.bold('Contract ownership successfully transferred to the burn address!'));
            console.log(chalk.blue(`Transaction Hash: ${tx.hash}`));
            console.log(chalk.red.bold('Administrative control via your wallet is now PERMANENTLY GONE for this contract instance. The contract is now abandoned to the specified burn address.'));

            // Optionally, verify the new owner on-chain immediately after.
            const verifyOwnerSpinner = ora({ text: `Verifying new owner on-chain...`, color: 'gray' }).start();
            try {
                const newOwner = await writableContractInstance.owner(); // Call owner() again on the (now read-only from our perspective if we weren't the burn addr) contract.
                if (newOwner.toLowerCase() === burnAddress.toLowerCase()) {
                    verifyOwnerSpinner.succeed(chalk.green(`Confirmed: New contract owner is now ${newOwner} (the burn address).`));
                } else {
                    // This case should be highly unlikely if the transaction succeeded but is a critical check.
                    verifyOwnerSpinner.fail(chalk.red.bold(`CRITICAL VERIFICATION ERROR: New owner on-chain (${newOwner}) does NOT match the intended burn address (${burnAddress}). Investigate IMMEDIATELY! The transaction may have had unexpected behavior.`));
                }
            } catch (verifyError) {
                verifyOwnerSpinner.fail(chalk.red(`Error re-fetching owner after transfer: ${verifyError.message}. The transfer likely succeeded, but on-chain verification failed.`));
            }

        } catch (error) {
            abandonSpinner.fail(chalk.red('Error transferring contract ownership:'));
            console.error(chalk.red(`  ${getRevertReason(error)}`)); // Use helper for parsed revert reasons.
            if (process.env.DEBUG) console.error(error.stack); // Full stack trace in debug mode.
        }
    });

/**
 * Command: tpkm init
 * Creates a template `lib.config.json` file in the current working directory.
 * This file is required for publishing a library and contains essential metadata
 * such as the library's name, version, description, language, and dependencies.
 * Prompts the user for these details interactively.
 */
program
    .command('init')
    .description('Initialize a new lib.config.json file in the current directory for a TPKM library.')
    .action(async () => {
        const configFilePath = path.join(process.cwd(), 'lib.config.json');
        console.log(chalk.yellow('Initializing new TPKM library configuration (lib.config.json)...'));

        // Check if a config file already exists and prompt before overwriting to prevent accidental data loss.
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

        // --- Interactive Questions to gather configuration details ---
        const questions = [
            {
                type: 'input',
                name: 'name',
                message: 'Library name (e.g., my-cool-library):',
                // Suggest current directory name, cleaned to be a valid TPKM/npm-style package name.
                default: path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, ''),
                validate: function (value) {
                    // Stricter validation (similar to npm): lowercase letters, numbers, hyphens.
                    // Must not start or end with a hyphen. Max length around 214 chars.
                    if (value && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 214) {
                        return true;
                    }
                    return 'Invalid name. Use lowercase letters, numbers, and hyphens only (e.g., my-cool-library). Cannot start/end with a hyphen, and must be <= 214 chars.';
                },
            },
            {
                type: 'input',
                name: 'version',
                message: 'Initial version:',
                default: '0.1.0', // Common starting version for new projects.
                validate: function (value) {
                    if (semver.valid(value)) { // Use semver library for robust version validation.
                        return true;
                    }
                    return 'Invalid version. Please use semantic versioning (e.g., 1.0.0, 0.2.1-beta.1).';
                },
            },
            {
                type: 'input',
                name: 'description',
                message: 'Description (optional, a brief summary of what the library does):',
                default: '',
            },
            {
                type: 'input',
                name: 'language',
                message: 'Primary programming language (optional, e.g., javascript, python, solidity):',
                default: '',
            },
            // Potential future questions for a more comprehensive config: author, license, repository URL...
            // { type: 'input', name: 'author', message: 'Author (optional):' },
            // { type: 'input', name: 'license', message: 'License (optional, e.g., MIT, GPL-3.0-or-later):', default: 'MIT' },
        ];

        try {
            const answers = await inquirer.prompt(questions);

            // --- Construct the lib.config.json Object ---
            const libConfig = {
                // Consider adding a schema version for future compatibility, e.g., "$schemaVersion": "1.0"
                name: answers.name,
                version: answers.version,
                // Only include optional fields in the JSON if they have a value (were provided by the user).
                ...(answers.description && { description: answers.description }),
                ...(answers.language && { language: answers.language }),
                // Include an empty dependencies object by default for users to fill in as needed.
                dependencies: {
                    // "example-dependency-name": "^1.2.0" // Example format for a TPKM dependency
                },
                // Add other common fields if desired, e.g., author, license, repository:
                // "author": answers.author || "",
                // "license": answers.license || "UNLICENSED", // Or prompt for it.
                // "repository": { "type": "git", "url": "" } // Prompt for repo URL.
            };

            // --- Write the Configuration File ---
            // Use JSON.stringify with an indent (2 spaces) for human-readable output.
            fs.writeFileSync(configFilePath, JSON.stringify(libConfig, null, 2), 'utf8');
            console.log(chalk.green(`\n'lib.config.json' created successfully at: ${configFilePath}`));
            console.log(chalk.blue('\nNext steps:'));
            console.log(chalk.blue('  1. Add your library code files to this directory.'));
            console.log(chalk.blue('  2. Update the `dependencies` section in lib.config.json if your library uses other TPKM packages.'));
            console.log(chalk.blue(`     Example: "dependencies": { "another-tpkm-lib": "^1.0.0" }`));
            console.log(chalk.blue(`  3. Register your library name on TPKM (if not done yet): tpkm register ${answers.name} [options]`));
            console.log(chalk.blue('  4. Publish your first version: tpkm publish .'));

        } catch (error) {
            // Catch errors that might occur during the inquirer prompt phase (e.g., if prompts are interrupted).
            console.error(chalk.red('Error during initialization process:'), error.message);
            if (process.env.DEBUG) console.error(error); // Log full error object in debug mode.
        }
    });

// --- NEW: SET-LICENSE Command ---
// Allows the owner of a library to set or update its licensing terms on the TPKM registry.
// This includes specifying a license fee (in Ether) and whether a license is required for access.
program
    .command('set-license <libraryName>')
    .description('Set or update the license requirements for a library you own (fee and requirement status).')
    .option('-f, --fee <amount_with_unit>', 'License fee (e.g., "0.01 eth", "10000 gwei", "0 eth" for free-to-claim if required). Use "0 eth" or "none" to signify no fee if a license is still required (e.g., for tracking).')
    .option('-r, --required <true_or_false>', 'Whether a license is explicitly required for access (boolean: "true" or "false").')
    .action(async (libraryName, options) => {
        await ensureNetworkClientsInitialized(); // Connect to network.
        // Setting license terms is a privileged action requiring a signed transaction.
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return; // Wallet loading failed.

        console.log(chalk.yellow(`Attempting to set/update license configuration for library "${libraryName}"...`));
        const opSpinner = ora({ text: `Fetching current library information and ownership for "${libraryName}"...`, color: 'gray' }).start();

        let currentLibInfo;
        try {
            // Fetch current library info to verify ownership and get current license state.
            // Expected: [owner, desc, tags, isPrivate, lang, licenseFee, licenseRequired]
            currentLibInfo = await contractReadOnly.getLibraryInfo(libraryName);
            const ownerAddressOnChain = currentLibInfo.owner; // Or currentLibInfo[0] if using direct array access.

            // Verify the current user is the owner of the library.
            if (ownerAddressOnChain.toLowerCase() !== currentSignerWallet.address.toLowerCase()) {
                opSpinner.fail();
                throw new Error(`CLIENT_VALIDATION: Permission Denied. Your wallet (${currentSignerWallet.address}) is not the owner (${ownerAddressOnChain}) of library "${libraryName}".`);
            }
            opSpinner.succeed('Ownership confirmed. Proceeding with license configuration.');
        } catch (error) {
            if (opSpinner.isSpinning) opSpinner.fail();
            console.error(chalk.red(`Error fetching library info or checking ownership:`), getRevertReason(error));
            return;
        }

        // Initialize with current values from the contract.
        let feeInWei = currentLibInfo.licenseFee; // Current fee in Wei (BigInt).
        let isRequired = currentLibInfo.licenseRequired; // Current license requirement status (boolean).

        // Interactively prompt for fee and requirement if not provided via CLI options.
        const questions = [];
        if (options.fee === undefined) { // Prompt for fee if not given in CLI.
            questions.push({
                type: 'input', name: 'fee',
                message: `Current license fee is ${ethers.formatUnits(feeInWei, 'ether')} ETH. Enter new fee (e.g., "0.01 eth", "0 eth", or "none" for no fee). Press Enter to keep current:`,
                default: ethers.formatUnits(feeInWei, 'ether') + ' eth', // Show current as default.
            });
        }
        if (options.required === undefined) { // Prompt for requirement status if not given in CLI.
            questions.push({
                type: 'confirm', name: 'required',
                message: `Currently, a license is ${isRequired ? chalk.yellow.bold('REQUIRED') : chalk.green('NOT required')}. Do you want to change this?`,
                default: isRequired // Default to current status.
            });
        }

        let answers = {};
        if (questions.length > 0) {
            answers = await inquirer.prompt(questions);
        }

        // Determine the new feeInWei based on CLI option or prompt answer.
        const feeInputString = options.fee !== undefined ? options.fee : answers.fee;
        if (feeInputString !== undefined && feeInputString.toLowerCase() !== (ethers.formatUnits(currentLibInfo.licenseFee, 'ether') + ' eth')) { // Check if value changed from default prompt.
            if (feeInputString.toLowerCase() === 'none' || feeInputString.trim() === "0" || feeInputString.trim().toLowerCase() === "0 eth" || feeInputString.trim().toLowerCase() === "0 ether" || feeInputString.trim().toLowerCase() === "0 gwei") {
                feeInWei = ethers.parseUnits("0", "ether"); // Explicitly set to 0 Wei.
            } else {
                try {
                    // Parse amount and unit (e.g., "0.01 eth", "10000 gwei").
                    const parts = feeInputString.toLowerCase().trim().split(/\s+/);
                    if (parts.length !== 2 || isNaN(parseFloat(parts[0])) || !['eth', 'ether', 'gwei', 'wei'].includes(parts[1])) {
                        throw new Error('Invalid fee format. Use "<amount> <unit>" (e.g., "0.01 eth", "100 gwei") or "0 eth" or "none".');
                    }
                    feeInWei = ethers.parseUnits(parts[0], parts[1] === 'eth' ? 'ether' : parts[1]);
                } catch (e) {
                    console.error(chalk.red(`Invalid fee input: "${feeInputString}". ${e.message}`));
                    return;
                }
            }
        }


        // Determine the new isRequired status.
        if (options.required !== undefined) {
            isRequired = (options.required.toLowerCase() === 'true');
        } else if (answers.required !== undefined) {
            isRequired = answers.required;
        }
        // If fee is > 0, license should generally be considered required.
        // Contract might enforce this, or this CLI can guide it.
        if (feeInWei > 0 && !isRequired) {
            console.warn(chalk.yellow(`Warning: A license fee (${ethers.formatUnits(feeInWei, 'ether')} ETH) is set, but 'licenseRequired' is false. Users might not be prompted to pay. Consider setting 'licenseRequired' to true.`));
            // Optionally, automatically set isRequired = true if fee > 0, or prompt user again.
            // For now, let's allow this state but warn.
        }


        // Client-side check: Private libraries cannot have a "licenseRequired=true" state.
        // Their access is managed by direct `authorize`/`revoke` commands.
        if (currentLibInfo.isPrivate && isRequired) {
            console.error(chalk.red('Error: Private libraries cannot be set to "licenseRequired=true".'));
            console.log(chalk.yellow('Access to private libraries is managed via direct authorization (e.g., "tpkm authorize ...").'));
            console.log(chalk.yellow('If you intend for this library to be public and require a license, ensure it is registered as public or update its metadata accordingly (if supported by contract).'));
            return;
        }

        console.log(chalk.gray(`  Updating License Settings to: Required = ${isRequired}, Fee = ${ethers.formatUnits(feeInWei, 'ether')} ETH (${feeInWei.toString()} Wei)`));

        const setLicenseSpinner = ora({ text: `Sending transaction to set license terms for "${libraryName}"...`, color: 'yellow' }).start();
        try {
            // Call the smart contract function to set the library's license terms.
            // Assumes contract function: `setLibraryLicense(string name, uint256 fee, bool required)`
            const tx = await writableContractInstance.setLibraryLicense(libraryName, feeInWei, isRequired);
            setLicenseSpinner.text = `Waiting for transaction confirmation (Tx Hash: ${tx.hash.substring(0,10)}...). This may take a moment...`;
            await tx.wait(1); // Wait for 1 block confirmation.
            setLicenseSpinner.succeed(chalk.green.bold(`License configuration for "${libraryName}" updated successfully!`));
            console.log(chalk.blue(`  Transaction Hash: ${tx.hash}`));
            console.log(chalk.blue(`  New Fee: ${ethers.formatUnits(feeInWei, 'ether')} ETH, License Required: ${isRequired}`));
        } catch (error) {
            setLicenseSpinner.fail(chalk.red(`Error setting license terms for "${libraryName}":`));
            console.error(chalk.red(`  ${getRevertReason(error)}`)); // Use helper for parsed revert reasons.
            if (process.env.DEBUG) console.error(error.stack); // Full stack trace in debug mode.
        }
    });

// --- NEW: PURCHASE-LICENSE Command ---
// Allows users to purchase a lifetime access license for a public library that requires one.
// The user's wallet sends the required fee (if any) to the smart contract.
program
    .command('purchase-license <libraryName>')
    .description('Purchase a lifetime access license for a public library that requires one.')
    .option('-a, --amount <amount_eth_or_gwei>', 'Optional: Amount of ETH/Gwei to send with the transaction (e.g., "0.01 eth"). If not provided, the exact fee from the contract will be used. Overpayment may be refunded by the contract.')
    .action(async (libraryName, options) => {
        await ensureNetworkClientsInitialized(); // Connect to network.
        // Purchasing a license involves sending a transaction with value (Ether).
        const { contract: writableContractInstance, wallet: currentSignerWallet } = await loadWalletAndConnect();
        if (!writableContractInstance || !currentSignerWallet) return; // Wallet loading failed.

        console.log(chalk.yellow(`Attempting to purchase license for library "${libraryName}" with wallet ${currentSignerWallet.address.substring(0,10)}...`));
        const opSpinner = ora({ text: `Fetching license information and your status for "${libraryName}"...`, color: 'gray' }).start();

        try {
            // Fetch library information: owner, privacy, fee, requirement status.
            // Expected: [owner, desc, tags, isPrivate, lang, licenseFee, licenseRequired]
            const libInfo = await contractReadOnly.getLibraryInfo(libraryName);
            const libOwnerOnChain = libInfo.owner;
            const isLibPrivate = libInfo.isPrivate;
            const licenseFeeOnChain = libInfo.licenseFee; // This is a BigInt representing Wei.
            const licenseIsRequired = libInfo.licenseRequired;

            // Check if the current user is the owner; owners don't need to purchase licenses for their own libraries.
            if (currentSignerWallet.address.toLowerCase() === libOwnerOnChain.toLowerCase()) {
                opSpinner.info(chalk.yellow(`You are the owner of "${libraryName}". Owners inherently have access and do not need to purchase a license.`));
                return;
            }

            // Check if the library is private. License purchases are typically for public, licensed libraries.
            // Private library access is managed via direct `authorize` commands by the owner.
            if (isLibPrivate) {
                opSpinner.fail(chalk.red(`Operation Failed: Library "${libraryName}" is private.`));
                console.log(chalk.yellow('Licenses are typically purchased for public libraries that have set a fee and requirement.'));
                console.log(chalk.yellow('Access to private libraries is granted directly by the owner using "tpkm authorize".'));
                return;
            }

            // Check if a license is actually required for this public library.
            if (!licenseIsRequired) {
                opSpinner.info(chalk.green(`Good news! Library "${libraryName}" is public and does not require a license purchase for access.`));
                // User might still have access via hasAccess(), but purchase isn't the mechanism.
                return;
            }

            // Check if the user already owns a license for this library.
            const alreadyHasLicense = await contractReadOnly.hasUserLicense(libraryName, currentSignerWallet.address);
            if (alreadyHasLicense) {
                opSpinner.succeed(chalk.green(`You already own a license for "${libraryName}". No purchase necessary.`));
                return;
            }

            // If all checks pass, proceed with purchase logic.
            opSpinner.succeed(chalk.gray(`License is required for public library "${libraryName}". Fee: ${ethers.formatUnits(licenseFeeOnChain, 'ether')} ETH (${licenseFeeOnChain.toString()} Wei).`));

            let amountToSendInWei = licenseFeeOnChain; // Default to sending the exact fee from the contract.
            if (options.amount) { // If user specified an amount with --amount flag.
                try {
                    if (options.amount.trim() === "0" && licenseFeeOnChain > 0) {
                        throw new Error('Amount to send cannot be 0 if the license fee is greater than 0.');
                    } else if (options.amount.trim() === "0" || options.amount.trim().toLowerCase() === "0 eth" || options.amount.trim().toLowerCase() === "0 ether" || options.amount.trim().toLowerCase() === "0 gwei") {
                        amountToSendInWei = ethers.parseUnits("0", "ether"); // For free-to-claim licenses if fee is 0.
                    } else {
                        const parts = options.amount.toLowerCase().trim().split(/\s+/);
                        if (parts.length !== 2 || isNaN(parseFloat(parts[0])) || !['eth', 'ether', 'gwei', 'wei'].includes(parts[1])) {
                            throw new Error('Invalid amount format. Use "<value> <unit>" (e.g., "0.01 eth", "100 gwei").');
                        }
                        amountToSendInWei = ethers.parseUnits(parts[0], parts[1] === 'eth' ? 'ether' : parts[1]);
                    }
                    console.log(chalk.gray(`You specified to send: ${ethers.formatUnits(amountToSendInWei, 'ether')} ETH.`));
                } catch (e) {
                    console.error(chalk.red(`Invalid amount provided ("${options.amount}"): ${e.message}`));
                    return;
                }
            }

            // Ensure the amount to send is not less than the required fee.
            if (amountToSendInWei < licenseFeeOnChain) {
                console.error(chalk.red(`Error: Amount to send (${ethers.formatUnits(amountToSendInWei, 'ether')} ETH) is less than the required license fee (${ethers.formatUnits(licenseFeeOnChain, 'ether')} ETH).`));
                return;
            }
            if (amountToSendInWei > licenseFeeOnChain) {
                console.warn(chalk.yellow(`Note: You are sending ${ethers.formatUnits(amountToSendInWei, 'ether')} ETH. The contract requires ${ethers.formatUnits(licenseFeeOnChain, 'ether')} ETH. Any overpayment should be refunded by the smart contract if it's designed to do so.`));
            }

            // Confirm purchase with the user.
            const { confirmPurchase } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmPurchase',
                message: `Proceed to purchase license for "${libraryName}" by sending ${ethers.formatUnits(amountToSendInWei, 'ether')} ETH?`,
                default: true
            }]);

            if (!confirmPurchase) {
                console.log(chalk.blue('License purchase cancelled by user.'));
                return;
            }

            opSpinner.start(`Sending transaction to purchase license for "${libraryName}"...`);
            // Call the smart contract function `purchaseLibraryLicense`, sending `amountToSendInWei` as msg.value.
            // Assumes contract function: `purchaseLibraryLicense(string name) payable`
            const tx = await writableContractInstance.purchaseLibraryLicense(libraryName, { value: amountToSendInWei });
            opSpinner.text = `Waiting for transaction confirmation (Tx Hash: ${tx.hash.substring(0,10)}...). This may take a moment...`;
            await tx.wait(1); // Wait for 1 block confirmation.
            opSpinner.succeed(chalk.green.bold(`License for "${libraryName}" purchased successfully!`));
            console.log(chalk.blue(`  Transaction Hash: ${tx.hash}`));
            if (amountToSendInWei > licenseFeeOnChain) {
                console.log(chalk.yellow(`  An overpayment of ${ethers.formatUnits(amountToSendInWei - licenseFeeOnChain, 'ether')} ETH was sent. If the contract supports refunds, this should have been returned to your wallet.`));
            }

        } catch (error) {
            if (opSpinner.isSpinning) opSpinner.fail(); // Ensure spinner stops on error.
            console.error(chalk.red(`Error purchasing license for "${libraryName}":`), getRevertReason(error));
            if (process.env.DEBUG) console.error(error.stack); // Full stack trace in debug mode.
        }
    });


// =============================================================================
// --- Parse CLI Arguments and Execute Corresponding Actions ---
// =============================================================================

// Process the command-line arguments based on the defined commands and options.
// Commander.js handles routing to the appropriate .action() handlers.
program.parse(process.argv);

// --- Handle edge cases where no command or an incomplete command is provided ---

// If no arguments are given (e.g., just running `tpkm`), or if only a global option like `--help` is provided,
// display the main help menu for the TPKM tool.
// Commander usually handles `--help` automatically, but this catches the bare command case specifically.
// Exclude cases where a valid command was run without its own arguments but is waiting for prompts (handled by action).
const args = process.argv.slice(2); // Get arguments after 'node' and the script path.
if (args.length === 0) {
    program.outputHelp(); // Show help if 'tpkm' is run with no arguments.
}
// If only 'tpkm config' is run, without a specific config subcommand (add, list, etc.),
// show the help menu specific to the 'config' command group.
else if (args.length === 1 && args[0] === 'config') {
    configCommand.outputHelp();
}
// If only 'tpkm wallet' is run, without a specific wallet subcommand,
// show the help menu specific to the 'wallet' command group.
else if (args.length === 1 && args[0] === 'wallet') {
    walletCommand.outputHelp();
}

// For all other cases (valid command + arguments, or valid command that prompts for args),
// Commander.js will have already invoked the appropriate `.action()` handler defined above.