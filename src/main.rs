mod assets;

use assets::{AssetLedger, AssetOperation};
use chrono::prelude::*;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const INITIAL_DIFFICULTY: usize = 4;
const MIN_DIFFICULTY: usize = 1;
const TARGET_BLOCK_TIME_SECONDS: i64 = 60;
const LEGACY_TARGET_BLOCK_TIME_SECONDS: i64 = 30;
const DIFFICULTY_WINDOW_BLOCKS: usize = 10;
const ROLLING_DIFFICULTY_START_BLOCK: u64 = 6;
const REPLAY_PROTECTION_START_BLOCK: u64 = 10;
#[cfg(test)]
const GENESIS_TIMESTAMP: i64 = 1_700_000_000;
const INITIAL_MINING_REWARD: f64 = 10.0;
const HALVING_INTERVAL: u64 = 100_000;
const MAX_COIN_SUPPLY: f64 = 67_000_000.0;
const BALANCE_EPSILON: f64 = 0.000_000_01;
const DEFAULT_PEER_PORT: u16 = 7101;

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Transaction {
    sender: String,
    recipient: String,
    amount: f64,
    sender_public_key: String,
    signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asset_operation: Option<AssetOperation>,
}

impl Transaction {
    fn new(sender: &str, recipient: &str, amount: f64, signing_key: &SigningKey) -> Self {
        let sender_public_key = bytes_to_hex(signing_key.verifying_key().as_bytes());
        let payload = Transaction::payload(sender, recipient, amount, &sender_public_key, None);
        let signature = signing_key.sign(payload.as_bytes());

        Transaction {
            sender: sender.to_string(),
            recipient: recipient.to_string(),
            amount,
            sender_public_key,
            signature: bytes_to_hex(&signature.to_bytes()),
            asset_operation: None,
        }
    }

    fn system(sender: &str, recipient: &str, amount: f64) -> Self {
        Transaction {
            sender: sender.to_string(),
            recipient: recipient.to_string(),
            amount,
            sender_public_key: String::new(),
            signature: String::new(),
            asset_operation: None,
        }
    }

    fn coinbase(recipient: &str, amount: f64) -> Self {
        Transaction::system("network", recipient, amount)
    }

    fn create_coin(
        sender: &str,
        symbol: String,
        name: String,
        supply: f64,
        signing_key: &SigningKey,
    ) -> Result<Self, String> {
        let sender_public_key = bytes_to_hex(signing_key.verifying_key().as_bytes());
        let asset_operation = AssetOperation::create_coin(symbol, name, supply)?;
        let payload = Transaction::payload(
            sender,
            &sender_public_key,
            0.0,
            &sender_public_key,
            Some(&asset_operation),
        );
        let signature = signing_key.sign(payload.as_bytes());

        Ok(Transaction {
            sender: sender.to_string(),
            recipient: sender_public_key.clone(),
            amount: 0.0,
            sender_public_key,
            signature: bytes_to_hex(&signature.to_bytes()),
            asset_operation: Some(asset_operation),
        })
    }

    fn transfer_coin(
        sender: &str,
        recipient: String,
        symbol: String,
        amount: f64,
        signing_key: &SigningKey,
    ) -> Result<Self, String> {
        let sender_public_key = bytes_to_hex(signing_key.verifying_key().as_bytes());
        let asset_operation = AssetOperation::transfer_coin(symbol, amount)?;
        let payload = Transaction::payload(
            sender,
            &recipient,
            0.0,
            &sender_public_key,
            Some(&asset_operation),
        );
        let signature = signing_key.sign(payload.as_bytes());

        Ok(Transaction {
            sender: sender.to_string(),
            recipient,
            amount: 0.0,
            sender_public_key,
            signature: bytes_to_hex(&signature.to_bytes()),
            asset_operation: Some(asset_operation),
        })
    }

    fn mint_nft(
        sender: &str,
        collection: String,
        token_id: String,
        name: String,
        image_url: Option<String>,
        signing_key: &SigningKey,
    ) -> Result<Self, String> {
        let sender_public_key = bytes_to_hex(signing_key.verifying_key().as_bytes());
        let asset_operation = AssetOperation::mint_nft(collection, token_id, name, image_url)?;
        let payload = Transaction::payload(
            sender,
            &sender_public_key,
            0.0,
            &sender_public_key,
            Some(&asset_operation),
        );
        let signature = signing_key.sign(payload.as_bytes());

        Ok(Transaction {
            sender: sender.to_string(),
            recipient: sender_public_key.clone(),
            amount: 0.0,
            sender_public_key,
            signature: bytes_to_hex(&signature.to_bytes()),
            asset_operation: Some(asset_operation),
        })
    }

    fn transfer_nft(
        sender: &str,
        recipient: String,
        collection: String,
        token_id: String,
        signing_key: &SigningKey,
    ) -> Result<Self, String> {
        let sender_public_key = bytes_to_hex(signing_key.verifying_key().as_bytes());
        let asset_operation = AssetOperation::transfer_nft(collection, token_id)?;
        let payload = Transaction::payload(
            sender,
            &recipient,
            0.0,
            &sender_public_key,
            Some(&asset_operation),
        );
        let signature = signing_key.sign(payload.as_bytes());

        Ok(Transaction {
            sender: sender.to_string(),
            recipient,
            amount: 0.0,
            sender_public_key,
            signature: bytes_to_hex(&signature.to_bytes()),
            asset_operation: Some(asset_operation),
        })
    }

    fn is_valid_signed_transaction(&self) -> bool {
        if self.sender == "network" {
            return false;
        }

        if let Some(operation) = self.asset_operation.as_ref() {
            if operation.requires_zero_xyqon_amount() && !amounts_equal(self.amount, 0.0) {
                return false;
            }
        } else if self.amount <= 0.0 {
            return false;
        }

        let Some(public_key_bytes) = hex_to_array::<32>(&self.sender_public_key) else {
            return false;
        };
        let Some(signature_bytes) = hex_to_array::<64>(&self.signature) else {
            return false;
        };

        let Ok(public_key) = VerifyingKey::from_bytes(&public_key_bytes) else {
            return false;
        };

        let signature = Signature::from_bytes(&signature_bytes);
        let payload = Transaction::payload(
            &self.sender,
            &self.recipient,
            self.amount,
            &self.sender_public_key,
            self.asset_operation.as_ref(),
        );

        public_key.verify(payload.as_bytes(), &signature).is_ok()
    }

    fn is_valid_genesis_transaction(&self) -> bool {
        self.sender == "network"
            && self.recipient == "genesis"
            && self.amount == 0.0
            && self.sender_public_key.is_empty()
            && self.signature.is_empty()
    }

    fn is_valid_coinbase_reward(&self, expected_reward: f64) -> bool {
        self.sender == "network"
            && !self.recipient.is_empty()
            && amounts_equal(self.amount, expected_reward)
            && self.sender_public_key.is_empty()
            && self.signature.is_empty()
    }

    fn payload(
        sender: &str,
        recipient: &str,
        amount: f64,
        sender_public_key: &str,
        asset_operation: Option<&AssetOperation>,
    ) -> String {
        let base = format!("{sender}|{recipient}|{amount:.8}|{sender_public_key}");
        match asset_operation {
            Some(operation) => {
                let operation = serde_json::to_string(operation)
                    .expect("asset operation should serialize for signing");
                format!("{base}|{operation}")
            }
            None => base,
        }
    }

    fn id(&self) -> String {
        let serialized = serde_json::to_string(self).expect("transaction should serialize");
        let mut hasher = Sha256::new();
        hasher.update(serialized);
        format!("{:x}", hasher.finalize())
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct WalletFile {
    name: String,
    public_key: String,
    private_key: String,
}

impl WalletFile {
    fn generate(name: String) -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);

        WalletFile {
            name,
            public_key: bytes_to_hex(signing_key.verifying_key().as_bytes()),
            private_key: bytes_to_hex(&signing_key.to_bytes()),
        }
    }

    fn load(path: &str) -> Result<Self, String> {
        let contents =
            fs::read_to_string(path).map_err(|error| format!("failed to read wallet: {error}"))?;
        serde_json::from_str(&contents).map_err(|error| format!("failed to parse wallet: {error}"))
    }

    fn save(&self, path: &str) -> Result<(), String> {
        let contents = serde_json::to_string_pretty(self)
            .map_err(|error| format!("failed to serialize wallet: {error}"))?;
        fs::write(path, contents).map_err(|error| format!("failed to save wallet: {error}"))
    }

    fn signing_key(&self) -> Result<SigningKey, String> {
        let Some(private_key_bytes) = hex_to_array::<32>(&self.private_key) else {
            return Err("wallet private key must be a 32-byte hex string".to_string());
        };

        Ok(SigningKey::from_bytes(&private_key_bytes))
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Block {
    index: u64,
    timestamp: i64,
    difficulty: usize,
    transactions: Vec<Transaction>,
    previous_hash: String,
    hash: String,
    nonce: u64,
}

impl Block {
    fn new(
        index: u64,
        timestamp: i64,
        difficulty: usize,
        transactions: Vec<Transaction>,
        previous_hash: String,
    ) -> Self {
        let mut block = Block {
            index,
            timestamp,
            difficulty,
            transactions,
            previous_hash,
            hash: String::new(),
            nonce: 0,
        };

        block.mine_block(difficulty);
        block
    }

    fn calculate_hash(&self) -> String {
        let transactions =
            serde_json::to_string(&self.transactions).expect("transactions should serialize");
        let input = format!(
            "{}{}{}{}{}{}",
            self.index,
            self.timestamp,
            self.difficulty,
            transactions,
            self.previous_hash,
            self.nonce
        );

        let mut hasher = Sha256::new();
        hasher.update(input);
        format!("{:x}", hasher.finalize())
    }

    fn mine_block(&mut self, difficulty: usize) {
        let target = "0".repeat(difficulty);

        while !self.hash.starts_with(&target) {
            self.nonce += 1;
            self.hash = self.calculate_hash();
        }

        println!("Block mined: {}", self.hash);
    }

    fn is_valid(&self, expected_difficulty: usize, expected_reward: f64) -> bool {
        self.hash == self.calculate_hash()
            && self.difficulty == expected_difficulty
            && self.hash.starts_with(&"0".repeat(expected_difficulty))
            && self.has_valid_transactions(expected_reward)
    }

    fn has_valid_transactions(&self, expected_reward: f64) -> bool {
        if self.index == 0 {
            return self.transactions.len() == 1
                && self.transactions[0].is_valid_genesis_transaction();
        }

        let Some((coinbase, transactions)) = self.transactions.split_first() else {
            return false;
        };

        coinbase.is_valid_coinbase_reward(expected_reward)
            && transactions
                .iter()
                .all(Transaction::is_valid_signed_transaction)
    }

    fn coinbase_amount(&self) -> f64 {
        if self.index == 0 {
            return 0.0;
        }

        self.transactions
            .first()
            .map(|transaction| transaction.amount)
            .unwrap_or(0.0)
    }

    fn normal_transactions(&self) -> &[Transaction] {
        if self.index == 0 || self.transactions.is_empty() {
            return &[];
        }

        &self.transactions[1..]
    }
}

#[derive(Debug, Default)]
struct WalletBalances {
    balances: HashMap<String, f64>,
}

impl WalletBalances {
    fn new() -> Self {
        WalletBalances {
            balances: HashMap::new(),
        }
    }

    fn from_chain(chain: &[Block]) -> Self {
        let mut balances = WalletBalances::new();
        for block in chain.iter().skip(1) {
            balances.apply_block(block);
        }

        balances
    }

    fn apply_block(&mut self, block: &Block) -> bool {
        if let Some(coinbase) = block.transactions.first() {
            self.credit(&coinbase.recipient, coinbase.amount);
        }

        for transaction in block.normal_transactions() {
            if self.apply_signed_transaction(transaction).is_err() {
                return false;
            }
        }

        true
    }

    fn apply_signed_transaction(&mut self, transaction: &Transaction) -> Result<(), String> {
        if transaction.asset_operation.is_some() {
            if !amounts_equal(transaction.amount, 0.0) {
                return Err("asset transactions must use a 0 XYQON amount".to_string());
            }
            return Ok(());
        }

        if transaction.amount <= 0.0 {
            return Err("transaction amount must be positive".to_string());
        }

        let balance = self.balance(&transaction.sender_public_key);
        if balance + BALANCE_EPSILON < transaction.amount {
            return Err(format!(
                "insufficient funds for {}; balance is {}, attempted to spend {}",
                transaction.sender, balance, transaction.amount
            ));
        }

        self.debit(&transaction.sender_public_key, transaction.amount);
        self.credit(&transaction.recipient, transaction.amount);
        Ok(())
    }

    fn balance(&self, public_key: &str) -> f64 {
        *self.balances.get(public_key).unwrap_or(&0.0)
    }

    fn credit(&mut self, public_key: &str, amount: f64) {
        *self.balances.entry(public_key.to_string()).or_insert(0.0) += amount;
    }

    fn debit(&mut self, public_key: &str, amount: f64) {
        *self.balances.entry(public_key.to_string()).or_insert(0.0) -= amount;
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Blockchain {
    chain: Vec<Block>,
    circulating_supply: f64,
}

impl Blockchain {
    fn load(path: &str) -> Result<Self, String> {
        if !Path::new(path).exists() {
            return Err(format!(
                "chain file does not exist: {path}; start with a synced live chain file"
            ));
        }

        let contents =
            fs::read_to_string(path).map_err(|error| format!("failed to read chain: {error}"))?;
        let mut blockchain: Blockchain = serde_json::from_str(&contents)
            .map_err(|error| format!("failed to parse chain: {error}"))?;
        blockchain.recalculate_circulating_supply();

        if !blockchain.is_valid() {
            return Err(format!("stored chain is invalid: {path}"));
        }

        Ok(blockchain)
    }

    fn latest_block(&self) -> &Block {
        self.chain.last().unwrap()
    }

    #[cfg(test)]
    fn add_block(
        &mut self,
        mut transactions: Vec<Transaction>,
        miner_reward_recipient: String,
    ) -> Result<Block, String> {
        if miner_reward_recipient.is_empty() {
            return Err("miner reward recipient cannot be empty".to_string());
        }

        if !transactions
            .iter()
            .all(Transaction::is_valid_signed_transaction)
        {
            return Err("block contains an invalid transaction signature".to_string());
        }

        self.validate_spending(&transactions)?;

        let reward = self.allowed_reward_for_next_block();
        if reward <= 0.0 {
            return Err(format!(
                "max supply of {MAX_COIN_SUPPLY} XYQON has already been reached"
            ));
        }

        transactions.insert(0, Transaction::coinbase(&miner_reward_recipient, reward));

        let prev = self.latest_block();
        let timestamp = Utc::now().timestamp();
        let difficulty = expected_difficulty_for_next_block(&self.chain, timestamp);
        let new_block = Block::new(
            prev.index + 1,
            timestamp,
            difficulty,
            transactions,
            prev.hash.clone(),
        );
        self.chain.push(new_block.clone());
        self.circulating_supply += reward;
        Ok(new_block)
    }

    fn add_received_block(&mut self, block: Block) -> Result<(), String> {
        let previous = self.latest_block();

        if block.index != previous.index + 1 {
            return Err(format!(
                "expected block index {}, got {}",
                previous.index + 1,
                block.index
            ));
        }

        if block.previous_hash != previous.hash {
            return Err("received block does not link to local chain tip".to_string());
        }

        let expected_difficulty = expected_difficulty_for_next_block(&self.chain, block.timestamp);
        let expected_reward = self.allowed_reward_for_next_block();
        if !block.is_valid(expected_difficulty, expected_reward) {
            return Err(format!(
                "received block failed validation; expected difficulty {expected_difficulty} and reward {expected_reward}"
            ));
        }

        self.validate_spending(block.normal_transactions())?;

        let new_supply = self.circulating_supply + block.coinbase_amount();
        if new_supply > MAX_COIN_SUPPLY {
            return Err(format!(
                "received block would exceed max supply of {MAX_COIN_SUPPLY} XYQON"
            ));
        }

        self.circulating_supply = new_supply;
        self.chain.push(block);
        Ok(())
    }

    fn is_valid(&self) -> bool {
        let mut total_supply = 0.0;
        let mut balances = WalletBalances::new();
        let mut assets = AssetLedger::new();
        let mut confirmed_transaction_ids = HashSet::new();

        for i in 1..self.chain.len() {
            let current = &self.chain[i];
            let previous = &self.chain[i - 1];
            let expected_difficulty =
                expected_difficulty_for_next_block(&self.chain[..i], current.timestamp);
            let expected_reward = allowed_mining_reward_for_block(current.index, total_supply);

            if !current.is_valid(expected_difficulty, expected_reward) {
                return false;
            }

            if current.previous_hash != previous.hash {
                return false;
            }

            for transaction in current.normal_transactions() {
                let transaction_id = transaction.id();
                if current.index < REPLAY_PROTECTION_START_BLOCK {
                    confirmed_transaction_ids.insert(transaction_id);
                } else if !confirmed_transaction_ids.insert(transaction_id) {
                    return false;
                }
            }

            if !balances.apply_block(current) {
                return false;
            }

            if assets.apply_block(current).is_err() {
                return false;
            }

            total_supply += current.coinbase_amount();
            if total_supply > MAX_COIN_SUPPLY {
                return false;
            }
        }

        amounts_equal(total_supply, self.circulating_supply)
    }

    fn current_supply(&self) -> f64 {
        self.circulating_supply
    }

    fn allowed_reward_for_next_block(&self) -> f64 {
        allowed_mining_reward_for_block(self.latest_block().index + 1, self.circulating_supply)
    }

    fn recalculate_circulating_supply(&mut self) {
        self.circulating_supply = self.chain.iter().skip(1).map(Block::coinbase_amount).sum();
    }

    fn wallet_balance(&self, wallet: &WalletFile) -> f64 {
        self.balance_for_public_key(&wallet.public_key)
    }

    fn balance_for_public_key(&self, public_key: &str) -> f64 {
        WalletBalances::from_chain(&self.chain).balance(public_key)
    }

    fn validate_spending(&self, transactions: &[Transaction]) -> Result<(), String> {
        let mut balances = WalletBalances::from_chain(&self.chain);
        let mut assets = AssetLedger::from_chain(&self.chain)?;
        let mut seen_transaction_ids = self.confirmed_transaction_ids();
        for transaction in transactions {
            let transaction_id = transaction.id();
            if !seen_transaction_ids.insert(transaction_id.clone()) {
                return Err(format!(
                    "transaction has already been confirmed: {transaction_id}"
                ));
            }
            balances.apply_signed_transaction(transaction)?;
            assets.apply_transaction(transaction)?;
        }

        Ok(())
    }

    fn confirmed_transaction_ids(&self) -> HashSet<String> {
        self.chain
            .iter()
            .flat_map(Block::normal_transactions)
            .map(Transaction::id)
            .collect()
    }

    fn replace_with_better_chain(&mut self, candidate: Blockchain) -> Result<bool, String> {
        if !candidate.is_valid() {
            return Err("candidate chain is invalid".to_string());
        }

        if candidate.chain_score() <= self.chain_score() {
            return Ok(false);
        }

        *self = candidate;
        self.recalculate_circulating_supply();
        Ok(true)
    }

    fn chain_score(&self) -> u128 {
        self.chain
            .iter()
            .skip(1)
            .map(|block| 1_u128 << block.difficulty.min(63))
            .sum()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
enum NetworkMessage {
    NewBlock(Block),
    NewTransaction(Transaction),
    NewPeer(String),
    RequestChain,
    ChainResponse(Blockchain),
    RequestPeers,
    PeerResponse(Vec<String>),
}

#[derive(Debug, Clone)]
struct PeerBook {
    peers: Arc<Mutex<Vec<String>>>,
    peers_file: Option<String>,
    local_addr: Option<String>,
}

impl PeerBook {
    fn new(
        peers: Vec<String>,
        peers_file: Option<String>,
        local_addr: Option<String>,
    ) -> Result<Self, String> {
        let peer_book = PeerBook {
            peers: Arc::new(Mutex::new(Vec::new())),
            peers_file,
            local_addr: local_addr.and_then(|addr| normalize_peer_address(&addr)),
        };

        peer_book.extend(peers)?;

        if let Some(path) = peer_book.peers_file.as_deref() {
            peer_book.extend(load_peers_from_file(path)?)?;
        }

        peer_book.persist()?;
        Ok(peer_book)
    }

    fn add(&self, peer: String) -> Result<bool, String> {
        let Some(peer) = normalize_peer_address(&peer) else {
            return Err(format!("invalid peer address: {peer}"));
        };

        if peer_book_is_local(&self.local_addr, &peer) {
            return Ok(false);
        }

        let added = {
            let mut peers = self
                .peers
                .lock()
                .map_err(|_| "peer list lock was poisoned".to_string())?;
            if peers.iter().any(|existing| existing == &peer) {
                false
            } else {
                peers.push(peer);
                peers.sort();
                true
            }
        };

        if added {
            self.persist()?;
        }

        Ok(added)
    }

    fn extend(&self, peers: Vec<String>) -> Result<(), String> {
        for peer in peers {
            self.add(peer)?;
        }
        Ok(())
    }

    fn snapshot(&self) -> Vec<String> {
        self.peers
            .lock()
            .map(|peers| peers.clone())
            .unwrap_or_else(|_| Vec::new())
    }

    fn persist(&self) -> Result<(), String> {
        let Some(path) = self.peers_file.as_deref() else {
            return Ok(());
        };

        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create peer file directory: {error}"))?;
            }
        }

        let peers = self
            .peers
            .lock()
            .map_err(|_| "peer list lock was poisoned".to_string())?;
        let contents = if peers.is_empty() {
            String::new()
        } else {
            format!("{}\n", peers.join("\n"))
        };
        fs::write(path, contents).map_err(|error| format!("failed to save peer file: {error}"))
    }
}

struct Node {
    blockchain: Arc<Mutex<Blockchain>>,
    mempool: Arc<Mutex<Vec<Transaction>>>,
    peers: PeerBook,
    chain_path: String,
    mempool_path: String,
    advertised_addr: Option<String>,
}

impl Node {
    fn new(config: NodeConfig) -> Result<Self, String> {
        let peers = PeerBook::new(
            config.peers,
            config.peers_file,
            config.advertised_addr.clone(),
        )?;

        Ok(Node {
            blockchain: Arc::new(Mutex::new(Blockchain::load(&config.chain_path)?)),
            mempool: Arc::new(Mutex::new(load_mempool(&config.mempool_path)?)),
            peers,
            chain_path: config.chain_path,
            mempool_path: config.mempool_path,
            advertised_addr: config.advertised_addr,
        })
    }

    fn start_listener(&self, listen_addr: String) {
        let blockchain = Arc::clone(&self.blockchain);
        let mempool = Arc::clone(&self.mempool);
        let peers = self.peers.clone();
        let chain_path = self.chain_path.clone();
        let mempool_path = self.mempool_path.clone();

        thread::spawn(move || {
            let listener =
                TcpListener::bind(&listen_addr).expect("node should bind to listen address");
            println!("Listening for blocks on {listen_addr}");

            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let blockchain = Arc::clone(&blockchain);
                        let mempool = Arc::clone(&mempool);
                        let peers = peers.clone();
                        let chain_path = chain_path.clone();
                        let mempool_path = mempool_path.clone();
                        thread::spawn(move || {
                            handle_peer_stream(
                                stream,
                                blockchain,
                                mempool,
                                peers,
                                chain_path,
                                mempool_path,
                            )
                        });
                    }
                    Err(error) => eprintln!("Failed to accept peer connection: {error}"),
                }
            }
        });
    }

    fn submit_transaction(&self, transaction: Transaction) -> Result<(), String> {
        add_transaction_to_mempool(&self.blockchain, &self.mempool, transaction.clone())?;
        save_mempool(&self.mempool, &self.mempool_path)?;
        self.broadcast_transaction(&transaction);
        Ok(())
    }

    fn mine_pending_transactions(&self, miner_reward_recipient: String) -> Result<(), String> {
        let transactions = {
            let mempool = self
                .mempool
                .lock()
                .map_err(|_| "mempool lock was poisoned".to_string())?;
            mempool.clone()
        };

        let block = {
            let blockchain = self
                .blockchain
                .lock()
                .map_err(|_| "blockchain lock was poisoned".to_string())?;
            build_candidate_block(&blockchain, transactions, miner_reward_recipient)?
        };

        let accepted = {
            let mut blockchain = self
                .blockchain
                .lock()
                .map_err(|_| "blockchain lock was poisoned".to_string())?;
            blockchain.add_received_block(block.clone())?;
            save_blockchain(&blockchain, &self.chain_path)?;
            true
        };

        if accepted {
            remove_block_transactions_from_mempool(&self.mempool, &block)?;
            save_mempool(&self.mempool, &self.mempool_path)?;
            self.broadcast_block(&block);
        }

        Ok(())
    }

    fn pending_transaction_count(&self) -> usize {
        self.mempool
            .lock()
            .map(|mempool| mempool.len())
            .unwrap_or(0)
    }

    fn broadcast_block(&self, block: &Block) {
        broadcast_block_to_peers(block, &self.peers);
    }

    fn broadcast_transaction(&self, transaction: &Transaction) {
        broadcast_transaction_to_peers(transaction, &self.peers);
    }

    fn announce_self(&self) {
        let Some(advertised_addr) = self.advertised_addr.as_deref() else {
            return;
        };

        broadcast_peer_to_peers(advertised_addr, &self.peers);
    }

    fn sync_chain_from_peers(&self) {
        for peer in self.peers.snapshot() {
            match request_chain_from_peer(&peer) {
                Ok(candidate) => {
                    let result = self
                        .blockchain
                        .lock()
                        .map_err(|_| "blockchain lock was poisoned".to_string())
                        .and_then(|mut blockchain| {
                            let replaced = blockchain.replace_with_better_chain(candidate)?;
                            if replaced {
                                save_blockchain(&blockchain, &self.chain_path)?;
                            }
                            Ok(replaced)
                        });

                    match result {
                        Ok(true) => println!("Synced a better chain from {peer}"),
                        Ok(false) => println!("Local chain is already at least as good as {peer}"),
                        Err(error) => eprintln!("Could not sync chain from {peer}: {error}"),
                    }
                }
                Err(error) => eprintln!("Could not request chain from {peer}: {error}"),
            }
        }
    }

    fn print_chain(&self) {
        let Ok(blockchain) = self.blockchain.lock() else {
            eprintln!("Could not read blockchain");
            return;
        };

        println!("\nBlockchain:");
        for block in &blockchain.chain {
            println!("{block:#?}");
        }
        if let Ok(mempool) = self.mempool.lock() {
            println!("\nPending transactions: {}", mempool.len());
        }
        println!(
            "\nCirculating supply: {} / {} XYQON",
            blockchain.current_supply(),
            MAX_COIN_SUPPLY
        );
        println!("\nIs blockchain valid? {}", blockchain.is_valid());
    }
}

fn handle_peer_stream(
    stream: TcpStream,
    blockchain: Arc<Mutex<Blockchain>>,
    mempool: Arc<Mutex<Vec<Transaction>>>,
    peers: PeerBook,
    chain_path: String,
    mempool_path: String,
) {
    let mut reader = BufReader::new(stream);

    loop {
        let mut line = String::new();
        let Ok(bytes_read) = reader.read_line(&mut line) else {
            eprintln!("Failed to read message from peer");
            continue;
        };

        if bytes_read == 0 {
            break;
        }

        let Ok(message) = serde_json::from_str::<NetworkMessage>(&line) else {
            eprintln!("Received invalid network message");
            continue;
        };

        match message {
            NetworkMessage::NewBlock(block) => {
                let block_index = block.index;
                let result = blockchain
                    .lock()
                    .map_err(|_| "blockchain lock was poisoned".to_string())
                    .and_then(|mut blockchain| {
                        blockchain.add_received_block(block)?;
                        save_blockchain(&blockchain, &chain_path)?;
                        Ok(())
                    });

                match result {
                    Ok(()) => {
                        println!("Accepted block {block_index} from peer");
                        if let Ok(blockchain) = blockchain.lock() {
                            let block = blockchain.latest_block().clone();
                            drop(blockchain);
                            if let Err(error) =
                                remove_block_transactions_from_mempool(&mempool, &block)
                            {
                                eprintln!("Could not clean mempool after block: {error}");
                            } else if let Err(error) = save_mempool(&mempool, &mempool_path) {
                                eprintln!("Could not save mempool after block: {error}");
                            }
                            broadcast_block_to_peers(&block, &peers);
                        }
                    }
                    Err(error) => eprintln!("Rejected block {block_index}: {error}"),
                }
            }
            NetworkMessage::NewTransaction(transaction) => {
                let transaction_id = transaction.id();
                match add_transaction_to_mempool(&blockchain, &mempool, transaction.clone()) {
                    Ok(()) => {
                        println!("Accepted transaction {transaction_id} into mempool");
                        if let Err(error) = save_mempool(&mempool, &mempool_path) {
                            eprintln!("Could not save mempool: {error}");
                        }
                        broadcast_transaction_to_peers(&transaction, &peers);
                    }
                    Err(error) => eprintln!("Rejected transaction {transaction_id}: {error}"),
                }
            }
            NetworkMessage::NewPeer(peer) => match peers.add(peer.clone()) {
                Ok(true) => {
                    println!("Discovered peer {peer}");
                    broadcast_peer_to_peers(&peer, &peers);
                }
                Ok(false) => println!("Already know peer {peer}"),
                Err(error) => eprintln!("Rejected peer announcement {peer}: {error}"),
            },
            NetworkMessage::RequestChain => {
                let response = blockchain
                    .lock()
                    .map(|blockchain| NetworkMessage::ChainResponse(blockchain.clone()));

                match response {
                    Ok(response) => match serde_json::to_string(&response) {
                        Ok(serialized) => {
                            if let Err(error) = writeln!(reader.get_mut(), "{serialized}") {
                                eprintln!("Failed to send chain response: {error}");
                            }
                        }
                        Err(error) => eprintln!("Failed to serialize chain response: {error}"),
                    },
                    Err(_) => eprintln!("Could not read chain for sync response"),
                }
            }
            NetworkMessage::RequestPeers => {
                let response = NetworkMessage::PeerResponse(peers.snapshot());
                match serde_json::to_string(&response) {
                    Ok(serialized) => {
                        if let Err(error) = writeln!(reader.get_mut(), "{serialized}") {
                            eprintln!("Failed to send peer response: {error}");
                        }
                    }
                    Err(error) => eprintln!("Failed to serialize peer response: {error}"),
                }
            }
            NetworkMessage::ChainResponse(_) => {
                eprintln!("Unexpected chain response on listener connection");
            }
            NetworkMessage::PeerResponse(_) => {
                eprintln!("Unexpected peer response on listener connection");
            }
        }
    }
}

#[derive(Debug)]
enum Command {
    Node(NodeConfig),
    Submit(SubmitConfig),
    CoinCreate(CoinCreateConfig),
    CoinTransfer(CoinTransferConfig),
    NftMint(NftMintConfig),
    NftTransfer(NftTransferConfig),
    Mine(MineConfig),
    WalletNew(WalletNewConfig),
    WalletExport(WalletExportConfig),
    WalletBalance(WalletBalanceConfig),
    Help,
}

#[derive(Debug)]
struct NodeConfig {
    listen_addr: Option<String>,
    peers: Vec<String>,
    peers_file: Option<String>,
    chain_path: String,
    mempool_path: String,
    advertised_addr: Option<String>,
}

#[derive(Debug)]
struct SubmitConfig {
    peers: Vec<String>,
    peers_file: Option<String>,
    wallet_path: String,
    chain_path: String,
    mempool_path: String,
    recipient: String,
    amount: f64,
}

#[derive(Debug)]
struct CoinCreateConfig {
    peers: Vec<String>,
    peers_file: Option<String>,
    wallet_path: String,
    chain_path: String,
    mempool_path: String,
    symbol: String,
    name: String,
    supply: f64,
}

#[derive(Debug)]
struct CoinTransferConfig {
    peers: Vec<String>,
    peers_file: Option<String>,
    wallet_path: String,
    chain_path: String,
    mempool_path: String,
    symbol: String,
    recipient: String,
    amount: f64,
}

#[derive(Debug)]
struct NftMintConfig {
    peers: Vec<String>,
    peers_file: Option<String>,
    wallet_path: String,
    chain_path: String,
    mempool_path: String,
    collection: String,
    token_id: String,
    name: String,
    image_url: Option<String>,
}

#[derive(Debug)]
struct NftTransferConfig {
    peers: Vec<String>,
    peers_file: Option<String>,
    wallet_path: String,
    chain_path: String,
    mempool_path: String,
    collection: String,
    token_id: String,
    recipient: String,
}

#[derive(Debug)]
struct MineConfig {
    listen_addr: Option<String>,
    peers: Vec<String>,
    peers_file: Option<String>,
    wallet_path: String,
    chain_path: String,
    mempool_path: String,
    advertised_addr: Option<String>,
    interval_seconds: u64,
    mine_empty_blocks: bool,
}

#[derive(Debug)]
struct WalletNewConfig {
    name: String,
    output_path: String,
}

#[derive(Debug)]
struct WalletExportConfig {
    wallet_path: String,
    show_private: bool,
}

#[derive(Debug)]
struct WalletBalanceConfig {
    wallet_path: String,
    chain_path: String,
}

impl Command {
    fn from_args() -> Result<Self, String> {
        let mut args: Vec<String> = env::args().skip(1).collect();
        if args.is_empty() {
            return Ok(Command::Help);
        }

        let command = args.remove(0);
        match command.as_str() {
            "node" => NodeConfig::from_args(args).map(Command::Node),
            "submit" => SubmitConfig::from_args(args).map(Command::Submit),
            "coin" => parse_coin_command(args),
            "nft" => parse_nft_command(args),
            "mine" => MineConfig::from_args(args).map(Command::Mine),
            "wallet" => parse_wallet_command(args),
            "help" | "--help" | "-h" => Ok(Command::Help),
            _ => Err(format!("unknown command: {command}")),
        }
    }
}

impl NodeConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut listen_addr = None;
        let mut peers = Vec::new();
        let mut peers_file = None;
        let mut chain_path = "xyqon-chain.json".to_string();
        let mut mempool_path = None;
        let mut advertised_addr = None;
        let mut args = args.into_iter();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--listen" => listen_addr = args.next(),
                "--peer" => {
                    if let Some(peer) = args.next() {
                        peers.push(peer);
                    }
                }
                "--peers-file" => {
                    peers_file = Some(
                        args.next()
                            .ok_or_else(|| "--peers-file requires a file path".to_string())?,
                    );
                }
                "--advertise" => {
                    advertised_addr = Some(
                        args.next()
                            .ok_or_else(|| "--advertise requires an address".to_string())?,
                    );
                }
                "--chain" => {
                    chain_path = args
                        .next()
                        .ok_or_else(|| "--chain requires a file path".to_string())?;
                }
                "--mempool" => {
                    mempool_path = Some(
                        args.next()
                            .ok_or_else(|| "--mempool requires a file path".to_string())?,
                    );
                }
                _ => return Err(format!("unknown node option: {arg}")),
            }
        }

        let mempool_path = mempool_path.unwrap_or_else(|| default_mempool_path(&chain_path));
        Ok(NodeConfig {
            listen_addr,
            peers,
            peers_file,
            chain_path,
            mempool_path,
            advertised_addr,
        })
    }
}

impl SubmitConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut peers = Vec::new();
        let mut peers_file = None;
        let mut wallet_path = None;
        let mut chain_path = "xyqon-chain.json".to_string();
        let mut mempool_path = None;
        let mut recipient = None;
        let mut amount = None;
        let mut args = args.into_iter();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--peer" => {
                    if let Some(peer) = args.next() {
                        peers.push(peer);
                    }
                }
                "--peers-file" => {
                    peers_file = Some(
                        args.next()
                            .ok_or_else(|| "--peers-file requires a file path".to_string())?,
                    );
                }
                "--wallet" => wallet_path = args.next(),
                "--chain" => {
                    chain_path = args
                        .next()
                        .ok_or_else(|| "--chain requires a file path".to_string())?;
                }
                "--mempool" => {
                    mempool_path = Some(
                        args.next()
                            .ok_or_else(|| "--mempool requires a file path".to_string())?,
                    );
                }
                "--to" => {
                    recipient = Some(
                        args.next()
                            .ok_or_else(|| "--to requires a recipient".to_string())?,
                    );
                }
                "--amount" => {
                    let value = args
                        .next()
                        .ok_or_else(|| "--amount requires a number".to_string())?;
                    amount = Some(
                        value
                            .parse::<f64>()
                            .map_err(|_| format!("invalid amount: {value}"))?,
                    );
                }
                _ => return Err(format!("unknown submit option: {arg}")),
            }
        }

        let mempool_path = mempool_path.unwrap_or_else(|| default_mempool_path(&chain_path));
        Ok(SubmitConfig {
            peers,
            peers_file,
            wallet_path: wallet_path
                .ok_or_else(|| "submit requires --wallet <FILE>".to_string())?,
            chain_path,
            mempool_path,
            recipient: recipient.ok_or_else(|| "submit requires --to <RECIPIENT>".to_string())?,
            amount: amount.ok_or_else(|| "submit requires --amount <AMOUNT>".to_string())?,
        })
    }
}

impl CoinCreateConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut peers = Vec::new();
        let mut peers_file = None;
        let mut wallet_path = None;
        let mut chain_path = "xyqon-chain.json".to_string();
        let mut mempool_path = None;
        let mut symbol = None;
        let mut name = None;
        let mut supply = None;
        let mut args = args.into_iter();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--peer" => {
                    if let Some(peer) = args.next() {
                        peers.push(peer);
                    }
                }
                "--peers-file" => {
                    peers_file = Some(
                        args.next()
                            .ok_or_else(|| "--peers-file requires a file path".to_string())?,
                    );
                }
                "--wallet" => wallet_path = args.next(),
                "--chain" => {
                    chain_path = args
                        .next()
                        .ok_or_else(|| "--chain requires a file path".to_string())?;
                }
                "--mempool" => {
                    mempool_path = Some(
                        args.next()
                            .ok_or_else(|| "--mempool requires a file path".to_string())?,
                    );
                }
                "--symbol" => {
                    symbol = Some(
                        args.next()
                            .ok_or_else(|| "--symbol requires a coin symbol".to_string())?,
                    );
                }
                "--name" => {
                    name = Some(
                        args.next()
                            .ok_or_else(|| "--name requires a coin name".to_string())?,
                    );
                }
                "--supply" => {
                    let value = args
                        .next()
                        .ok_or_else(|| "--supply requires a number".to_string())?;
                    supply = Some(
                        value
                            .parse::<f64>()
                            .map_err(|_| format!("invalid supply: {value}"))?,
                    );
                }
                _ => return Err(format!("unknown coin create option: {arg}")),
            }
        }

        let mempool_path = mempool_path.unwrap_or_else(|| default_mempool_path(&chain_path));
        Ok(CoinCreateConfig {
            peers,
            peers_file,
            wallet_path: wallet_path
                .ok_or_else(|| "coin create requires --wallet <FILE>".to_string())?,
            chain_path,
            mempool_path,
            symbol: symbol.ok_or_else(|| "coin create requires --symbol <SYMBOL>".to_string())?,
            name: name.ok_or_else(|| "coin create requires --name <NAME>".to_string())?,
            supply: supply.ok_or_else(|| "coin create requires --supply <AMOUNT>".to_string())?,
        })
    }
}

impl CoinTransferConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut peers = Vec::new();
        let mut peers_file = None;
        let mut wallet_path = None;
        let mut chain_path = "xyqon-chain.json".to_string();
        let mut mempool_path = None;
        let mut symbol = None;
        let mut recipient = None;
        let mut amount = None;
        let mut args = args.into_iter();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--peer" => {
                    if let Some(peer) = args.next() {
                        peers.push(peer);
                    }
                }
                "--peers-file" => {
                    peers_file = Some(
                        args.next()
                            .ok_or_else(|| "--peers-file requires a file path".to_string())?,
                    );
                }
                "--wallet" => wallet_path = args.next(),
                "--chain" => {
                    chain_path = args
                        .next()
                        .ok_or_else(|| "--chain requires a file path".to_string())?;
                }
                "--mempool" => {
                    mempool_path = Some(
                        args.next()
                            .ok_or_else(|| "--mempool requires a file path".to_string())?,
                    );
                }
                "--symbol" => {
                    symbol = Some(
                        args.next()
                            .ok_or_else(|| "--symbol requires a coin symbol".to_string())?,
                    );
                }
                "--to" => {
                    recipient = Some(
                        args.next()
                            .ok_or_else(|| "--to requires a recipient".to_string())?,
                    );
                }
                "--amount" => {
                    let value = args
                        .next()
                        .ok_or_else(|| "--amount requires a number".to_string())?;
                    amount = Some(
                        value
                            .parse::<f64>()
                            .map_err(|_| format!("invalid amount: {value}"))?,
                    );
                }
                _ => return Err(format!("unknown coin send option: {arg}")),
            }
        }

        let mempool_path = mempool_path.unwrap_or_else(|| default_mempool_path(&chain_path));
        Ok(CoinTransferConfig {
            peers,
            peers_file,
            wallet_path: wallet_path
                .ok_or_else(|| "coin send requires --wallet <FILE>".to_string())?,
            chain_path,
            mempool_path,
            symbol: symbol.ok_or_else(|| "coin send requires --symbol <SYMBOL>".to_string())?,
            recipient: recipient
                .ok_or_else(|| "coin send requires --to <RECIPIENT>".to_string())?,
            amount: amount.ok_or_else(|| "coin send requires --amount <AMOUNT>".to_string())?,
        })
    }
}

impl NftMintConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut peers = Vec::new();
        let mut peers_file = None;
        let mut wallet_path = None;
        let mut chain_path = "xyqon-chain.json".to_string();
        let mut mempool_path = None;
        let mut collection = None;
        let mut token_id = None;
        let mut name = None;
        let mut image_url = None;
        let mut args = args.into_iter();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--peer" => {
                    if let Some(peer) = args.next() {
                        peers.push(peer);
                    }
                }
                "--peers-file" => {
                    peers_file = Some(
                        args.next()
                            .ok_or_else(|| "--peers-file requires a file path".to_string())?,
                    );
                }
                "--wallet" => wallet_path = args.next(),
                "--chain" => {
                    chain_path = args
                        .next()
                        .ok_or_else(|| "--chain requires a file path".to_string())?;
                }
                "--mempool" => {
                    mempool_path = Some(
                        args.next()
                            .ok_or_else(|| "--mempool requires a file path".to_string())?,
                    );
                }
                "--collection" => {
                    collection =
                        Some(args.next().ok_or_else(|| {
                            "--collection requires a collection symbol".to_string()
                        })?);
                }
                "--token-id" => {
                    token_id = Some(
                        args.next()
                            .ok_or_else(|| "--token-id requires a token id".to_string())?,
                    );
                }
                "--name" => {
                    name = Some(
                        args.next()
                            .ok_or_else(|| "--name requires an NFT name".to_string())?,
                    );
                }
                "--image-url" => {
                    image_url = Some(
                        args.next()
                            .ok_or_else(|| "--image-url requires a URL".to_string())?,
                    );
                }
                _ => return Err(format!("unknown nft mint option: {arg}")),
            }
        }

        let mempool_path = mempool_path.unwrap_or_else(|| default_mempool_path(&chain_path));
        Ok(NftMintConfig {
            peers,
            peers_file,
            wallet_path: wallet_path
                .ok_or_else(|| "nft mint requires --wallet <FILE>".to_string())?,
            chain_path,
            mempool_path,
            collection: collection
                .ok_or_else(|| "nft mint requires --collection <SYMBOL>".to_string())?,
            token_id: token_id.ok_or_else(|| "nft mint requires --token-id <ID>".to_string())?,
            name: name.ok_or_else(|| "nft mint requires --name <NAME>".to_string())?,
            image_url,
        })
    }
}

impl NftTransferConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut peers = Vec::new();
        let mut peers_file = None;
        let mut wallet_path = None;
        let mut chain_path = "xyqon-chain.json".to_string();
        let mut mempool_path = None;
        let mut collection = None;
        let mut token_id = None;
        let mut recipient = None;
        let mut args = args.into_iter();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--peer" => {
                    if let Some(peer) = args.next() {
                        peers.push(peer);
                    }
                }
                "--peers-file" => {
                    peers_file = Some(
                        args.next()
                            .ok_or_else(|| "--peers-file requires a file path".to_string())?,
                    );
                }
                "--wallet" => wallet_path = args.next(),
                "--chain" => {
                    chain_path = args
                        .next()
                        .ok_or_else(|| "--chain requires a file path".to_string())?;
                }
                "--mempool" => {
                    mempool_path = Some(
                        args.next()
                            .ok_or_else(|| "--mempool requires a file path".to_string())?,
                    );
                }
                "--collection" => {
                    collection =
                        Some(args.next().ok_or_else(|| {
                            "--collection requires a collection symbol".to_string()
                        })?);
                }
                "--token-id" => {
                    token_id = Some(
                        args.next()
                            .ok_or_else(|| "--token-id requires a token id".to_string())?,
                    );
                }
                "--to" => {
                    recipient = Some(
                        args.next()
                            .ok_or_else(|| "--to requires a recipient".to_string())?,
                    );
                }
                _ => return Err(format!("unknown nft send option: {arg}")),
            }
        }

        let mempool_path = mempool_path.unwrap_or_else(|| default_mempool_path(&chain_path));
        Ok(NftTransferConfig {
            peers,
            peers_file,
            wallet_path: wallet_path
                .ok_or_else(|| "nft send requires --wallet <FILE>".to_string())?,
            chain_path,
            mempool_path,
            collection: collection
                .ok_or_else(|| "nft send requires --collection <SYMBOL>".to_string())?,
            token_id: token_id.ok_or_else(|| "nft send requires --token-id <ID>".to_string())?,
            recipient: recipient.ok_or_else(|| "nft send requires --to <RECIPIENT>".to_string())?,
        })
    }
}

impl MineConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut listen_addr = None;
        let mut peers = Vec::new();
        let mut peers_file = None;
        let mut wallet_path = None;
        let mut chain_path = "xyqon-chain.json".to_string();
        let mut mempool_path = None;
        let mut advertised_addr = None;
        let mut interval_seconds = 1;
        let mut mine_empty_blocks = false;
        let mut args = args.into_iter();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--listen" => listen_addr = args.next(),
                "--peer" => {
                    if let Some(peer) = args.next() {
                        peers.push(peer);
                    }
                }
                "--peers-file" => {
                    peers_file = Some(
                        args.next()
                            .ok_or_else(|| "--peers-file requires a file path".to_string())?,
                    );
                }
                "--advertise" => {
                    advertised_addr = Some(
                        args.next()
                            .ok_or_else(|| "--advertise requires an address".to_string())?,
                    );
                }
                "--wallet" => wallet_path = args.next(),
                "--chain" => {
                    chain_path = args
                        .next()
                        .ok_or_else(|| "--chain requires a file path".to_string())?;
                }
                "--mempool" => {
                    mempool_path = Some(
                        args.next()
                            .ok_or_else(|| "--mempool requires a file path".to_string())?,
                    );
                }
                "--interval" => {
                    let value = args
                        .next()
                        .ok_or_else(|| "--interval requires a number of seconds".to_string())?;
                    interval_seconds = value
                        .parse::<u64>()
                        .map_err(|_| format!("invalid interval: {value}"))?;
                }
                "--mine-empty" => mine_empty_blocks = true,
                _ => return Err(format!("unknown mine option: {arg}")),
            }
        }

        let mempool_path = mempool_path.unwrap_or_else(|| default_mempool_path(&chain_path));
        Ok(MineConfig {
            listen_addr,
            peers,
            peers_file,
            wallet_path: wallet_path.ok_or_else(|| "mine requires --wallet <FILE>".to_string())?,
            chain_path,
            mempool_path,
            advertised_addr,
            interval_seconds,
            mine_empty_blocks,
        })
    }
}

fn parse_wallet_command(mut args: Vec<String>) -> Result<Command, String> {
    if args.is_empty() {
        return Ok(Command::Help);
    }

    let command = args.remove(0);
    match command.as_str() {
        "new" => {
            let mut name = "unnamed".to_string();
            let mut output_path = "wallet.json".to_string();
            let mut args = args.into_iter();

            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--name" => {
                        name = args
                            .next()
                            .ok_or_else(|| "--name requires a wallet name".to_string())?;
                    }
                    "--out" => {
                        output_path = args
                            .next()
                            .ok_or_else(|| "--out requires a file path".to_string())?;
                    }
                    _ => return Err(format!("unknown wallet new option: {arg}")),
                }
            }

            Ok(Command::WalletNew(WalletNewConfig { name, output_path }))
        }
        "export" => {
            let mut wallet_path = None;
            let mut show_private = false;
            let mut args = args.into_iter();

            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--wallet" => wallet_path = args.next(),
                    "--show-private" => show_private = true,
                    _ => return Err(format!("unknown wallet export option: {arg}")),
                }
            }

            let wallet_path =
                wallet_path.ok_or_else(|| "wallet export requires --wallet <path>".to_string())?;
            Ok(Command::WalletExport(WalletExportConfig {
                wallet_path,
                show_private,
            }))
        }
        "balance" => {
            let mut wallet_path = None;
            let mut chain_path = "xyqon-chain.json".to_string();
            let mut args = args.into_iter();

            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--wallet" => wallet_path = args.next(),
                    "--chain" => {
                        chain_path = args
                            .next()
                            .ok_or_else(|| "--chain requires a file path".to_string())?;
                    }
                    _ => return Err(format!("unknown wallet balance option: {arg}")),
                }
            }

            let wallet_path =
                wallet_path.ok_or_else(|| "wallet balance requires --wallet <path>".to_string())?;
            Ok(Command::WalletBalance(WalletBalanceConfig {
                wallet_path,
                chain_path,
            }))
        }
        _ => Err(format!("unknown wallet command: {command}")),
    }
}

fn parse_coin_command(mut args: Vec<String>) -> Result<Command, String> {
    if args.is_empty() {
        return Ok(Command::Help);
    }

    let command = args.remove(0);
    match command.as_str() {
        "create" => CoinCreateConfig::from_args(args).map(Command::CoinCreate),
        "send" => CoinTransferConfig::from_args(args).map(Command::CoinTransfer),
        _ => Err(format!("unknown coin command: {command}")),
    }
}

fn parse_nft_command(mut args: Vec<String>) -> Result<Command, String> {
    if args.is_empty() {
        return Ok(Command::Help);
    }

    let command = args.remove(0);
    match command.as_str() {
        "mint" => NftMintConfig::from_args(args).map(Command::NftMint),
        "send" => NftTransferConfig::from_args(args).map(Command::NftTransfer),
        _ => Err(format!("unknown nft command: {command}")),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        print_help();
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    match Command::from_args()? {
        Command::Node(config) => run_node(config),
        Command::Submit(config) => submit_transaction(config),
        Command::CoinCreate(config) => create_coin(config),
        Command::CoinTransfer(config) => transfer_coin(config),
        Command::NftMint(config) => mint_nft(config),
        Command::NftTransfer(config) => transfer_nft(config),
        Command::Mine(config) => run_miner(config),
        Command::WalletNew(config) => create_wallet(config),
        Command::WalletExport(config) => export_wallet(config),
        Command::WalletBalance(config) => show_wallet_balance(config),
        Command::Help => {
            print_help();
            Ok(())
        }
    }
}

fn run_node(config: NodeConfig) -> Result<(), String> {
    let listen_addr = config.listen_addr.clone();
    let has_listener = listen_addr.is_some();
    let should_stay_alive = has_listener || !config.peers.is_empty() || config.peers_file.is_some();
    let node = Node::new(config)?;

    if let Some(listen_addr) = listen_addr {
        node.start_listener(listen_addr);
    }

    node.sync_chain_from_peers();
    node.announce_self();

    node.print_chain();

    if should_stay_alive {
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }

    Ok(())
}

fn submit_transaction(config: SubmitConfig) -> Result<(), String> {
    let wallet = WalletFile::load(&config.wallet_path)?;
    let signing_key = wallet.signing_key()?;
    let node = Node::new(NodeConfig {
        listen_addr: None,
        peers: config.peers,
        peers_file: config.peers_file,
        chain_path: config.chain_path,
        mempool_path: config.mempool_path,
        advertised_addr: None,
    })?;

    node.sync_chain_from_peers();
    node.submit_transaction(Transaction::new(
        &wallet.name,
        &config.recipient,
        config.amount,
        &signing_key,
    ))?;
    println!(
        "Submitted transaction from {} to {} for {} XYQON",
        wallet.public_key, config.recipient, config.amount
    );
    Ok(())
}

fn create_coin(config: CoinCreateConfig) -> Result<(), String> {
    let wallet = WalletFile::load(&config.wallet_path)?;
    let signing_key = wallet.signing_key()?;
    let node = Node::new(NodeConfig {
        listen_addr: None,
        peers: config.peers,
        peers_file: config.peers_file,
        chain_path: config.chain_path,
        mempool_path: config.mempool_path,
        advertised_addr: None,
    })?;

    let transaction = Transaction::create_coin(
        &wallet.name,
        config.symbol.clone(),
        config.name.clone(),
        config.supply,
        &signing_key,
    )?;
    node.sync_chain_from_peers();
    node.submit_transaction(transaction)?;
    println!(
        "Submitted 0 XYQON coin creation for {} ({}) from {}. The creator receives {} {} when it is mined.",
        config.name,
        config.symbol.to_ascii_uppercase(),
        wallet.public_key,
        config.supply,
        config.symbol.to_ascii_uppercase()
    );
    Ok(())
}

fn transfer_coin(config: CoinTransferConfig) -> Result<(), String> {
    let wallet = WalletFile::load(&config.wallet_path)?;
    let signing_key = wallet.signing_key()?;
    let node = Node::new(NodeConfig {
        listen_addr: None,
        peers: config.peers,
        peers_file: config.peers_file,
        chain_path: config.chain_path,
        mempool_path: config.mempool_path,
        advertised_addr: None,
    })?;

    let transaction = Transaction::transfer_coin(
        &wallet.name,
        config.recipient.clone(),
        config.symbol.clone(),
        config.amount,
        &signing_key,
    )?;
    node.sync_chain_from_peers();
    node.submit_transaction(transaction)?;
    println!(
        "Submitted 0 XYQON transfer of {} {} from {} to {}",
        config.amount,
        config.symbol.to_ascii_uppercase(),
        wallet.public_key,
        config.recipient
    );
    Ok(())
}

fn mint_nft(config: NftMintConfig) -> Result<(), String> {
    let wallet = WalletFile::load(&config.wallet_path)?;
    let signing_key = wallet.signing_key()?;
    let node = Node::new(NodeConfig {
        listen_addr: None,
        peers: config.peers,
        peers_file: config.peers_file,
        chain_path: config.chain_path,
        mempool_path: config.mempool_path,
        advertised_addr: None,
    })?;

    let transaction = Transaction::mint_nft(
        &wallet.name,
        config.collection.clone(),
        config.token_id.clone(),
        config.name.clone(),
        config.image_url.clone(),
        &signing_key,
    )?;
    node.sync_chain_from_peers();
    node.submit_transaction(transaction)?;
    println!(
        "Submitted 0 XYQON NFT mint for {}:{} from {}",
        config.collection.to_ascii_uppercase(),
        config.token_id,
        wallet.public_key
    );
    Ok(())
}

fn transfer_nft(config: NftTransferConfig) -> Result<(), String> {
    let wallet = WalletFile::load(&config.wallet_path)?;
    let signing_key = wallet.signing_key()?;
    let node = Node::new(NodeConfig {
        listen_addr: None,
        peers: config.peers,
        peers_file: config.peers_file,
        chain_path: config.chain_path,
        mempool_path: config.mempool_path,
        advertised_addr: None,
    })?;

    let transaction = Transaction::transfer_nft(
        &wallet.name,
        config.recipient.clone(),
        config.collection.clone(),
        config.token_id.clone(),
        &signing_key,
    )?;
    node.sync_chain_from_peers();
    node.submit_transaction(transaction)?;
    println!(
        "Submitted 0 XYQON NFT transfer of {}:{} from {} to {}",
        config.collection.to_ascii_uppercase(),
        config.token_id,
        wallet.public_key,
        config.recipient
    );
    Ok(())
}

fn run_miner(config: MineConfig) -> Result<(), String> {
    let listen_addr = config.listen_addr.clone();
    let wallet = WalletFile::load(&config.wallet_path)?;
    let node = Node::new(NodeConfig {
        listen_addr: config.listen_addr,
        peers: config.peers,
        peers_file: config.peers_file,
        chain_path: config.chain_path,
        mempool_path: config.mempool_path,
        advertised_addr: config.advertised_addr,
    })?;

    if let Some(listen_addr) = listen_addr {
        node.start_listener(listen_addr);
    }

    node.sync_chain_from_peers();
    node.announce_self();
    println!("Mining rewards will be paid to {}", wallet.public_key);

    loop {
        node.sync_chain_from_peers();
        if !config.mine_empty_blocks && node.pending_transaction_count() == 0 {
            println!("No pending transactions; waiting for work");
            thread::sleep(Duration::from_secs(config.interval_seconds.max(1)));
            continue;
        }

        match node.mine_pending_transactions(wallet.public_key.clone()) {
            Ok(()) => node.print_chain(),
            Err(error) => eprintln!("Mining attempt failed: {error}"),
        }

        if config.interval_seconds > 0 {
            thread::sleep(Duration::from_secs(config.interval_seconds));
        }
    }
}

fn create_wallet(config: WalletNewConfig) -> Result<(), String> {
    if Path::new(&config.output_path).exists() {
        return Err(format!(
            "wallet file already exists: {}",
            config.output_path
        ));
    }

    let wallet = WalletFile::generate(config.name);
    wallet.save(&config.output_path)?;
    println!("Created wallet: {}", config.output_path);
    println!("Public key: {}", wallet.public_key);
    Ok(())
}

fn export_wallet(config: WalletExportConfig) -> Result<(), String> {
    let wallet = WalletFile::load(&config.wallet_path)?;

    println!("Wallet: {}", wallet.name);
    println!("Public key: {}", wallet.public_key);
    if config.show_private {
        println!("Private key: {}", wallet.private_key);
    } else {
        println!("Private key: hidden; pass --show-private to display it");
    }

    Ok(())
}

fn show_wallet_balance(config: WalletBalanceConfig) -> Result<(), String> {
    let wallet = WalletFile::load(&config.wallet_path)?;
    let blockchain = Blockchain::load(&config.chain_path)?;
    let balance = blockchain.wallet_balance(&wallet);

    println!("Wallet: {}", wallet.name);
    println!("Public key: {}", wallet.public_key);
    println!("Chain: {}", config.chain_path);
    println!("Balance: {balance} XYQON");
    println!(
        "Circulating supply: {} / {} XYQON",
        blockchain.current_supply(),
        MAX_COIN_SUPPLY
    );

    Ok(())
}

fn broadcast_block_to_peers(block: &Block, peers: &PeerBook) {
    let message = NetworkMessage::NewBlock(block.clone());
    send_message_to_peers(&message, peers, "block", &block.index.to_string());
}

fn save_blockchain(blockchain: &Blockchain, path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create chain directory: {error}"))?;
        }
    }

    let contents = serde_json::to_string_pretty(blockchain)
        .map_err(|error| format!("failed to serialize chain: {error}"))?;
    fs::write(path, contents).map_err(|error| format!("failed to save chain: {error}"))
}

fn load_mempool(path: &str) -> Result<Vec<Transaction>, String> {
    if !Path::new(path).exists() {
        return Ok(Vec::new());
    }

    let contents =
        fs::read_to_string(path).map_err(|error| format!("failed to read mempool: {error}"))?;
    serde_json::from_str(&contents).map_err(|error| format!("failed to parse mempool: {error}"))
}

fn save_mempool(mempool: &Arc<Mutex<Vec<Transaction>>>, path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create mempool directory: {error}"))?;
        }
    }

    let mempool = mempool
        .lock()
        .map_err(|_| "mempool lock was poisoned".to_string())?;
    let contents = serde_json::to_string_pretty(&*mempool)
        .map_err(|error| format!("failed to serialize mempool: {error}"))?;
    fs::write(path, contents).map_err(|error| format!("failed to save mempool: {error}"))
}

fn default_mempool_path(chain_path: &str) -> String {
    format!("{chain_path}.mempool.json")
}

fn broadcast_transaction_to_peers(transaction: &Transaction, peers: &PeerBook) {
    let message = NetworkMessage::NewTransaction(transaction.clone());
    send_message_to_peers(&message, peers, "transaction", &transaction.id());
}

fn broadcast_peer_to_peers(peer: &str, peers: &PeerBook) {
    let message = NetworkMessage::NewPeer(peer.to_string());
    send_message_to_peers(&message, peers, "peer", peer);
}

fn send_message_to_peers(message: &NetworkMessage, peers: &PeerBook, label: &str, id: &str) {
    let Ok(serialized) = serde_json::to_string(&message) else {
        eprintln!("Failed to serialize {label} for broadcast");
        return;
    };

    for peer in peers.snapshot() {
        match TcpStream::connect(&peer) {
            Ok(mut stream) => {
                if let Err(error) = writeln!(stream, "{serialized}") {
                    eprintln!("Failed to send {label} to {peer}: {error}");
                } else {
                    println!("Shared {label} {id} with {peer}");
                }
            }
            Err(error) => eprintln!("Could not connect to peer {peer}: {error}"),
        }
    }
}

fn load_peers_from_file(path: &str) -> Result<Vec<String>, String> {
    if !Path::new(path).exists() {
        return Ok(Vec::new());
    }

    let contents =
        fs::read_to_string(path).map_err(|error| format!("failed to read peer file: {error}"))?;

    let peers = contents
        .lines()
        .filter_map(normalize_peer_address)
        .collect();
    Ok(peers)
}

fn normalize_peer_address(address: &str) -> Option<String> {
    let address = address.split('#').next()?.trim();
    if address.is_empty() {
        return None;
    }

    if address.contains(':') {
        Some(address.to_string())
    } else {
        Some(format!("{address}:{DEFAULT_PEER_PORT}"))
    }
}

fn peer_book_is_local(local_addr: &Option<String>, peer: &str) -> bool {
    local_addr
        .as_deref()
        .map(|local_addr| local_addr == peer)
        .unwrap_or(false)
}

fn request_chain_from_peer(peer: &str) -> Result<Blockchain, String> {
    let mut stream =
        TcpStream::connect(peer).map_err(|error| format!("could not connect: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("could not set read timeout: {error}"))?;

    let request = serde_json::to_string(&NetworkMessage::RequestChain)
        .map_err(|error| format!("could not serialize chain request: {error}"))?;
    writeln!(stream, "{request}").map_err(|error| format!("could not send request: {error}"))?;

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|error| format!("could not read response: {error}"))?;

    match serde_json::from_str::<NetworkMessage>(&response)
        .map_err(|error| format!("could not parse response: {error}"))?
    {
        NetworkMessage::ChainResponse(mut blockchain) => {
            blockchain.recalculate_circulating_supply();
            if !blockchain.is_valid() {
                return Err("peer returned an invalid chain".to_string());
            }
            Ok(blockchain)
        }
        _ => Err("peer did not return a chain response".to_string()),
    }
}

fn add_transaction_to_mempool(
    blockchain: &Arc<Mutex<Blockchain>>,
    mempool: &Arc<Mutex<Vec<Transaction>>>,
    transaction: Transaction,
) -> Result<(), String> {
    if !transaction.is_valid_signed_transaction() {
        return Err("transaction signature is invalid".to_string());
    }

    let transaction_id = transaction.id();
    let mut mempool = mempool
        .lock()
        .map_err(|_| "mempool lock was poisoned".to_string())?;

    if mempool
        .iter()
        .any(|existing| existing.id() == transaction_id)
    {
        return Err("transaction is already in the mempool".to_string());
    }

    let blockchain = blockchain
        .lock()
        .map_err(|_| "blockchain lock was poisoned".to_string())?;
    if blockchain
        .confirmed_transaction_ids()
        .contains(&transaction_id)
    {
        return Err("transaction has already been confirmed".to_string());
    }

    let mut balances = WalletBalances::from_chain(&blockchain.chain);
    let mut assets = AssetLedger::from_chain(&blockchain.chain)?;
    for pending in mempool.iter() {
        balances.apply_signed_transaction(pending)?;
        assets.apply_transaction(pending)?;
    }
    balances.apply_signed_transaction(&transaction)?;
    assets.apply_transaction(&transaction)?;
    drop(blockchain);

    mempool.push(transaction);
    Ok(())
}

fn remove_block_transactions_from_mempool(
    mempool: &Arc<Mutex<Vec<Transaction>>>,
    block: &Block,
) -> Result<(), String> {
    let confirmed_ids: Vec<String> = block
        .transactions
        .iter()
        .skip(1)
        .map(Transaction::id)
        .collect();
    let mut mempool = mempool
        .lock()
        .map_err(|_| "mempool lock was poisoned".to_string())?;

    mempool.retain(|transaction| !confirmed_ids.contains(&transaction.id()));
    Ok(())
}

fn build_candidate_block(
    blockchain: &Blockchain,
    mut transactions: Vec<Transaction>,
    miner_reward_recipient: String,
) -> Result<Block, String> {
    if miner_reward_recipient.is_empty() {
        return Err("miner reward recipient cannot be empty".to_string());
    }

    if !transactions
        .iter()
        .all(Transaction::is_valid_signed_transaction)
    {
        return Err("block contains an invalid transaction signature".to_string());
    }

    blockchain.validate_spending(&transactions)?;

    let reward = blockchain.allowed_reward_for_next_block();
    if reward <= 0.0 {
        return Err(format!(
            "max supply of {MAX_COIN_SUPPLY} XYQON has already been reached"
        ));
    }

    transactions.insert(0, Transaction::coinbase(&miner_reward_recipient, reward));

    let prev = blockchain.latest_block();
    let timestamp = Utc::now().timestamp();
    let difficulty = expected_difficulty_for_next_block(&blockchain.chain, timestamp);
    Ok(Block::new(
        prev.index + 1,
        timestamp,
        difficulty,
        transactions,
        prev.hash.clone(),
    ))
}

fn mining_reward_for_block(block_index: u64) -> f64 {
    if block_index == 0 {
        return 0.0;
    }

    let halvings = (block_index - 1) / HALVING_INTERVAL;
    INITIAL_MINING_REWARD / 2_f64.powi(halvings as i32)
}

fn allowed_mining_reward_for_block(block_index: u64, current_supply: f64) -> f64 {
    let scheduled_reward = mining_reward_for_block(block_index);
    let remaining_supply = (MAX_COIN_SUPPLY - current_supply).max(0.0);
    scheduled_reward.min(remaining_supply)
}

fn expected_difficulty_for_next_block(chain: &[Block], next_timestamp: i64) -> usize {
    let previous = chain.last().expect("chain should contain a genesis block");
    let next_index = previous.index + 1;
    if next_index < ROLLING_DIFFICULTY_START_BLOCK {
        return legacy_expected_difficulty_for_next_block(previous, next_timestamp);
    }

    let non_genesis_blocks = chain.len().saturating_sub(1);
    if non_genesis_blocks < 2 {
        return previous.difficulty;
    }

    let window_size = non_genesis_blocks.min(DIFFICULTY_WINDOW_BLOCKS);
    let first_index = chain.len() - window_size;
    let first = &chain[first_index];
    let elapsed_seconds = (next_timestamp - first.timestamp).max(1);
    let expected_seconds = TARGET_BLOCK_TIME_SECONDS * window_size as i64;

    if elapsed_seconds < expected_seconds {
        previous.difficulty + 1
    } else if elapsed_seconds > expected_seconds {
        previous.difficulty.saturating_sub(1).max(MIN_DIFFICULTY)
    } else {
        previous.difficulty
    }
}

fn legacy_expected_difficulty_for_next_block(previous: &Block, next_timestamp: i64) -> usize {
    if previous.index == 0 {
        return INITIAL_DIFFICULTY;
    }

    let elapsed_seconds = next_timestamp - previous.timestamp;
    if elapsed_seconds < LEGACY_TARGET_BLOCK_TIME_SECONDS {
        previous.difficulty + 1
    } else if elapsed_seconds > LEGACY_TARGET_BLOCK_TIME_SECONDS {
        previous.difficulty.saturating_sub(1).max(MIN_DIFFICULTY)
    } else {
        previous.difficulty
    }
}

fn amounts_equal(left: f64, right: f64) -> bool {
    (left - right).abs() < 0.000_000_01
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_to_array<const N: usize>(hex: &str) -> Option<[u8; N]> {
    if hex.len() != N * 2 {
        return None;
    }

    let mut bytes = [0_u8; N];
    for (index, chunk) in hex.as_bytes().chunks_exact(2).enumerate() {
        let part = std::str::from_utf8(chunk).ok()?;
        bytes[index] = u8::from_str_radix(part, 16).ok()?;
    }

    Some(bytes)
}

fn print_help() {
    println!(
        r#"xyqon

USAGE:
  xyqon node [OPTIONS]
  xyqon submit --wallet <FILE> --to <RECIPIENT> --amount <AMOUNT> [NETWORK OPTIONS]
  xyqon coin create --wallet <FILE> --symbol <SYMBOL> --name <NAME> --supply <AMOUNT> [NETWORK OPTIONS]
  xyqon coin send --wallet <FILE> --symbol <SYMBOL> --to <RECIPIENT> --amount <AMOUNT> [NETWORK OPTIONS]
  xyqon nft mint --wallet <FILE> --collection <SYMBOL> --token-id <ID> --name <NAME> [--image-url <URL>] [NETWORK OPTIONS]
  xyqon nft send --wallet <FILE> --collection <SYMBOL> --token-id <ID> --to <RECIPIENT> [NETWORK OPTIONS]
  xyqon mine --wallet <FILE> [NETWORK OPTIONS]
  xyqon wallet new --name <NAME> --out <FILE>
  xyqon wallet export --wallet <FILE> [--show-private]
  xyqon wallet balance --wallet <FILE> [--chain <FILE>]

NODE OPTIONS:
  --listen <ADDR>       Listen for peer blocks, for example 127.0.0.1:7101 or 0.0.0.0:7101 on Linux
  --peer <ADDR>         Add a peer to share accepted blocks with. Can be repeated
  --peers-file <FILE>   Load peers from a newline-separated file and save discovered peers back to it
  --advertise <ADDR>    Public address this node announces to peers, for example 68.183.98.134:7101
  --chain <FILE>        Existing live chain file. Defaults to xyqon-chain.json
  --mempool <FILE>      Persistent mempool file. Defaults to <chain>.mempool.json

SUBMIT OPTIONS:
  --wallet <FILE>       Wallet that signs the transaction
  --to <RECIPIENT>      Recipient public key
  --amount <AMOUNT>     Amount to transfer
  --peer <ADDR>         Peer to broadcast the transaction to. Can be repeated
  --peers-file <FILE>   Load peers from a newline-separated file
  --chain <FILE>        Existing live chain file. Defaults to xyqon-chain.json
  --mempool <FILE>      Persistent mempool file. Defaults to <chain>.mempool.json

COIN OPTIONS:
  coin create           Submit a free 0 XYQON transaction that defines a fixed-supply coin
  coin send             Submit a free 0 XYQON token transfer
  --wallet <FILE>       Wallet that signs the coin transaction
  --symbol <SYMBOL>     Unique coin symbol, 2 to 12 letters or numbers
  --name <NAME>         Coin display name, 1 to 64 characters
  --supply <AMOUNT>     Fixed coin supply minted once to the creator
  --to <RECIPIENT>      Recipient public key for coin send
  --amount <AMOUNT>     Coin amount for coin send
  --peer <ADDR>         Peer to broadcast the coin transaction to. Can be repeated
  --peers-file <FILE>   Load peers from a newline-separated file
  --chain <FILE>        Existing live chain file. Defaults to xyqon-chain.json
  --mempool <FILE>      Persistent mempool file. Defaults to <chain>.mempool.json

NFT OPTIONS:
  nft mint              Submit a free 0 XYQON transaction that mints a unique NFT
  nft send              Submit a free 0 XYQON NFT ownership transfer
  --wallet <FILE>       Wallet that signs the NFT transaction
  --collection <SYMBOL> NFT collection symbol, 2 to 12 letters or numbers
  --token-id <ID>       Unique NFT id inside the collection
  --name <NAME>         NFT display name, 1 to 64 characters
  --image-url <URL>     Optional external image URL for the NFT
  --to <RECIPIENT>      Recipient public key for nft send
  --peer <ADDR>         Peer to broadcast the NFT transaction to. Can be repeated
  --peers-file <FILE>   Load peers from a newline-separated file
  --chain <FILE>        Existing live chain file. Defaults to xyqon-chain.json
  --mempool <FILE>      Persistent mempool file. Defaults to <chain>.mempool.json

MINE OPTIONS:
  --wallet <FILE>       Wallet that receives mining rewards
  --listen <ADDR>       Listen for peer blocks and transactions while mining
  --peer <ADDR>         Peer to sync and broadcast with. Can be repeated
  --peers-file <FILE>   Load peers from a newline-separated file
  --advertise <ADDR>    Public address this miner announces to peers
  --chain <FILE>        Existing live chain file. Defaults to xyqon-chain.json
  --mempool <FILE>      Persistent mempool file. Defaults to <chain>.mempool.json
  --interval <SECONDS>  Delay between mining attempts. Defaults to 1
  --mine-empty          Allow mining coinbase-only blocks when there are no pending transactions

MINING:
  The node command only listens, syncs, validates, and relays.
  The submit command signs and broadcasts transactions without mining.
  The mine command runs a continuous mining loop for wallets that want to compete for rewards.
  Miners wait for pending transactions by default; pass --mine-empty to mine reward-only blocks.
  Each mined block receives one coinbase reward transaction.
  The initial reward is 10.0 XYQON and halves every 100,000 blocks.
  Difficulty adjusts dynamically to target one block every 30 seconds.
  When --wallet is used, the reward is paid to that wallet's public key.
  Total coin supply is capped at 67,000,000 XYQON.
  If remaining supply is less than the scheduled reward, only the remaining supply can be minted.

WALLET COMMANDS:
  wallet new            Create a new Ed25519 wallet file
  wallet export         Print wallet public key, and optionally private key
  wallet balance        Calculate wallet balance from the saved chain

BUILDING ON XYQON:
  Coin creation and coin sends are signed 0 XYQON transactions.
  The creator chooses the fixed supply when the coin is created.
  No later transaction can mint more units of that coin.
  NFT minting assigns ownership to the creator and may include an external image URL.
  NFT sends transfer ownership of an existing NFT.
  Miners receive the normal XYQON block reward for including asset transactions in a block.
"#
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn genesis_block() -> Block {
        Block::new(
            0,
            GENESIS_TIMESTAMP,
            INITIAL_DIFFICULTY,
            vec![Transaction::system("network", "genesis", 0.0)],
            "0".to_string(),
        )
    }

    fn blockchain_with_genesis() -> Blockchain {
        Blockchain {
            chain: vec![genesis_block()],
            circulating_supply: 0.0,
        }
    }

    #[test]
    fn mining_reward_halves_every_100_000_blocks() {
        assert_eq!(mining_reward_for_block(0), 0.0);
        assert_eq!(mining_reward_for_block(1), 10.0);
        assert_eq!(mining_reward_for_block(100_000), 10.0);
        assert_eq!(mining_reward_for_block(100_001), 5.0);
        assert_eq!(mining_reward_for_block(200_000), 5.0);
        assert_eq!(mining_reward_for_block(200_001), 2.5);
    }

    #[test]
    fn difficulty_adjusts_toward_30_second_blocks() {
        let mut previous = genesis_block();
        assert_eq!(
            expected_difficulty_for_next_block(&[previous.clone()], previous.timestamp + 5),
            INITIAL_DIFFICULTY
        );

        previous.index = 1;
        previous.difficulty = 4;
        assert_eq!(
            expected_difficulty_for_next_block(&[previous.clone()], previous.timestamp + 29),
            5
        );
        assert_eq!(
            expected_difficulty_for_next_block(&[previous.clone()], previous.timestamp + 30),
            4
        );
        assert_eq!(
            expected_difficulty_for_next_block(&[previous.clone()], previous.timestamp + 31),
            3
        );

        previous.difficulty = MIN_DIFFICULTY;
        assert_eq!(
            expected_difficulty_for_next_block(&[previous.clone()], previous.timestamp + 31),
            MIN_DIFFICULTY
        );
    }

    #[test]
    fn mining_reward_is_limited_by_remaining_supply() {
        assert_eq!(allowed_mining_reward_for_block(1, 0.0), 10.0);
        assert_eq!(
            allowed_mining_reward_for_block(1, MAX_COIN_SUPPLY - 3.0),
            3.0
        );
        assert_eq!(allowed_mining_reward_for_block(1, MAX_COIN_SUPPLY), 0.0);
    }

    #[test]
    fn chain_rejects_overspending_transactions() {
        let miner_key = SigningKey::from_bytes(&[7; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        blockchain
            .add_block(vec![], miner_public_key.clone())
            .expect("coinbase-only block should mine");

        let overspend = Transaction::new("miner", "receiver", 11.0, &miner_key);
        let result = blockchain.add_block(vec![overspend], miner_public_key);

        assert!(result.is_err());
    }

    #[test]
    fn chain_rejects_replayed_transactions() {
        let miner_key = SigningKey::from_bytes(&[7; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        blockchain
            .add_block(vec![], miner_public_key.clone())
            .expect("coinbase-only block should mine");

        let transaction = Transaction::new("miner", "receiver", 1.0, &miner_key);
        blockchain
            .add_block(vec![transaction.clone()], miner_public_key.clone())
            .expect("first transaction should be accepted");

        let result = blockchain.add_block(vec![transaction], miner_public_key);

        assert!(result.is_err());
    }

    #[test]
    fn mempool_rejects_confirmed_transactions() {
        let miner_key = SigningKey::from_bytes(&[7; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        blockchain
            .add_block(vec![], miner_public_key.clone())
            .expect("coinbase-only block should mine");

        let transaction = Transaction::new("miner", "receiver", 1.0, &miner_key);
        blockchain
            .add_block(vec![transaction.clone()], miner_public_key)
            .expect("first transaction should be accepted");

        let blockchain = Arc::new(Mutex::new(blockchain));
        let mempool = Arc::new(Mutex::new(Vec::new()));
        let result = add_transaction_to_mempool(&blockchain, &mempool, transaction);

        assert!(result.is_err());
    }

    #[test]
    fn coin_creation_uses_zero_xyqon_and_mints_initial_coin_supply() {
        let creator_key = SigningKey::from_bytes(&[9; 32]);
        let creator_public_key = bytes_to_hex(creator_key.verifying_key().as_bytes());
        let miner_key = SigningKey::from_bytes(&[8; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        let create_coin = Transaction::create_coin(
            "creator",
            "GAME".to_string(),
            "Game Coin".to_string(),
            1_000.0,
            &creator_key,
        )
        .expect("coin creation transaction should build");

        assert!(create_coin.is_valid_signed_transaction());
        assert!(amounts_equal(create_coin.amount, 0.0));

        blockchain
            .add_block(vec![create_coin], miner_public_key)
            .expect("coin creation should be accepted");

        let ledger = AssetLedger::from_chain(&blockchain.chain).expect("asset ledger should build");
        assert!(ledger.coin_exists("GAME"));
        assert!(amounts_equal(
            ledger.coin_balance("GAME", &creator_public_key),
            1_000.0
        ));
    }

    #[test]
    fn chain_rejects_duplicate_coin_symbols() {
        let creator_key = SigningKey::from_bytes(&[9; 32]);
        let miner_key = SigningKey::from_bytes(&[8; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        let first = Transaction::create_coin(
            "creator",
            "GAME".to_string(),
            "Game Coin".to_string(),
            1_000.0,
            &creator_key,
        )
        .expect("first coin creation transaction should build");
        let duplicate = Transaction::create_coin(
            "creator",
            "game".to_string(),
            "Another Game Coin".to_string(),
            500.0,
            &creator_key,
        )
        .expect("duplicate coin creation transaction should build");

        blockchain
            .add_block(vec![first], miner_public_key.clone())
            .expect("first coin creation should be accepted");

        let result = blockchain.add_block(vec![duplicate], miner_public_key);

        assert!(result.is_err());
    }

    #[test]
    fn coin_transfer_moves_existing_supply_without_spending_xyqon() {
        let creator_key = SigningKey::from_bytes(&[9; 32]);
        let creator_public_key = bytes_to_hex(creator_key.verifying_key().as_bytes());
        let recipient_key = SigningKey::from_bytes(&[10; 32]);
        let recipient_public_key = bytes_to_hex(recipient_key.verifying_key().as_bytes());
        let miner_key = SigningKey::from_bytes(&[8; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        let create_coin = Transaction::create_coin(
            "creator",
            "GAME".to_string(),
            "Game Coin".to_string(),
            1_000.0,
            &creator_key,
        )
        .expect("coin creation transaction should build");
        blockchain
            .add_block(vec![create_coin], miner_public_key.clone())
            .expect("coin creation should be accepted");

        let send_coin = Transaction::transfer_coin(
            "creator",
            recipient_public_key.clone(),
            "GAME".to_string(),
            25.0,
            &creator_key,
        )
        .expect("coin transfer transaction should build");

        assert!(send_coin.is_valid_signed_transaction());
        assert!(amounts_equal(send_coin.amount, 0.0));

        blockchain
            .add_block(vec![send_coin], miner_public_key)
            .expect("coin transfer should be accepted");

        let ledger = AssetLedger::from_chain(&blockchain.chain).expect("asset ledger should build");
        assert!(amounts_equal(
            ledger.coin_balance("GAME", &creator_public_key),
            975.0
        ));
        assert!(amounts_equal(
            ledger.coin_balance("GAME", &recipient_public_key),
            25.0
        ));
    }

    #[test]
    fn chain_rejects_coin_transfer_overspend() {
        let creator_key = SigningKey::from_bytes(&[9; 32]);
        let recipient_key = SigningKey::from_bytes(&[10; 32]);
        let recipient_public_key = bytes_to_hex(recipient_key.verifying_key().as_bytes());
        let miner_key = SigningKey::from_bytes(&[8; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        let create_coin = Transaction::create_coin(
            "creator",
            "GAME".to_string(),
            "Game Coin".to_string(),
            10.0,
            &creator_key,
        )
        .expect("coin creation transaction should build");
        blockchain
            .add_block(vec![create_coin], miner_public_key.clone())
            .expect("coin creation should be accepted");

        let overspend = Transaction::transfer_coin(
            "creator",
            recipient_public_key,
            "GAME".to_string(),
            11.0,
            &creator_key,
        )
        .expect("coin transfer transaction should build");

        let result = blockchain.add_block(vec![overspend], miner_public_key);

        assert!(result.is_err());
    }

    #[test]
    fn nft_mint_accepts_optional_image_url_and_assigns_creator_ownership() {
        let creator_key = SigningKey::from_bytes(&[9; 32]);
        let creator_public_key = bytes_to_hex(creator_key.verifying_key().as_bytes());
        let miner_key = SigningKey::from_bytes(&[8; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        let mint = Transaction::mint_nft(
            "creator",
            "ITEMS".to_string(),
            "sword-001".to_string(),
            "Iron Sword".to_string(),
            Some("https://example.com/iron-sword.png".to_string()),
            &creator_key,
        )
        .expect("NFT mint transaction should build");

        assert!(mint.is_valid_signed_transaction());
        assert!(amounts_equal(mint.amount, 0.0));

        blockchain
            .add_block(vec![mint], miner_public_key)
            .expect("NFT mint should be accepted");

        let ledger = AssetLedger::from_chain(&blockchain.chain).expect("asset ledger should build");
        assert_eq!(
            ledger.nft_owner("ITEMS", "sword-001"),
            Some(creator_public_key.as_str())
        );
    }

    #[test]
    fn chain_rejects_duplicate_nft_ids() {
        let creator_key = SigningKey::from_bytes(&[9; 32]);
        let miner_key = SigningKey::from_bytes(&[8; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        let first = Transaction::mint_nft(
            "creator",
            "ITEMS".to_string(),
            "sword-001".to_string(),
            "Iron Sword".to_string(),
            None,
            &creator_key,
        )
        .expect("first NFT mint transaction should build");
        let duplicate = Transaction::mint_nft(
            "creator",
            "items".to_string(),
            "sword-001".to_string(),
            "Another Sword".to_string(),
            Some("https://example.com/another-sword.png".to_string()),
            &creator_key,
        )
        .expect("duplicate NFT mint transaction should build");

        blockchain
            .add_block(vec![first], miner_public_key.clone())
            .expect("first NFT mint should be accepted");

        let result = blockchain.add_block(vec![duplicate], miner_public_key);

        assert!(result.is_err());
    }

    #[test]
    fn nft_transfer_moves_ownership_without_spending_xyqon() {
        let creator_key = SigningKey::from_bytes(&[9; 32]);
        let recipient_key = SigningKey::from_bytes(&[10; 32]);
        let recipient_public_key = bytes_to_hex(recipient_key.verifying_key().as_bytes());
        let miner_key = SigningKey::from_bytes(&[8; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        let mint = Transaction::mint_nft(
            "creator",
            "ITEMS".to_string(),
            "sword-001".to_string(),
            "Iron Sword".to_string(),
            Some("https://example.com/iron-sword.png".to_string()),
            &creator_key,
        )
        .expect("NFT mint transaction should build");
        blockchain
            .add_block(vec![mint], miner_public_key.clone())
            .expect("NFT mint should be accepted");

        let transfer = Transaction::transfer_nft(
            "creator",
            recipient_public_key.clone(),
            "ITEMS".to_string(),
            "sword-001".to_string(),
            &creator_key,
        )
        .expect("NFT transfer transaction should build");

        assert!(transfer.is_valid_signed_transaction());
        assert!(amounts_equal(transfer.amount, 0.0));

        blockchain
            .add_block(vec![transfer], miner_public_key)
            .expect("NFT transfer should be accepted");

        let ledger = AssetLedger::from_chain(&blockchain.chain).expect("asset ledger should build");
        assert_eq!(
            ledger.nft_owner("ITEMS", "sword-001"),
            Some(recipient_public_key.as_str())
        );
    }

    #[test]
    fn chain_rejects_nft_transfer_by_non_owner() {
        let creator_key = SigningKey::from_bytes(&[9; 32]);
        let non_owner_key = SigningKey::from_bytes(&[11; 32]);
        let recipient_key = SigningKey::from_bytes(&[10; 32]);
        let recipient_public_key = bytes_to_hex(recipient_key.verifying_key().as_bytes());
        let miner_key = SigningKey::from_bytes(&[8; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut blockchain = blockchain_with_genesis();

        let mint = Transaction::mint_nft(
            "creator",
            "ITEMS".to_string(),
            "sword-001".to_string(),
            "Iron Sword".to_string(),
            Some("https://example.com/iron-sword.png".to_string()),
            &creator_key,
        )
        .expect("NFT mint transaction should build");
        blockchain
            .add_block(vec![mint], miner_public_key.clone())
            .expect("NFT mint should be accepted");

        let transfer = Transaction::transfer_nft(
            "non-owner",
            recipient_public_key,
            "ITEMS".to_string(),
            "sword-001".to_string(),
            &non_owner_key,
        )
        .expect("NFT transfer transaction should build");

        let result = blockchain.add_block(vec![transfer], miner_public_key);

        assert!(result.is_err());
    }

    #[test]
    fn chain_replaces_itself_with_better_valid_chain() {
        let miner_key = SigningKey::from_bytes(&[8; 32]);
        let miner_public_key = bytes_to_hex(miner_key.verifying_key().as_bytes());
        let mut local = blockchain_with_genesis();
        let mut candidate = blockchain_with_genesis();

        candidate
            .add_block(vec![], miner_public_key)
            .expect("candidate should mine a better chain");

        assert!(local
            .replace_with_better_chain(candidate)
            .expect("valid better chain should be accepted"));
        assert_eq!(local.latest_block().index, 1);
        assert_eq!(local.current_supply(), 10.0);
    }
}
